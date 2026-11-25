import { test, expect, chromium } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const extension = new URL('../experiments/local-agent-file-url/', import.meta.url).pathname;

test('file URL worker reads known files and enumerates nested directories with no page, including after restart', async () => {
  test.setTimeout(180_000);
  const scratch = join(homedir(), '.hermes/cache/scratch');
  await mkdir(scratch, { recursive: true });
  const temporary = await mkdtemp(join(scratch, 'clockoli-file-url-test-'));
  const profile = join(temporary, 'profile');
  const codex = join(temporary, '.codex', 'sessions');
  const claude = join(temporary, '.claude', 'projects');
  const codexFile = join(codex, '2026', '11', '24', 'fixture.jsonl');
  const claudeFile = join(claude, 'project', 'fixture.jsonl');
  let context;
  const launch = () => chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const workerOf = async () => context.serviceWorkers()[0] || context.waitForEvent('serviceworker', { timeout: 15_000 });
  const statusOf = async () => (await workerOf()).evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('clockoli-file-url-probe-v1', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('probe', 'readonly').objectStore('probe').get('status');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
  try {
    await mkdir(join(codex, '2026', '11', '24'), { recursive: true });
    await mkdir(join(claude, 'project'), { recursive: true });
    await writeFile(codexFile, '{"type":"fixture"}\n');
    await writeFile(claudeFile, '{"type":"fixture"}\n');
    context = await launch();
    const worker = await workerOf();
    const origin = `chrome-extension://${new URL(worker.url()).host}`;
    const page = await context.newPage();
    await page.goto(`${origin}/probe.html`);
    await page.locator('#codex-root').fill(pathToFileURL(codex + '/').href);
    await page.locator('#codex-sample').fill(pathToFileURL(codexFile).href);
    await page.locator('#claude-root').fill(pathToFileURL(claude + '/').href);
    await page.locator('#claude-sample').fill(pathToFileURL(claudeFile).href);
    await page.locator('#save').click();
    await expect(page.locator('#status')).toContainText('"saved": true');
    await page.locator('#scan').click();
    await expect.poll(statusOf).toMatchObject({
      trigger: 'manual', fileAccessEnabled: true,
      providers: {
        codex: { sample: { ok: true, completeLine: true }, listing: { jsonlFiles: 1 } },
        claude: { sample: { ok: true, completeLine: true }, listing: { jsonlFiles: 1 } },
      },
    });
    const before = await statusOf();
    await page.close();
    expect(context.pages().some(tab => tab.url().startsWith(origin))).toBe(false);
    await worker.evaluate(() => chrome.alarms.create('file-url-read-only-scan', { delayInMinutes: 0.5 }));
    await expect.poll(async () => (await statusOf())?.runNumber, { timeout: 55_000 }).toBeGreaterThan(before.runNumber);
    const background = await statusOf();
    expect(background.trigger).toBe('alarm');
    expect(background.providers.codex.sample.ok).toBe(true);
    expect(background.providers.codex.listing.jsonlFiles).toBe(1);
    await context.close();
    context = await launch();
    expect(context.pages().some(tab => tab.url().startsWith(origin))).toBe(false);
    await expect.poll(async () => (await statusOf())?.runNumber, { timeout: 75_000 }).toBeGreaterThan(background.runNumber);
    const restarted = await statusOf();
    expect(['startup', 'alarm']).toContain(restarted.trigger);
    expect(restarted.fileAccessEnabled).toBe(true);
    expect(restarted.providers.codex.sample.ok).toBe(true);
    expect(restarted.providers.codex.listing.jsonlFiles).toBe(1);
  } finally {
    await context?.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
