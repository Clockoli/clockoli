import { test, expect, chromium } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const extension = new URL('../', import.meta.url).pathname;
const scratch = join(homedir(), '.hermes/cache/scratch');
async function open(profile) {
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/options/options.html`);
  return { context, page, worker };
}
test('MV3 collector imports, replays, appends, replaces, deletes, and survives browser restart', async () => {
  await mkdir(scratch, { recursive: true });
  const profile = await mkdtemp(join(scratch, 'clockoli-agent-collector-'));
  let browser;
  try {
    browser = await open(profile);
    const first = await browser.page.evaluate(async () => {
      const store = await import(chrome.runtime.getURL('src/storage/agent-activity-store.js'));
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('fixture', { create: true });
      const fileHandle = await folder.getFileHandle('sample.jsonl', { create: true });
      const writer = await fileHandle.createWritable();
      await writer.write([
        { timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'synthetic-session' } },
        { timestamp: '2026-01-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'synthetic-turn', private: 'MUST_NOT_PERSIST' } },
        { timestamp: '2026-01-01T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'synthetic-turn' } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
      await writer.close();
      await store.setAgentRoot('codex', folder);
      const scan = await chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_CONTROL', provider: 'codex', action: 'scan' });
      return { scan, status: await chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_STATUS' }) };
    });
    expect(first.scan.ok).toBe(true);
    expect(first.scan.data.providers.codex.connected).toBe(true);
    expect(first.status.data.coverage.codex.turns.discovered).toBe(1);
    expect(first.status.data.coverage.codex.turns.measured).toBe(1);
    const repeat = await browser.page.evaluate(async () => chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_CONTROL', provider: 'codex', action: 'scan' }));
    expect(repeat.data.coverage.codex.turns.discovered).toBe(1);
    await browser.page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('fixture');
      const file = await folder.getFileHandle('sample.jsonl');
      const writable = await file.createWritable({ keepExistingData: true });
      const original = await file.getFile();
      await writable.seek(original.size);
      await writable.write([
        { timestamp: '2026-01-01T00:00:04.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'second-turn' } },
        { timestamp: '2026-01-01T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'second-turn' } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
      await writable.close();
    });
    const appended = await browser.page.evaluate(async () => chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_CONTROL', provider: 'codex', action: 'scan' }));
    expect(appended.data.coverage.codex.turns.discovered).toBe(2);
    await browser.context.close();
    browser = await open(profile);
    const recovered = await browser.page.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_CONTROL', provider: 'codex', action: 'scan' });
      return chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_STATUS' });
    });
    expect(recovered.data.coverage.codex.turns.discovered).toBe(2);
    expect(recovered.data.coverage.codex.turns.measured).toBe(2);
    const containsPrivateText = await browser.page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('clockoli-agent-activity-v1');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const store = db.transaction(['files', 'projections'], 'readonly');
      const files = await new Promise(resolve => { const r = store.objectStore('files').getAll(); r.onsuccess = () => resolve(r.result); });
      const projection = await new Promise(resolve => { const r = store.objectStore('projections').getAll(); r.onsuccess = () => resolve(r.result); });
      db.close();
      return JSON.stringify({ files, projection }).includes('MUST_NOT_PERSIST');
    });
    expect(containsPrivateText).toBe(false);
    const replaced = await browser.page.evaluate(async () => {
      const store = await import(chrome.runtime.getURL('src/storage/agent-activity-store.js'));
      const previousKeys = (await store.getAgentProjection('codex', 1)).turns.map(turn => turn.key);
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('fixture');
      const file = await folder.getFileHandle('sample.jsonl');
      const writable = await file.createWritable();
      await writable.write([
        { timestamp: '2026-01-02T00:00:00.000Z', type: 'session_meta', payload: { id: 'replacement-session' } },
        { timestamp: '2026-01-02T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'replacement-turn' } },
        { timestamp: '2026-01-02T00:00:06.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'replacement-turn' } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
      await writable.close();
      const scan = await chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_CONTROL', provider: 'codex', action: 'scan' });
      const projection = await store.getAgentProjection('codex', 1);
      return { scan, previousKeys, replacementKeys: projection.turns.map(turn => turn.key),
        fileCount: (await store.listAgentFiles('codex', 1)).length };
    });
    expect(replaced.scan.data.coverage.codex.turns.discovered).toBe(1);
    expect(replaced.scan.data.coverage.codex.time.agentMs).toBe(5000);
    expect(replaced.fileCount).toBe(1);
    expect(replaced.replacementKeys).toHaveLength(1);
    expect(replaced.previousKeys).not.toContain(replaced.replacementKeys[0]);
    const removed = await browser.page.evaluate(async () => {
      const store = await import(chrome.runtime.getURL('src/storage/agent-activity-store.js'));
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('fixture');
      await folder.removeEntry('sample.jsonl');
      const scan = await chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_CONTROL', provider: 'codex', action: 'scan' });
      return { scan, files: (await store.listAgentFiles('codex', 1)).length,
        turns: (await store.getAgentProjection('codex', 1)).turns.length };
    });
    expect(removed.scan.data.coverage.codex.turns.discovered).toBe(0);
    expect(removed.files).toBe(0);
    expect(removed.turns).toBe(0);
  } finally {
    await browser?.context.close().catch(() => {});
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('malformed source quarantines its cursor, preserves other files, and recovers after repair', async () => {
  await mkdir(scratch, { recursive: true });
  const profile = await mkdtemp(join(scratch, 'clockoli-agent-quarantine-'));
  let browser;
  try {
    browser = await open(profile);
    const outcome = await browser.page.evaluate(async () => {
      const store = await import(chrome.runtime.getURL('src/storage/agent-activity-store.js'));
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('fixture', { create: true });
      const write = async (name, text) => {
        const file = await folder.getFileHandle(name, { create: true });
        const writer = await file.createWritable();
        await writer.write(text);
        await writer.close();
      };
      const row = (type, turnId, second) => JSON.stringify({
        type: 'event_msg', timestamp: `2026-01-01T00:00:${String(second).padStart(2, '0')}Z`,
        payload: { type, turn_id: turnId },
      }) + '\n';
      const good = row('task_started', 'good', 1) + row('task_complete', 'good', 2);
      const start = row('task_started', 'blocked', 3);
      await write('good.jsonl', good);
      await write('blocked.jsonl', start + '{bad}\n' + row('task_complete', 'blocked', 5));
      await store.setAgentRoot('codex', folder);
      const scan = () => chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_CONTROL', provider: 'codex', action: 'scan' });
      const first = await scan();
      const blocked = (await store.listAgentFiles('codex', 1)).find(file => file.cursor.safeErrorCode);
      const repeat = await scan();
      const repeated = (await store.listAgentFiles('codex', 1)).find(file => file.fileKey === blocked.fileKey);
      await write('blocked.jsonl', start + row('task_complete', 'blocked', 5));
      const repaired = await scan();
      const repairedFile = (await store.listAgentFiles('codex', 1)).find(file => file.fileKey === blocked.fileKey);
      return { first, repeat, repaired, firstOffset: blocked.cursor.offset,
        repeatedOffset: repeated.cursor.offset, firstError: blocked.cursor.safeErrorCode,
        repairedOffset: repairedFile.cursor.offset, repairedSize: repairedFile.cursor.size,
        repairedError: repairedFile.cursor.safeErrorCode };
    });
    expect(outcome.first.data.providers.codex.blockedFiles).toBe(1);
    expect(outcome.first.data.providers.codex.complete).toBe(false);
    expect(outcome.first.data.coverage.codex.turns.discovered).toBe(2);
    expect(outcome.first.data.coverage.codex.turns.measured).toBe(1);
    expect(outcome.firstError).toBe('invalid_jsonl');
    expect(outcome.firstOffset).toBeGreaterThan(0);
    expect(outcome.repeat.data.providers.codex.blockedFiles).toBe(1);
    expect(outcome.repeatedOffset).toBe(outcome.firstOffset);
    expect(outcome.repaired.data.providers.codex.complete).toBe(true);
    expect(outcome.repaired.data.coverage.codex.turns.measured).toBe(2);
    expect(outcome.repairedOffset).toBe(outcome.repairedSize);
    expect(outcome.repairedError).toBeNull();
  } finally {
    await browser?.context.close().catch(() => {});
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
