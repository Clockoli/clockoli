import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackerService } from '../src/services/tracker.js';
import { createUlid } from '../src/domain/ulid.js';
import { normalizeTimeOffChange } from '../src/domain/time-off.js';
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

test('editing PTO in another device time zone preserves original instants and zone', async () => {
  const { github, store } = setup();
  const tracker = new TrackerService({ github, store, user: 'alice', timezone: 'Asia/Tokyo',
    clock, idFactory: timestamp => createUlid(timestamp) });
  const first = await tracker.queueTimeOffChange(payload(rows(['2027-03-26']), { timezone: 'Europe/Amsterdam' }));
  assert.equal(first.entries[0].startedAt, '2027-03-26T08:00:00.000Z');
  await tracker.syncPending();
  const path = 'times/2027-03/alice.jsonl';
  const file = github.files.get(path);
  const original = parseMonthlyRecords(file.text, { user: 'alice', month: '2027-03', path, sha: file.sha });
  const edit = await tracker.queueTimeOffChange(payload(rows(['2027-03-26', '2027-03-29']), {
    timezone: 'Europe/Amsterdam', groupId: first.groupId, previous: previous(original),
    description: 'Updated in Tokyo',
  }));
  assert.deepEqual(edit.entries.map(item => item.startedAt), [
    '2027-03-26T08:00:00.000Z', '2027-03-29T07:00:00.000Z',
  ]);
  assert.ok(edit.entries.every(item => item.timezone === 'Europe/Amsterdam'));
  await tracker.syncPending();
  assert.equal(store.state.pendingWrites.length, 0);
  const updated = parseMonthlyRecords(github.files.get(path).text, {
    user: 'alice', month: '2027-03', path, sha: github.files.get(path).sha,
  });
  assert.deepEqual(updated.map(item => item.startedAt), [
    '2027-03-26T08:00:00.000Z', '2027-03-29T07:00:00.000Z',
  ]);
});

test('editing the second occurrence of a repeated DST hour does not shift its instant', async () => {
  const { tracker } = setup();
  const prior = {
    id: createUlid(Date.parse('2027-10-31T01:30:00Z')), date: '2027-10-31',
    startedAt: '2027-10-31T01:30:00.000Z', endedAt: '2027-10-31T02:30:00.000Z',
    updatedAt: '2027-10-31T02:30:00.000Z',
  };
  const result = await tracker.queueTimeOffChange(payload([{
    date: prior.date, startTime: '02:30', durationSeconds: 3600,
  }], { timezone: 'Europe/Amsterdam', previous: [prior] }));
  assert.equal(result.entries[0].startedAt, prior.startedAt);
});

function seedRemoteWork(github, startedAt, endedAt) {
  const month = startedAt.slice(0, 7);
  const path = `times/${month}/alice.jsonl`;
  const active = buildActiveTimer({
    user: 'alice', taskUrl: 'https://github.com/acme/work/issues/13',
    id: createUlid(Date.parse(startedAt)), startedAt, timezone: 'UTC',
  });
  const entry = buildEntry({ active, endedAt });
  github.files.set(path, { sha: 'work-1', text: serializeMonthlyRecords([entry]) });
  github.files.set(TASK_INDEX_PATH, { sha: 'index-1',
    text: serializeTaskIndex(applyTaskIndexChanges(emptyTaskIndex('alice'), { add: [entry] })) });
  return entry;
}

test('automatic PTO uses locally known work intervals without network reads', async () => {
  const { github, store, tracker } = setup();
  const work = seedRemoteWork(github, '2026-12-07T09:00:00Z', '2026-12-07T12:00:00Z');
  await tracker.rememberTimeOffOccupancy([work]);
  const result = await tracker.queueTimeOffChange(payload([{
    date: '2026-12-07', durationSeconds: 4 * 3600,
  }]));
  assert.equal(result.entries[0].startedAt, '2026-12-07T12:00:00.000Z');
  assert.deepEqual(store.state.pendingWrites[0].autoDates, ['2026-12-07']);
  assert.equal(github.writes.length, 0);
  await tracker.syncPending();
  assert.equal(github.writes.length, 1);
  assert.deepEqual(savedRecords(github).map(entry => entry.startedAt), [
    '2026-12-07T09:00:00.000Z', '2026-12-07T12:00:00.000Z',
  ]);
});

