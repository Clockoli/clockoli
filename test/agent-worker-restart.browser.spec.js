import { test, expect, chromium } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const extension = new URL('../', import.meta.url).pathname;
const scratch = join(homedir(), '.hermes/cache/scratch');

// The target disappears, and a fresh JS global proves the MV3 instance restarted;
// Chromium may reuse a target ID for the same service-worker registration.
test('Codex cursor and observations survive forced worker termination in the open profile', async () => {
  await mkdir(scratch, { recursive: true });
  const profile = await mkdtemp(join(scratch, 'clockoli-agent-worker-restart-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const initialWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const workerUrl = initialWorker.url();
    const page = await context.newPage();
    const errors = [];
    const watchWorker = worker => {
      worker.on('console', message => { if (message.type() === 'error') errors.push(`worker: ${message.text()}`); });
      worker.on('pageerror', error => errors.push(`worker: ${error.message}`));
    };
    watchWorker(initialWorker);
    context.on('serviceworker', watchWorker);
    page.on('console', message => { if (message.type() === 'error') errors.push(`page: ${message.text()}`); });
    page.on('pageerror', error => errors.push(`page: ${error.message}`));
    await page.goto(`chrome-extension://${new URL(workerUrl).host}/src/options/options.html`);
    const settingsUrl = page.url();
    const cdp = await context.newCDPSession(page);
    const targets = async () => (await cdp.send('Target.getTargets')).targetInfos
      .filter(target => target.type === 'service_worker' && target.url === workerUrl);

    const initial = await page.evaluate(async () => {
      const store = await import(chrome.runtime.getURL('src/storage/agent-activity-store.js'));
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('worker-restart-fixture', { create: true });
      const file = await folder.getFileHandle('sample.jsonl', { create: true });
      const writer = await file.createWritable();
      await writer.write([
        { timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'synthetic-session' } },
        { timestamp: '2026-01-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'first-turn' } },
        { timestamp: '2026-01-01T00:00:04.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'first-turn' } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
      await writer.close();
      await store.setAgentRoot('codex', folder);
      const scan = await chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_CONTROL', provider: 'codex', action: 'scan' });
      const files = await store.listAgentFiles('codex', 1);
      const projection = await store.getAgentProjection('codex', 1);
      return { scan, files, projection, fileSize: (await file.getFile()).size };
    });
    expect(initial.scan.ok).toBe(true);
    expect(initial.scan.data.providers.codex.complete).toBe(true);
    expect(initial.scan.data.coverage.codex.turns).toMatchObject({ discovered: 1, measured: 1 });
    expect(initial.files).toHaveLength(1);
    expect(initial.files[0].cursor.offset).toBe(initial.fileSize);
    expect(initial.files[0].events).toHaveLength(2);
    expect(initial.projection.turns).toHaveLength(1);
    const oldTarget = (await targets())[0];
    const workerMarker = await initialWorker.evaluate(() => globalThis.__clockoliTestWorkerMarker = crypto.randomUUID());
    expect(oldTarget?.targetId).toBeTruthy();
    expect((await cdp.send('Target.closeTarget', { targetId: oldTarget.targetId })).success).toBe(true);
    await expect.poll(async () => (await targets()).some(target => target.targetId === oldTarget.targetId)).toBe(false);
    // Neither the browser profile nor Settings page is closed or reloaded here.
    expect(page.isClosed()).toBe(false);
    expect(page.url()).toBe(settingsUrl);
    expect(await page.evaluate(() => document.readyState)).toBe('complete');

    const restored = await page.evaluate(async () => {
      const store = await import(chrome.runtime.getURL('src/storage/agent-activity-store.js'));
      const status = await chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_STATUS' });
      return { status, files: await store.listAgentFiles('codex', 1),
        projection: await store.getAgentProjection('codex', 1) };
    });
    await expect.poll(async () => (await targets()).length).toBe(1);
    const resumedTarget = (await targets())[0];
    const resumedMarker = await initialWorker.evaluate(() => globalThis.__clockoliTestWorkerMarker);
    expect(resumedMarker).toBeUndefined();
    expect(workerMarker).toBeTruthy();
    expect(restored.status.ok).toBe(true);
    expect(restored.status.data.coverage.codex.turns).toMatchObject({ discovered: 1, measured: 1 });
    expect(restored.files).toEqual(initial.files);
    expect(restored.projection).toEqual(initial.projection);

    const appended = await page.evaluate(async () => {
      const store = await import(chrome.runtime.getURL('src/storage/agent-activity-store.js'));
      const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('worker-restart-fixture');
      const file = await folder.getFileHandle('sample.jsonl');
      const original = await file.getFile();
      const writer = await file.createWritable({ keepExistingData: true });
      await writer.seek(original.size);
      await writer.write([
        { timestamp: '2026-01-01T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'second-turn' } },
        { timestamp: '2026-01-01T00:00:09.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'second-turn' } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
      await writer.close();
      const scan = await chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_CONTROL', provider: 'codex', action: 'scan' });
      const afterScan = { files: await store.listAgentFiles('codex', 1),
        projection: await store.getAgentProjection('codex', 1) };
      const repeat = await chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_CONTROL', provider: 'codex', action: 'scan' });
      return { scan, repeat, afterScan, files: await store.listAgentFiles('codex', 1),
        projection: await store.getAgentProjection('codex', 1), fileSize: (await file.getFile()).size };
    });
    expect(appended.scan.ok).toBe(true);
    expect(appended.scan.data.providers.codex.complete).toBe(true);
    expect(appended.scan.data.coverage.codex.turns).toMatchObject({ discovered: 2, measured: 2 });
    expect(appended.scan.data.providers.codex.bytesRead).toBeLessThan(appended.fileSize);
    expect(appended.files).toHaveLength(1);
    expect(appended.files[0].cursor.offset).toBe(appended.fileSize);
    expect(appended.files[0].events).toHaveLength(4);
    expect(appended.files[0].events.slice(0, 2)).toEqual(initial.files[0].events);
    expect(appended.projection.turns).toHaveLength(2);
    expect(new Set(appended.projection.turns.map(turn => turn.key)).size).toBe(2);
    expect(appended.projection.turns.map(turn => turn.key)).toContain(initial.projection.turns[0].key);
    expect(appended.repeat.ok).toBe(true);
    expect(appended.repeat.data.coverage.codex.turns).toMatchObject({ discovered: 2, measured: 2 });
    expect(appended.files).toEqual(appended.afterScan.files);
    expect(appended.projection).toEqual(appended.afterScan.projection);
    expect(page.isClosed()).toBe(false);
    expect(page.url()).toBe(settingsUrl);
    expect(errors).toEqual([]);
    expect(resumedTarget.url).toBe(workerUrl);
  } finally {
    await context?.close().catch(() => {});
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
