import { test, expect, chromium } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const extension = new URL('../', import.meta.url).pathname;
test('agent store atomically commits cursor and projection, rejects stale roots, stages reindex, and resets separately', async () => {
  const scratch = join(homedir(), '.hermes/cache/scratch');
  await mkdir(scratch, { recursive: true });
  const profile = await mkdtemp(join(scratch, 'clockoli-agent-store-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const origin = `chrome-extension://${new URL(worker.url()).host}`;
    await page.goto(`${origin}/src/options/options.html`);
    const outcome = await page.evaluate(async () => {
      const store = await import(chrome.runtime.getURL('src/storage/agent-activity-store.js'));
      const opfs = await navigator.storage.getDirectory();
      const folder = await opfs.getDirectoryHandle('safe-fixture', { create: true });
      const fileKey = 'opaque-file-key';
      await store.setAgentRoot('codex', folder);
      const rootId = (await store.getAgentRootState('codex')).rootId;
      const firstLease = await store.acquireAgentLease('codex', rootId);
      const overlappingLease = await store.acquireAgentLease('codex', rootId);
      await store.releaseAgentLease('codex', 'stale-token');
      const afterStaleRelease = await store.acquireAgentLease('codex', rootId);
      await store.releaseAgentLease('codex', firstLease);
      const recoveredLease = await store.acquireAgentLease('codex', rootId);
      await store.releaseAgentLease('codex', recoveredLease);
      const first = { provider: 'codex', rootId, generation: 1,
        files: [{ fileKey, expectedRevision: 0, cursor: { offset: 10 }, events: [], unknownEvents: 0 }],
        projection: { turns: [{ key: 'opaque-turn', provider: 'codex', elapsedMs: 10 }], sessions: [] },
        expectedProjectionRevision: 0, activate: true };
      await store.commitAgentBatch(first);
      const initial = await store.getAgentProjection('codex', 1);
      let staleRejected = false;
      try { await store.commitAgentBatch(first); } catch { staleRejected = true; }
      const unchanged = await store.getAgentProjection('codex', 1);
      let interruptedRejected = false;
      try {
        await store.commitAgentBatch({ ...first,
          files: [{ ...first.files[0], expectedRevision: 1, cursor: { offset: 20 } }],
          expectedProjectionRevision: 1,
          projection: { turns: [{ unsafe: () => {} }], sessions: [] } });
      } catch { interruptedRejected = true; }
      const afterInterrupted = await store.listAgentFiles('codex', 1);
      const afterInterruptedProjection = await store.getAgentProjection('codex', 1);
      await store.beginAgentReindex('codex', 2);
      const oldActive = (await store.getAgentState('codex')).activeGeneration;
      await store.commitAgentBatch({ ...first, generation: 2, activate: false });
      const stagingActive = (await store.getAgentState('codex')).activeGeneration;
      const staged = await store.getAgentProjection('codex', 2);
      let stagingFailureRejected = false;
      try { await store.commitAgentBatch({ ...first, generation: 2, activate: true }); }
      catch { stagingFailureRejected = true; }
      const afterStagingFailure = (await store.getAgentState('codex')).activeGeneration;
      await store.commitAgentBatch({ ...first, generation: 2, activate: true,
        expectedProjectionRevision: 1,
        files: [{ ...first.files[0], expectedRevision: 1 }] });
      const newActive = (await store.getAgentState('codex')).activeGeneration;
      await store.pruneAgentGenerations('codex', 2, rootId);
      const oldFiles = await store.listAgentFiles('codex', 1);
      const oldProjection = await store.getAgentProjection('codex', 1);
      await store.setAgentRoot('codex', folder);
      let rootRejected = false;
      try { await store.commitAgentBatch({ ...first, expectedRevision: 1, expectedProjectionRevision: 1 }); }
      catch { rootRejected = true; }
      await store.resetAgentActivity();
      return { leaseAcquired: Boolean(firstLease), overlappingLease, afterStaleRelease,
        recoveredLease: Boolean(recoveredLease), initialCount: initial.turns.length,
        staleRejected, unchangedCount: unchanged.turns.length,
        interruptedRejected, afterInterruptedOffset: afterInterrupted[0].cursor.offset,
        afterInterruptedRevision: afterInterruptedProjection.revision,
        oldActive, stagingActive, stagedCount: staged.turns.length, stagingFailureRejected,
        afterStagingFailure, newActive, oldFiles: oldFiles.length, oldProjection,
        rootRejected, afterReset: await store.getAgentRoot('codex'),
        afterResetProjection: await store.getAgentProjection('codex', 1) };
    });
    expect(outcome).toEqual({ leaseAcquired: true, overlappingLease: null, afterStaleRelease: null,
      recoveredLease: true, initialCount: 1, staleRejected: true, unchangedCount: 1,
      interruptedRejected: true, afterInterruptedOffset: 10, afterInterruptedRevision: 1,
      oldActive: 1, stagingActive: 1, stagedCount: 1, stagingFailureRejected: true,
      afterStagingFailure: 1, newActive: 2, oldFiles: 0, oldProjection: null,
      rootRejected: true, afterReset: null, afterResetProjection: null });
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