test('automatic PTO refuses a day with no continuous free interval', async () => {
  const { github, store, tracker } = setup();
  const work = seedRemoteWork(github, '2026-12-07T09:00:00Z', '2026-12-07T23:00:00Z');
  await tracker.rememberTimeOffOccupancy([work]);
  await assert.rejects(tracker.queueTimeOffChange(payload([{
    date: '2026-12-07', durationSeconds: 8 * 3600,
  }])), /No free 8-hour interval on 2026-12-07/);
  assert.equal(store.state.pendingWrites.length, 0);
  assert.equal(github.writes.length, 0);
});

test('automatic PTO replans against previously unseen GitHub work before atomic sync', async () => {
  const { github, store, tracker } = setup();
  const added = await tracker.queueTimeOffChange(payload([{
    date: '2026-12-07', durationSeconds: 4 * 3600,
  }]));
  assert.equal(added.entries[0].startedAt, '2026-12-07T09:00:00.000Z');
  seedRemoteWork(github, '2026-12-07T09:00:00Z', '2026-12-07T12:00:00Z');
  await tracker.syncPending();
  assert.equal(store.state.pendingWrites.length, 0);
  assert.equal(github.writes.length, 1);
  assert.deepEqual(savedRecords(github).map(entry => entry.startedAt), [
    '2026-12-07T09:00:00.000Z', '2026-12-07T12:00:00.000Z',
  ]);
});

test('remote work that fills the day leaves an automatic PTO conflict for review', async () => {
  const { github, store, tracker } = setup();
  await tracker.queueTimeOffChange(payload([{
    date: '2026-12-07', durationSeconds: 8 * 3600,
  }]));
  seedRemoteWork(github, '2026-12-07T09:00:00Z', '2026-12-07T23:00:00Z');
  await tracker.syncPending();
  assert.equal(store.state.pendingWrites.length, 1);
  assert.equal(store.state.pendingWrites[0].status, 'conflict');
  assert.match(store.state.pendingWrites[0].lastError, /No free 8-hour interval/);
  assert.equal(github.writes.length, 0);
});


test('deleting one day of a grouped PTO keeps all other planned dates unchanged', async () => {
  const { github, tracker, store } = setup();
  const group = await tracker.queueTimeOffChange(payload(rows([
    '2026-12-07', '2026-12-08', '2026-12-09',
  ])));
  await tracker.syncPending();
  const before = savedRecords(github);
  const removed = before.find(item => item.entryDate === '2026-12-08');
  const untouched = before.filter(item => item.id !== removed.id);
  const accepted = await tracker.queueTimeOffChange(payload([], {
    groupId: group.groupId, previous: previous([removed]), singleDayDeletion: true,
  }));
  assert.equal(accepted.pending, true);
  assert.equal(accepted.entries.length, 0);
  assert.equal(github.writes.length, 1, 'delete must be accepted locally first');
  assert.equal(store.state.pendingWrites[0].singleDayDeletion, true);
  await tracker.syncPending();
  assert.equal(github.writes.length, 2, 'one atomic commit removes just the requested day');
  assert.equal(store.state.pendingWrites.length, 0);
  const current = savedRecords(github);
  assert.deepEqual(current.map(item => item.entryDate), ['2026-12-07', '2026-12-09']);
  const identity = entry => ({
    id: entry.id, entryDate: entry.entryDate, startedAt: entry.startedAt,
    endedAt: entry.endedAt, updatedAt: entry.updatedAt, description: entry.description,
    groupId: entry.metadata?.clockoli?.timeOffGroupId,
  });
  assert.deepEqual(current.map(identity), untouched.map(identity),
    'sibling records keep their IDs and timestamps, although their file SHA changes');
});

