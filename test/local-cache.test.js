import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromeStore } from '../src/storage/chrome-store.js';
import { assertMessageAllowed } from '../src/background/message-policy.js';
import { ConfigurationLoadCoordinator } from '../src/background/task-load.js';
import { SerialExecutor } from '../src/background/serial-executor.js';
import { TrackerService } from '../src/services/tracker.js';

class MemoryBackend {
  constructor(values) { this.values = structuredClone(values); }
  async getMany(keys) { return structuredClone(Object.fromEntries(keys.filter(k => Object.hasOwn(this.values, k)).map(k => [k, this.values[k]]))); }
  async mutateMany(keys, mutate) {
    const mutation = mutate(await this.getMany(keys));
    for (const key of mutation.delete || []) delete this.values[key];
    Object.assign(this.values, structuredClone(mutation.set || {}));
    return structuredClone(mutation.result ?? true);
  }
}

const caches = {
  reportCache: { version: 2, entries: { branch: { blobs: { sha: 'cached data' } } } },
  pageSnapshots: { reports: { view: { configured: true } } },
  taskMetadataCache: { version: 2, entries: { branch: { title: 'old' } } },
  exchangeRateCache: { version: 2, entries: { rate: 1 } },
  taskSearchCache: { revision: 9, dirty: false, indexTasks: [{ taskUrl: 'https://example.com/old' }] },
};
const registry = { version: 1, defaultDestinationId: 'github:1', destinations: {
  'github:1': { id: 'github:1', owner: 'acme', repo: 'time' },
  'github:2': { id: 'github:2', owner: 'acme', repo: 'other' },
} };
const state = (user, pendingWrites = []) => ({
  user, pendingWrites, recentCache: [{ id: user, _pending: !!pendingWrites.length }],
  summaryCache: { weekEntries: [{ id: user }], silentPull: { etag: 'old-etag' } },
  dayRangeIntervals: [{ id: user, entryDate: '2026-11-20' }], extra: 'preserve',
});

test('Clear cache discards downloaded data, preserves setup and all accepted local work', async () => {
  const initial = {
    ...caches, dataVersion: 5, configurationGeneration: 7, authGeneration: 12,
    auth: { mode: 'github_app', githubLogin: 'alice', accessToken: 'test-token' },
    destinationRegistry: registry, repositoryVerification: { 'github:1': { status: 'write_verified' } },
    billingSettings: { nextNumber: 42 }, projects: [{ id: 'keep' }], settingsRevision: 5,
    activeTimer: { destinationId: 'github:1', record: { id: 'running', startedAt: '2026-11-25T08:00:00Z' } },
    destinationStates: { version: 1, entries: {
      'github:1': state('alice'),
      'github:2': state('bob', [{ id: 'op', operation: 'editEntries', status: 'conflict', request: { entries: [{ original: { id: 'record' } }] } }]),
    } },
    'unknown-durable-key': { keep: true },
  };
  const backend = new MemoryBackend(initial), store = new ChromeStore(backend);
  assert.deepEqual(await store.clearLocalCache(), { cleared: true, retainedPendingDestinations: 1 });
  const expected = structuredClone(initial);
  for (const key of ['reportCache', 'pageSnapshots', 'taskMetadataCache', 'exchangeRateCache']) delete expected[key];
  expected.taskSearchCache = { revision: 10, dirty: true };
  expected.configurationGeneration = 8;
  const entries = expected.destinationStates.entries;
  delete entries['github:1'].summaryCache.silentPull;
  entries['github:1'].summaryCache.reportDate = null;
  delete entries['github:2'].summaryCache.silentPull;
  assert.deepEqual(backend.values, expected);
  assert.equal(await store.getReportCache('branch'), null);
  assert.equal(await store.getTaskMetadataCache('branch'), null);
  assert.equal(await store.getExchangeRateCache(), null);
  // A read started before the clear cannot republish the removed views.
  const scope = { generation: 7, authGeneration: 12, repositories: ['github:1'] };
  assert.equal(await store.savePageSnapshot('reports', scope, { configured: true }), false);
  assert.equal(await store.saveTaskMetadataCache({ repositoryKey: 'branch' }, 7), false);
  assert.equal(await store.saveTaskSearchCache({ version: 2, scope, indexTasks: [], readStatus: [] }, scope, 9), false);
  assert.equal(await store.saveExchangeRateCache({ version: 2, entries: { rate: 1 } }, 7), false);
  assert.equal(await store.saveExchangeRateCache({ version: 2, entries: { rate: 2 } }, 8), true);
});

test('Clear cache allows a fresh task catalog to be saved with no pending writes', async () => {
  const backend = new MemoryBackend({ ...caches, dataVersion: 5, configurationGeneration: 3, authGeneration: 2,
    destinationRegistry: registry, destinationStates: { version: 1, entries: { 'github:1': state('alice') } } });
  const store = new ChromeStore(backend);
  await store.clearLocalCache();
  assert.equal(await store.isTaskSearchDirty(), false);
  const scope = { generation: 4, authGeneration: 2, repositories: ['github:1'] };
  const value = { version: 2, scope, indexTasks: [], readStatus: [] };
  assert.equal(await store.getTaskSearchCache(scope), null);
  assert.equal(await store.saveTaskSearchCache(value, scope, 10), true);
  assert.equal((await store.getTaskSearchCache(scope)).revision, 10);
});

