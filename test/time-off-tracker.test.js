import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackerService } from '../src/services/tracker.js';
import { createUlid } from '../src/domain/ulid.js';
import { buildActiveTimer, buildEntry } from '../src/domain/records.js';
import { parseMonthlyRecords, serializeMonthlyRecords } from '../src/domain/work-records.js';
import { applyTaskIndexChanges, emptyTaskIndex, serializeTaskIndex, TASK_INDEX_PATH } from '../src/domain/task-index.js';

const taskUrl = 'https://github.com/acme/work/issues/7';
const clock = () => new Date('2026-11-23T10:00:00.000Z');
const rows = dates => dates.map(date => ({ date, startTime: '09:00', durationSeconds: 28800 }));
class MemoryStore {
  constructor() {
    this.state = { user: 'alice', activeCache: null, recentCache: [], summaryCache: null,
      dayRangeIntervals: [], pendingWrites: [] };
  }
  async getState() { return structuredClone(this.state); }
  async mutateState(callback) {
    const current = structuredClone(this.state), patch = callback(current);
    this.state = { ...current, ...(patch ?? {}) };
    return structuredClone(this.state);
  }
  async patchState(patch) { this.state = { ...this.state, ...structuredClone(patch) }; }
}
class FakeGitHub {
  constructor() {
    this.files = new Map([[TASK_INDEX_PATH, { sha: 'index-0', text: serializeTaskIndex(emptyTaskIndex('alice')) }]]);
    this.writes = []; this.serial = 0; this.headSha = 'first-head';
  }
  missing() { return Object.assign(new Error('missing'), { status: 404, code: 'not_found' }); }
  async getText(path) {
    if (!this.files.has(path)) throw this.missing();
    return { ...this.files.get(path), path };
  }
  async assertDestinationReachable() { return true; }
  async listTextFilesSnapshot(prefix) {
    return { files: [...this.files].filter(([path]) => path.startsWith(prefix))
      .map(([path, file]) => ({ path, sha: file.sha })), headSha: this.headSha };
  }
  async updateTextsAtomic(changes, message, { guards = [], expectedHeadSha = null } = {}) {
    if (expectedHeadSha && expectedHeadSha !== this.headSha) throw Object.assign(new Error('changed'), { status: 409 });
    for (const item of [...changes, ...guards]) if ((this.files.get(item.path)?.sha ?? null) !== (item.sha ?? null)) {
      throw Object.assign(new Error('changed'), { status: 409 });
    }
    const blobShas = {};
    for (const change of changes) {
      if (change.text === null) this.files.delete(change.path);
      else {
        const sha = 'saved-' + (++this.serial);
        this.files.set(change.path, { sha, text: change.text });
        blobShas[change.path] = sha;
      }
    }
    this.headSha = 'head-' + (++this.serial);
    this.writes.push({ changes: structuredClone(changes), guards: structuredClone(guards), message });
    return { blobShas };
  }
}
function setup() {
  const github = new FakeGitHub(), store = new MemoryStore();
  const tracker = new TrackerService({ github, store, user: 'alice',
    timezone: 'UTC', clock, idFactory: timestamp => createUlid(timestamp) });
  return { github, store, tracker };
}
const payload = (days, extras = {}) => ({
  taskUrl, taskTitle: 'Paid time off', description: 'Vacation',
  groupId: null, previous: [], days, ...extras,
});
const previous = entries => entries.map(entry => ({
  id: entry.id, date: entry.entryDate, startedAt: entry.startedAt,
  endedAt: entry.endedAt, updatedAt: entry.updatedAt,
}));
const savedRecords = github => {
  const file = github.files.get('times/2026-12/alice.jsonl');
  return file ? parseMonthlyRecords(file.text, { user: 'alice', month: '2026-12',
    path: 'times/2026-12/alice.jsonl', sha: file.sha }) : [];
};

test('PTO group creation, date replacement and cancellation are each one atomic GitHub commit', async () => {
  const { github, tracker, store } = setup();
  const accepted = await tracker.queueTimeOffChange(payload(rows(['2026-12-07', '2026-12-08'])));
  assert.equal(accepted.pending, true);
  assert.equal(github.writes.length, 0, 'accept without contacting GitHub');
  assert.equal(store.state.pendingWrites.length, 1);
  assert.equal(accepted.entries.length, 2);
  assert.ok(accepted.entries.every(entry => entry.metadata.clockoli.timeOffGroupId === accepted.groupId
    && entry.metadata.billable === false));
  await tracker.syncPending();
  assert.equal(github.writes.length, 1);
  assert.equal(store.state.pendingWrites.length, 0);
  assert.deepEqual(savedRecords(github).map(entry => entry.entryDate), ['2026-12-07', '2026-12-08']);
  const original = savedRecords(github);
  const edit = await tracker.queueTimeOffChange(payload(rows(['2026-12-07', '2026-12-09']), {
    groupId: accepted.groupId, previous: previous(original), description: 'Changed dates',
  }));
  assert.equal(github.writes.length, 1, 'editing remains local first');
  assert.equal(edit.entries.length, 2);
  await tracker.syncPending();
  assert.equal(github.writes.length, 2, 'one commit for remove + add across group');
  const updated = savedRecords(github);
  assert.deepEqual(updated.map(entry => entry.entryDate), ['2026-12-07', '2026-12-09']);
  assert.ok(updated.every(entry => entry.description === 'Changed dates'
    && entry.metadata.clockoli.timeOffGroupId === accepted.groupId));
  await tracker.queueTimeOffChange(payload([], { groupId: accepted.groupId, previous: previous(updated) }));
  await tracker.syncPending();
  assert.equal(github.writes.length, 3, 'one commit for whole cancellation');
  assert.equal(savedRecords(github).length, 0);
});

test('PTO does not move into evenings when a remote work interval conflicts', async () => {
  const { github, tracker, store } = setup();
  const active = buildActiveTimer({
    user: 'alice', taskUrl: 'https://github.com/acme/work/issues/13',
    id: createUlid(Date.parse('2026-12-07T09:00:00Z')),
    startedAt: '2026-12-07T09:00:00Z', timezone: 'UTC',
  });
  const existing = buildEntry({ active, endedAt: '2026-12-07T17:00:00Z' });
  github.files.set('times/2026-12/alice.jsonl', {
    sha: 'work-1', text: serializeMonthlyRecords([existing]),
  });
  github.files.set(TASK_INDEX_PATH, { sha: 'index-1',
    text: serializeTaskIndex(applyTaskIndexChanges(emptyTaskIndex('alice'), { add: [existing] })) });
  const accepted = await tracker.queueTimeOffChange(payload(rows(['2026-12-07'])));
  assert.equal(accepted.pending, true);
  await tracker.syncPending();
  assert.equal(github.writes.length, 0, 'no partial GitHub changes after a conflict');
  assert.equal(store.state.pendingWrites[0].status, 'conflict');
  assert.deepEqual(savedRecords(github).map(entry => entry.taskUrl), [existing.taskUrl]);
});