test('deleting a taken day does not alter future days from the same PTO group', async () => {
  const { github, tracker, store } = setup();
  const group = await tracker.queueTimeOffChange(payload(rows(['2026-11-10', '2026-12-07'])));
  await tracker.syncPending();
  const path = 'times/2026-11/alice.jsonl';
  const november = github.files.get(path);
  const taken = parseMonthlyRecords(november.text, {
    user: 'alice', month: '2026-11', path, sha: november.sha,
  })[0];
  const future = savedRecords(github)[0];
  await tracker.queueTimeOffChange(payload([], {
    groupId: group.groupId, previous: previous([taken]), singleDayDeletion: true,
  }));
  await tracker.syncPending();
  assert.equal(github.files.has(path), false);
  assert.deepEqual(savedRecords(github), [future]);
  assert.equal(store.state.pendingWrites.length, 0);
});

test('single-day PTO deletion rejects stale remote entry and leaves the group intact', async () => {
  const { github, tracker, store } = setup();
  const group = await tracker.queueTimeOffChange(payload(rows(['2026-12-07', '2026-12-08'])));
  await tracker.syncPending();
  const originals = savedRecords(github);
  await tracker.queueTimeOffChange(payload([], {
    groupId: group.groupId, previous: previous([originals[0]]), singleDayDeletion: true,
  }));
  const path = 'times/2026-12/alice.jsonl', file = github.files.get(path);
  github.files.set(path, { sha: 'changed-revision',
    text: serializeMonthlyRecords(originals.map(item =>
      item.id === originals[0].id ? { ...item, updatedAt: '2026-12-10T12:00:00.000Z' } : item)),
  });
  await tracker.syncPending();
  assert.equal(store.state.pendingWrites.length, 1);
  assert.equal(store.state.pendingWrites[0].status, 'conflict');
  assert.equal(savedRecords(github).length, 2);
});


test('selected PTO days across independent tasks and groups delete in one guarded commit', async () => {
  const { github, tracker, store } = setup();
  const first = await tracker.queueTimeOffChange(payload(rows([
    '2026-12-07', '2026-12-08',
  ])));
  await tracker.syncPending();
  const second = await tracker.queueTimeOffChange(payload(rows([
    '2026-12-09', '2026-12-10',
  ]), { taskUrl: 'https://github.com/acme/work/issues/8' }));
  await tracker.syncPending();
  assert.equal(github.writes.length, 2);
  const records = savedRecords(github);
  const removed = records.filter(entry => ['2026-12-07', '2026-12-09'].includes(entry.entryDate));
  const retained = records.filter(entry => !removed.some(item => item.id === entry.id));
  const previousBatch = removed.map(entry => ({
    ...previous([entry])[0], taskUrl: entry.taskUrl,
    groupId: entry.metadata.clockoli.timeOffGroupId,
  }));
  const queued = await tracker.queueTimeOffChange(payload([], {
    groupId: null, previous: previousBatch, bulkDayDeletion: true,
  }));
  assert.equal(queued.pending, true);
  assert.equal(queued.entries.length, 0);
  assert.equal(store.state.pendingWrites.length, 1);
  assert.equal(store.state.pendingWrites[0].bulkDayDeletion, true);
  assert.equal(github.writes.length, 2);
  await tracker.syncPending();
  assert.equal(github.writes.length, 3, 'one commit removes selected dates from both groups');
  assert.equal(store.state.pendingWrites.length, 0);
  const durable = savedRecords(github);
  assert.deepEqual(durable.map(entry => entry.entryDate), ['2026-12-08', '2026-12-10']);
  const stable = entry => ({
    id: entry.id, startedAt: entry.startedAt, endedAt: entry.endedAt,
    taskUrl: entry.taskUrl, updatedAt: entry.updatedAt,
    groupId: entry.metadata?.clockoli?.timeOffGroupId,
  });
  assert.deepEqual(durable.map(stable), retained.map(stable));
  assert.ok(durable.some(entry => entry.metadata.clockoli.timeOffGroupId === first.groupId));
  assert.ok(durable.some(entry => entry.metadata.clockoli.timeOffGroupId === second.groupId));
});

