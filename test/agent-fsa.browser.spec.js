import { test, expect, chromium } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const extension = new URL('../', import.meta.url).pathname;
const scratch = join(homedir(), '.hermes/cache/scratch');

async function withExtension(check) {
  await mkdir(scratch, { recursive: true });
  const profile = await mkdtemp(join(scratch, 'clockoli-agent-fsa-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/options/options.html`);
    await page.evaluate(async () => {
      const store = await import(chrome.runtime.getURL('src/storage/agent-activity-store.js'));
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('sessions', { create: true });
      const file = await directory.getFileHandle('session.jsonl', { create: true });
      const writable = await file.createWritable();
      await writable.write([
        { type: 'event_msg', timestamp: '2026-01-01T00:00:01Z', payload: { type: 'task_started', turn_id: 'turn' } },
        { type: 'event_msg', timestamp: '2026-01-01T00:00:03Z', payload: { type: 'task_complete', turn_id: 'turn' } },
      ].map(JSON.stringify).join('\n') + '\n');
      await writable.close();
      await store.setAgentRoot('codex', directory);
    });
    await page.reload();
    await worker.evaluate(() => {
      const original = FileSystemHandle.prototype.queryPermission;
      globalThis.__fsaOriginal = original;
      globalThis.__fsaMode = 'prompt';
      globalThis.__fsaCalls = 0;
      FileSystemHandle.prototype.queryPermission = function (...args) {
        globalThis.__fsaCalls++;
        if (globalThis.__fsaMode === 'hang') return new Promise(resolve => { globalThis.__fsaResolve = resolve; });
        if (globalThis.__fsaMode === 'granted') return original.apply(this, args);
        return Promise.resolve(globalThis.__fsaMode);
      };
    });
    await check({ context, worker, page });
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const scan = page => page.evaluate(() => chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_CONTROL', provider: 'codex', action: 'scan' }));
const status = page => page.evaluate(() => chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_STATUS' }));

test('worker respects prompt and denied; Settings restores access and scans without losing the root', async () => {
  await withExtension(async ({ worker, page }) => {
    const prompt = await scan(page);
    expect(prompt.data.providers.codex.permission).toBe('prompt');
    expect(prompt.data.providers.codex.errorCode).toBe('access_required');
    expect(prompt.data.coverage.codex.turns.discovered).toBe(0);
    await expect(page.locator('#agent-codex-restore')).toBeVisible();
    await worker.evaluate(() => { globalThis.__fsaMode = 'denied'; });
    const denied = await scan(page);
    expect(denied.data.providers.codex.permission).toBe('denied');
    expect(denied.data.providers.codex.errorCode).toBe('access_required');
    expect(denied.data.coverage.codex.turns.discovered).toBe(0);
    await worker.evaluate(() => { globalThis.__fsaMode = 'granted'; });
    await page.locator('#agent-codex-restore').click();
    await expect(page.locator('#agent-codex-status')).toHaveText('Connected');
    const recovered = await status(page);
    expect(recovered.data.providers.codex.permission).toBe('granted');
    expect(recovered.data.coverage.codex.turns.discovered).toBe(1);
    expect(recovered.data.coverage.codex.turns.measured).toBe(1);
    expect(await worker.evaluate(() => globalThis.__fsaCalls)).toBe(3);
  });
});

test('hung worker FSA call times out, coalesces concurrent scans, cools down alarms, and resumes after release', async () => {
  test.setTimeout(100_000);
  await withExtension(async ({ worker, page }) => {
    await worker.evaluate(() => { globalThis.__fsaMode = 'hang'; });
    const first = scan(page);
    await expect.poll(() => worker.evaluate(() => globalThis.__fsaCalls)).toBe(1);
    const second = scan(page);
    const [a, b] = await Promise.all([first, second]);
    expect(a.data.providers.codex.errorCode).toBe('fsa_timeout');
    expect(b.data.providers.codex.errorCode).toBe('fsa_timeout');
    expect(await worker.evaluate(() => globalThis.__fsaCalls)).toBe(1);
    const timedOut = await status(page);
    expect(timedOut.data.providers.codex.retryAt).toBeGreaterThan(Date.now());
    const next = await scan(page);
    expect(next.data.providers.codex.errorCode).toBe('fsa_timeout');
    expect(await worker.evaluate(() => globalThis.__fsaCalls)).toBe(1);
    await worker.evaluate(() => {
      globalThis.__fsaAlarmCount = 0;
      chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'agent-activity-collector') globalThis.__fsaAlarmCount++; });
      return chrome.alarms.create('agent-activity-collector', { when: Date.now() + 31_000 });
    });
    await expect.poll(() => worker.evaluate(() => globalThis.__fsaAlarmCount), { timeout: 40_000, intervals: [500] }).toBe(1);
    const afterAlarm = await status(page);
    expect(afterAlarm.data.providers.codex.runNumber).toBe(next.data.providers.codex.runNumber);
    expect(await worker.evaluate(() => globalThis.__fsaCalls)).toBe(1);
    await worker.evaluate(() => { globalThis.__fsaResolve('granted'); globalThis.__fsaMode = 'granted'; });
    const recovered = await scan(page);
    expect(recovered.data.providers.codex.errorCode).toBeNull();
    expect(recovered.data.coverage.codex.turns.measured).toBe(1);
    expect(await worker.evaluate(() => globalThis.__fsaCalls)).toBe(2);
  });
});
