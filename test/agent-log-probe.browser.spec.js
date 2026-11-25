import { test, expect, chromium } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const extension = new URL('../experiments/local-agent-logs/', import.meta.url).pathname;
const fixtureLine = type => JSON.stringify({ type, timestamp: '2026-11-24T12:00:00Z' }) + '\n';

test('isolated MV3 worker restores IndexedDB handles and catches up without an extension tab', async () => {
  test.setTimeout(165_000);
  const scratch = join(homedir(), '.hermes/cache/scratch');
  await mkdir(scratch, { recursive: true });
  const profile = await mkdtemp(join(scratch, 'clockoli-agent-probe-'));
  const errors = [];
  let context;
  const launch = () => chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const workerOf = async current => current.serviceWorkers()[0] || current.waitForEvent('serviceworker', { timeout: 15_000 });
  const statusOf = async worker => worker.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('clockoli-local-log-probe-v1', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('status', 'readonly').objectStore('status').get('latest');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
  try {
    context = await launch();
    let worker = await workerOf(context);
    worker.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const origin = `chrome-extension://${new URL(worker.url()).host}`;
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/probe.html`);
    await page.evaluate(async rows => {
      const { write } = await import(chrome.runtime.getURL('database.js'));
      const root = await navigator.storage.getDirectory();
      for (const [provider, folder, path, text] of rows) {
        let directory = await root.getDirectoryHandle(folder, { create: true });
        for (const segment of path) directory = await directory.getDirectoryHandle(segment, { create: true });
        const handle = await directory.getFileHandle('fixture.jsonl', { create: true });
        const output = await handle.createWritable();
        await output.write(provider === 'codex' ? text + JSON.stringify({ type: 'event_msg', payload: 'x'.repeat(12 * 1024 * 1024) }) + '\n' : text);
        await output.close();
        await write('handles', provider, await root.getDirectoryHandle(folder));
      }
    }, [
      ['codex', 'sessions', ['2026', '11', '24'], fixtureLine('session_meta')],
      ['claude', 'projects', ['sample'], fixtureLine('user')],
    ]);
    await page.locator('#scan').click();
    await expect.poll(() => statusOf(worker)).toMatchObject({
      trigger: 'manual', providers: { codex: { newLines: 2, permission: 'granted', errorCount: 0 }, claude: { newLines: 1, permission: 'granted' } },
    });
    const before = await statusOf(worker);
    await page.close();
    expect(context.pages().every(tab => !tab.url().startsWith(origin))).toBe(true);

    // A fixture-only append is left unread while the browser is stopped.
    await worker.evaluate(async text => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('sessions');
      const year = await dir.getDirectoryHandle('2026');
      const month = await year.getDirectoryHandle('11');
      const day = await month.getDirectoryHandle('24');
      const handle = await day.getFileHandle('fixture.jsonl');
      const output = await handle.createWritable({ keepExistingData: true });
      const file = await handle.getFile();
      await output.seek(file.size);
      await output.write(text);
      await output.close();
    }, fixtureLine('event_msg'));
    await context.close();
    context = await launch();
    worker = await workerOf(context);
    worker.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    expect(context.pages().every(tab => !tab.url().startsWith(origin))).toBe(true);
    expect(await worker.evaluate(() => chrome.alarms.get('read-only-local-log-scan'))).toBeTruthy();
    await expect.poll(async () => {
      const current = context.serviceWorkers()[0] || await workerOf(context);
      return (await statusOf(current))?.runNumber;
    }, { timeout: 75_000, intervals: [500] }).toBeGreaterThan(before.runNumber);
    const restored = await statusOf(context.serviceWorkers()[0] || await workerOf(context));
    expect(['startup', 'alarm']).toContain(restored.trigger);
    expect(restored.providers.codex).toMatchObject({ newLines: 1, permission: 'granted' });
    expect(restored.providers.claude).toMatchObject({ newLines: 0, permission: 'granted' });
    await worker.evaluate(() => chrome.alarms.create('read-only-local-log-scan', { delayInMinutes: 0.5 }));
    await expect.poll(async () => {
      const current = context.serviceWorkers()[0] || await workerOf(context);
      return (await statusOf(current))?.runNumber;
    }, { timeout: 50_000, intervals: [1000] }).toBeGreaterThan(restored.runNumber);
    const current = context.serviceWorkers()[0] || await workerOf(context);
    const alarmRun = await statusOf(current);
    expect(alarmRun.trigger).toBe('alarm');
    expect(alarmRun.providers.codex.newLines).toBe(0);
    expect(alarmRun.providers.claude.newLines).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