test('batch time off deletion cannot remove a remotely changed entry or unrelated grouped day', async () => {
  const { github, tracker, store } = setup();
  const batch = await tracker.queueTimeOffChange(payload(rows(['2026-12-07', '2026-12-08', '2026-12-09'])));
  await tracker.syncPending();
  const originals = savedRecords(github);
  const selected = originals.slice(0, 2);
  const marked = selected.map(entry => ({
    ...previous([entry])[0], taskUrl: entry.taskUrl,
    groupId: batch.groupId,
  }));
  await tracker.queueTimeOffChange(payload([], {
    previous: marked, bulkDayDeletion: true,
  }));
  const path = 'times/2026-12/alice.jsonl';
  const file = github.files.get(path);
  github.files.set(path, {
    sha: 'other-device-updated',
    text: serializeMonthlyRecords(originals.map(entry => entry.id === selected[0].id
      ? { ...entry, updatedAt: '2026-12-12T09:00:00.000Z' } : entry)),
  });
  await tracker.syncPending();
  assert.equal(store.state.pendingWrites.length, 1);
  assert.equal(store.state.pendingWrites[0].status, 'conflict');
  assert.equal(github.writes.length, 1, 'no partial removal on stale remote data');
  assert.equal(savedRecords(github).length, 3);
  assert.ok(savedRecords(github).some(entry => entry.entryDate === '2026-12-09'));
});

test('bulk PTO deletion validates its record limit and exact task and group markers', () => {
  const make = index => ({
    id: createUlid(Date.parse('2026-12-07T10:00:00Z') + index),
    date: '2026-12-07', startedAt: '2026-12-07T09:00:00Z',
    endedAt: '2026-12-07T17:00:00Z', updatedAt: '2026-12-07T18:00:00Z',
    taskUrl, groupId: null,
  });
  const many = Array.from({ length: 201 }, (_, i) => make(i));
  assert.throws(() => normalizeTimeOffChange(payload([], {
    previous: many, bulkDayDeletion: true,
  })), /Invalid previous time off entries/);
  assert.throws(() => normalizeTimeOffChange(payload([], {
    previous: [{ ...make(0), taskUrl: '' }], bulkDayDeletion: true,
  })), /Invalid task URL|Invalid/);
  assert.throws(() => normalizeTimeOffChange(payload([], {
    previous: [{ ...make(0), groupId: 'bogus' }], bulkDayDeletion: true,
  })), /Bulk time off deletion/);
});


test('PTO added and deleted locally before any GitHub sync never remains remotely', async () => {
  const { github, tracker, store } = setup();
  const created = await tracker.queueTimeOffChange(payload([{
    date: '2026-12-07', durationSeconds: 4 * 3600,
  }, { date: '2026-12-08', durationSeconds: 4 * 3600 }]));
  assert.ok(created.entries.every(entry => entry._pending));
  const canceled = created.entries.find(entry => entry.entryDate === '2026-12-07');
  const removed = await tracker.queueTimeOffChange(payload([], {
    groupId: created.groupId, previous: previous([canceled]), singleDayDeletion: true,
  }));
  assert.equal(removed.pending, true);
  assert.equal(github.writes.length, 0);
  assert.equal(store.state.pendingWrites.length, 2);
  const projected = await tracker.projectActivityRecords([]);
  assert.deepEqual(projected.records.map(entry => entry.entryDate), ['2026-12-08'],
    'calendar hides canceled pending PTO immediately');
  await tracker.syncPending();
  assert.equal(store.state.pendingWrites.length, 0);
  assert.equal(github.writes.length, 2, 'add and dependent delete flush in FIFO order');
  assert.deepEqual(savedRecords(github).map(entry => entry.entryDate), ['2026-12-08']);
});

test('PTO deletion follows an automatically replanned pending creation', async () => {
  const { github, tracker, store } = setup();
  const created = await tracker.queueTimeOffChange(payload([{
    date: '2026-12-07', durationSeconds: 4 * 3600,
  }]));
  const original = created.entries[0];
  assert.equal(original.startedAt, '2026-12-07T09:00:00.000Z');
  await tracker.queueTimeOffChange(payload([], {
    groupId: created.groupId, previous: previous([original]), singleDayDeletion: true,
  }));
  seedRemoteWork(github, '2026-12-07T09:00:00Z', '2026-12-07T12:00:00Z');
  await tracker.syncPending();
  assert.equal(store.state.pendingWrites.length, 0,
    'dependent deletion must use the replanned 12:00 start, not stale 09:00');
  assert.equal(github.writes.length, 2);
  assert.deepEqual(savedRecords(github).map(entry => entry.startedAt),
    ['2026-12-07T09:00:00.000Z']);
});