test('Clear cache preserves legacy credentials, active timer and pending projections before migration', async () => {
  const initial = { ...caches, dataVersion: 4, config: { owner: 'acme', repo: 'time' }, token: 'test-pat',
    activeCache: { id: 'active' }, recentCache: [{ id: 'pending', _pending: true }], pendingWrites: [{ id: 'op' }],
    summaryCache: { weekEntries: [{ id: 'pending' }] } };
  const backend = new MemoryBackend(initial), store = new ChromeStore(backend);
  assert.equal((await store.clearLocalCache()).retainedPendingDestinations, 1);
  for (const key of ['config', 'token', 'activeCache', 'recentCache', 'pendingWrites', 'summaryCache', 'dataVersion']) {
    assert.deepEqual(backend.values[key], initial[key]);
  }
});

test('Clear cache rejects future storage versions without modifying any data', async () => {
  const backend = new MemoryBackend({ ...caches, dataVersion: 6, auth: { githubLogin: 'alice' } });
  const before = structuredClone(backend.values);
  await assert.rejects(new ChromeStore(backend).clearLocalCache(), /storage version|data version/i);
  assert.deepEqual(backend.values, before);
});

test('Clear cache is available only to Settings, not content scripts or other extension pages', () => {
  const origin = 'chrome-extension://abc/';
  assert.equal(assertMessageAllowed('CLEAR_LOCAL_CACHE', { url: origin + 'src/options/options.html' }, origin), 'extension');
  assert.throws(() => assertMessageAllowed('CLEAR_LOCAL_CACHE', { url: 'https://github.com/acme/repo/issues/1', tab: { id: 1 } }, origin), /not allowed/);
  for (const page of ['src/times/times.html', 'src/reports/reports.html', 'src/popup/popup.html']) {
    assert.throws(() => assertMessageAllowed('CLEAR_LOCAL_CACHE', { url: origin + page }, origin), /not allowed/);
  }
});

test('clearing caches with an empty queue still rejects overlap with known completed time', async () => {
  const interval = { id: '01K2ABCDEF0123456789ABC001', user: 'alice', entryDate: '2026-11-25',
    startedAt: '2026-11-25T08:00:00.000Z', endedAt: '2026-11-25T09:00:00.000Z' };
  const initial = { ...caches, dataVersion: 5, destinationRegistry: registry, activeTimer: null,
    destinationStates: { version: 1, entries: { 'github:1': {
      user: 'alice', recentCache: [interval], pendingWrites: [],
      summaryCache: { weekEntries: [interval], reportDate: '2026-11-25', silentPull: { etag: 'old' } },
    } } } };
  const backend = new MemoryBackend(initial), store = new ChromeStore(backend);
  await store.clearLocalCache();
  const tracker = new TrackerService({ github: {}, store: store.destinationStore('github:1'), user: 'alice',
    timezone: 'UTC', clock: () => new Date('2026-11-25T12:00:00Z') });
  await assert.rejects(tracker.queueAddTime({ taskUrl: 'https://example.com/task', startedAt: '2026-11-25T08:30:00Z',
    endedAt: '2026-11-25T09:30:00Z' }), /overlap existing time/i);
  assert.deepEqual((await store.destinationStore('github:1').getState()).pendingWrites, []);
  assert.equal((await tracker.getCachedSummary()).todayTrackedMs, null, 'old display totals are invalidated');
});

test('cache transaction cannot deadlock with a catalog refresh holding the mutation executor', { timeout: 2000 }, async () => {
  const executor = new SerialExecutor(), coordinator = new ConfigurationLoadCoordinator(executor);
  let releaseWrite, entered;
  const writeEntered = new Promise(resolve => { entered = resolve; });
  const writeBlocked = new Promise(resolve => { releaseWrite = resolve; });
  const write = executor.run(async () => {
    entered();
    await writeBlocked;
    // A background refresh must not wait for a transaction queued behind it.
    await assert.rejects(coordinator.beginLoad({ wait: false }), error => error.name === 'AbortError');
  });
  await writeEntered;
  let cleared = false;
  const clear = coordinator.save(async () => {}, async () => { cleared = true; });
  const foreground = coordinator.beginLoad();
  releaseWrite();
  await Promise.all([write, clear]);
  assert.equal(cleared, true);
  assert.equal(await foreground, coordinator.current());
  assert.equal(await coordinator.beginLoad({ wait: false }), coordinator.current());
});

test('repeated clear is safe and leaves unknown durable keys and pending work intact', async () => {
  const pending = [{ id: 'pending', operation: 'addTime' }];
  const backend = new MemoryBackend({ ...caches, dataVersion: 5, destinationRegistry: registry,
    destinationStates: { version: 1, entries: { 'github:1': state('alice', pending) } },
    unknown: { keep: 'yes' } });
  const store = new ChromeStore(backend);
  await store.clearLocalCache();
  const first = structuredClone(backend.values);
  await store.clearLocalCache();
  first.configurationGeneration += 1;
  first.taskSearchCache.revision += 1;
  assert.deepEqual(backend.values, first);
});

test('invalid tracking entries fail closed before any cache is removed', async () => {
  const backend = new MemoryBackend({ ...caches, dataVersion: 5, destinationStates: { version: 1, entries: { bad: null } } });
  const before = structuredClone(backend.values);
  await assert.rejects(new ChromeStore(backend).clearLocalCache(), /invalid local tracking state/i);
  assert.deepEqual(backend.values, before);
});
