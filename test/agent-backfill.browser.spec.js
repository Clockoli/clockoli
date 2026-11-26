import { test, expect, chromium } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const extension = new URL('../', import.meta.url).pathname;
test('unchanged large journal resumes and linked Claude files reconcile', async () => {
  const scratch = join(homedir(), '.hermes/cache/scratch');
  await mkdir(scratch, { recursive: true });
  const profile = await mkdtemp(join(scratch, 'clockoli-agent-backfill-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/options/options.html`);
    const first = await page.evaluate(async () => {
      const store = await import(chrome.runtime.getURL('src/storage/agent-activity-store.js'));
      const root = await navigator.storage.getDirectory();
      const codex = await root.getDirectoryHandle('codex-fixture', { create: true });
      const file = await codex.getFileHandle('large.jsonl', { create: true });
      const user = { type: 'session_meta', timestamp: '2026-01-01T00:00:00.000Z', payload: { id: 'session' } };
      const start = { type: 'event_msg', timestamp: '2026-01-01T00:00:01.000Z', payload: { type: 'task_started', turn_id: 'turn' } };
      const end = { type: 'event_msg', timestamp: '2026-01-01T00:00:04.000Z', payload: { type: 'task_complete', turn_id: 'turn' } };
      const padding = JSON.stringify({ type: 'unknown', timestamp: '2026-01-01T00:00:02.000Z', private: 'DO_NOT_STORE'.repeat(95_000) });
      const writer = await file.createWritable();
      await writer.write([JSON.stringify(user), JSON.stringify(start), ...Array(18).fill(padding), JSON.stringify(end)].join('\n') + '\n');
      await writer.close();
      const claude = await root.getDirectoryHandle('claude-fixture', { create: true });
      const rows = [
        [{ type: 'user', uuid: 'user-1', parentUuid: null, sessionId: 'linked-session',
          timestamp: '2026-01-01T00:01:00.000Z', message: { content: [{ type: 'text', text: 'DO_NOT_STORE' }] } }],
        [{ type: 'assistant', uuid: 'assistant-1', parentUuid: 'user-1', sessionId: 'linked-session',
          timestamp: '2026-01-01T00:01:01.000Z', message: { id: 'message-1', content: [{ type: 'text', text: 'DO_NOT_STORE' }] } },
        { type: 'system', subtype: 'turn_duration', uuid: 'duration-1', parentUuid: 'assistant-1', sessionId: 'linked-session',
          timestamp: '2026-01-01T00:01:04.000Z', durationMs: 3000 }],
      ];
      for (const [index, contents] of rows.entries()) {
        const handle = await claude.getFileHandle(`${index}.jsonl`, { create: true });
        const write = await handle.createWritable();
        await write.write(contents.map(row => JSON.stringify(row)).join('\n') + '\n');
        await write.close();
      }
      await store.setAgentRoot('codex', codex);
      await store.setAgentRoot('claude', claude);
      const scan = await chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_CONTROL', provider: 'codex', action: 'scan' });
      const saved = await store.listAgentFiles('codex', 1);
      return { scan, offset: saved[0].cursor.offset, size: (await file.getFile()).size,
        events: saved[0].events.length };
    });
    expect(first.scan.ok).toBe(true);
    expect(first.scan.data.providers.codex.backlog).toBe(true);
    expect(first.scan.data.providers.claude.runNumber).toBe(0);
    expect(first.offset).toBeGreaterThan(0);
    expect(first.offset).toBeLessThan(first.size);
    expect(first.events).toBe(1); // The terminal event has not been committed yet.
    const claude = await page.evaluate(async () => {
      const store = await import(chrome.runtime.getURL('src/storage/agent-activity-store.js'));
      const scan = await chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_CONTROL', provider: 'claude', action: 'scan' });
      const files = await store.listAgentFiles('claude', 1);
      return { scan, files: files.length, projection: await store.getAgentProjection('claude', 1),
        userFileKey: files.find(file => file.events.some(event => event.type === 'user')).fileKey };
    });
    expect(claude.scan.data.coverage.claude.turns.discovered).toBe(1);
    expect(claude.scan.data.coverage.claude.turns.measured).toBe(1);
    expect(claude.files).toBe(2);
    expect(claude.projection.turns).toHaveLength(1);
    expect(claude.projection.turns[0].providerDurationMs).toBe(3000);
    expect(claude.projection.sessions[0].sourceFileKey).toBe(claude.userFileKey);
    const claudeRepeat = await page.evaluate(async () => {
      const store = await import(chrome.runtime.getURL('src/storage/agent-activity-store.js'));
      const scan = await chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_CONTROL', provider: 'claude', action: 'scan' });
      return { coverage: scan.data.coverage.claude,
        turnKey: (await store.getAgentProjection('claude', 1)).turns[0].key,
        revision: (await store.getAgentProjection('claude', 1)).revision };
    });
    expect(claudeRepeat.turnKey).toBe(claude.projection.turns[0].key);
    expect(claudeRepeat.coverage.time.agentMs).toBe(3000);
    expect(claudeRepeat.revision).toBe(claude.projection.revision);
    expect(claude.projection.projectionVersion).toBe(1);
    expect(claude.projection.turns[0].startedAt).toBe('2026-01-01T00:01:00.000Z');
    expect(claude.projection.turns[0].endedAt).toBe('2026-01-01T00:01:04.000Z');
    expect(claude.projection.turns[0].anchored).toBe(false);
    expect(claudeRepeat.coverage.turns.discovered).toBe(1);
    // Simulate a projection produced before timestamp preservation was added.
    // The source cursor remains valid; the next scan must repair derived data only.
    const repaired = await page.evaluate(async () => {
      const store = await import(chrome.runtime.getURL('src/storage/agent-activity-store.js'));
      const db = await store.openAgentDb();
      const before = await store.getAgentProjection('claude', 1);
      await new Promise((resolve, reject) => {
        const tx = db.transaction('projections', 'readwrite');
        const legacy = { ...before, projectionVersion: 0,
          turns: before.turns.map(turn => ({ ...turn, startedAt: null, endedAt: null })) };
        tx.objectStore('projections').put(legacy, 'claude:1');
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
      const scan = await chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_CONTROL', provider: 'claude', action: 'scan' });
      return { scan, projection: await store.getAgentProjection('claude', 1) };
    });
    expect(repaired.scan.data.providers.claude.bytesRead).toBe(0);
    expect(repaired.projection.projectionVersion).toBe(1);
    expect(repaired.projection.turns).toEqual(claude.projection.turns);
    const second = await page.evaluate(async () => {
      const store = await import(chrome.runtime.getURL('src/storage/agent-activity-store.js'));
      const scan = await chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_CONTROL', provider: 'codex', action: 'scan' });
      const saved = await store.listAgentFiles('codex', 1);
      return { scan, offset: saved[0].cursor.offset, events: saved[0].events.length };
    });
    expect(second.scan.data.providers.codex.complete).toBe(true);
    expect(second.offset).toBe(first.size);
    expect(second.events).toBe(2);
    expect(second.scan.data.providers.codex.bytesRead).toBeLessThan(first.size - first.offset + 1);
    expect(second.scan.data.coverage.codex.turns.discovered).toBe(1);
    expect(second.scan.data.coverage.codex.turns.measured).toBe(1);
    expect(second.scan.data.coverage.codex.time.agentMs).toBe(3000);
    expect(second.scan.data.coverage.claude.time.agentMs).toBe(3000);
    expect(second.scan.data.coverage.claude.time.wallClockMs).toBe(0);
    const deleted = await page.evaluate(async () => {
      const store = await import(chrome.runtime.getURL('src/storage/agent-activity-store.js'));
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('claude-fixture');
      await folder.removeEntry('1.jsonl');
      const scan = await chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_CONTROL', provider: 'claude', action: 'scan' });
      return { scan, files: (await store.listAgentFiles('claude', 1)).length,
        projection: await store.getAgentProjection('claude', 1) };
    });
    expect(deleted.files).toBe(2);
    expect(deleted.projection.turns).toHaveLength(1);
    expect(deleted.projection.turns[0].key).toBe(claude.projection.turns[0].key);
    expect(deleted.projection.turns[0].status).toBe('completed');
    expect(deleted.scan.data.coverage.claude.scan.archivedFiles).toBe(1);
    expect(deleted.scan.data.coverage.claude.turns.measured).toBe(1);
    expect(deleted.scan.data.coverage.claude.time.agentMs).toBe(3000);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