test('PTO queued while its creation is already in-flight deletes after that commit', async () => {
  const { github, tracker, store } = setup();
  const created = await tracker.queueTimeOffChange(payload([{
    date: '2026-12-07', durationSeconds: 4 * 3600,
  }]));
  const originalAtomic = github.updateTextsAtomic.bind(github);
  let inserted = false;
  github.updateTextsAtomic = async (...args) => {
    if (!inserted) {
      inserted = true;
      await tracker.queueTimeOffChange(payload([], {
        groupId: created.groupId,
        previous: previous(created.entries),
        singleDayDeletion: true,
      }));
      assert.equal(github.writes.length, 0);
      assert.equal(store.state.pendingWrites.length, 2);
    }
    return originalAtomic(...args);
  };
  await tracker.syncPending();
  assert.equal(inserted, true);
  assert.equal(store.state.pendingWrites.length, 1,
    'new deletion stays locally queued when it was appended during the active sync');
  assert.equal(store.state.pendingWrites[0].singleDayDeletion, true);
  await tracker.syncPending();
  assert.equal(store.state.pendingWrites.length, 0);
  assert.equal(github.writes.length, 2);
  assert.deepEqual(savedRecords(github), []);
});

test('multi-day PTO deletion accepts a mix of pending additions and remote entries', async () => {
  const { github, tracker, store } = setup();
  const existing = await tracker.queueTimeOffChange(payload([{
    date: '2026-12-07', durationSeconds: 4 * 3600,
  }]));
  await tracker.syncPending();
  const saved = savedRecords(github)[0];
  const newGroup = await tracker.queueTimeOffChange(payload([{
    date: '2026-12-08', durationSeconds: 4 * 3600,
  }, { date: '2026-12-09', durationSeconds: 4 * 3600 }]));
  const pending = newGroup.entries.find(entry => entry.entryDate === '2026-12-08');
  const originals = [saved, pending].map(entry => ({
    ...previous([entry])[0], taskUrl: entry.taskUrl,
    groupId: entry.metadata.clockoli.timeOffGroupId,
  }));
  await tracker.queueTimeOffChange(payload([], {
    previous: originals, bulkDayDeletion: true,
  }));
  assert.equal(github.writes.length, 1);
  assert.equal(store.state.pendingWrites.length, 2);
  const projected = await tracker.projectActivityRecords([saved]);
  assert.deepEqual(projected.records.map(entry => entry.entryDate), ['2026-12-09']);
  await tracker.syncPending();
  assert.equal(store.state.pendingWrites.length, 0);
  assert.equal(github.writes.length, 3);
  assert.deepEqual(savedRecords(github).map(entry => entry.entryDate), ['2026-12-09']);
  assert.ok(savedRecords(github)[0].metadata.clockoli.timeOffGroupId === newGroup.groupId);
  assert.notEqual(newGroup.groupId, existing.groupId);
});

test('failed pending PTO creation blocks the dependent deletion without losing either operation', async () => {
  const { github, tracker, store } = setup();
  const created = await tracker.queueTimeOffChange(payload([{
    date: '2026-12-07', durationSeconds: 8 * 3600,
  }]));
  await tracker.queueTimeOffChange(payload([], {
    groupId: created.groupId, previous: previous(created.entries), singleDayDeletion: true,
  }));
  seedRemoteWork(github, '2026-12-07T09:00:00Z', '2026-12-07T23:00:00Z');
  await tracker.syncPending();
  assert.equal(github.writes.length, 0);
  assert.equal(store.state.pendingWrites.length, 2);
  assert.equal(store.state.pendingWrites[0].status, 'conflict');
  assert.deepEqual((await tracker.projectActivityRecords([])).records.map(row => row.entryDate), [],
    'optimistically deleted PTO stays hidden even while its creation conflicts');
});
