import test from 'node:test';
import assert from 'node:assert/strict';
import { ReportService, combineMergeTaskSummaries } from '../src/services/reports.js';
import { TrackerService } from '../src/services/tracker.js';
import { applyTaskIndexChanges, emptyTaskIndex, serializeTaskIndex, TASK_INDEX_PATH } from '../src/domain/task-index.js';
import { activeRecordPath, serializeActiveRecord, serializeMonthlyRecords } from '../src/domain/work-records.js';
import { buildActiveTimer, buildEntry } from '../src/domain/records.js';
import { userBranchMetadataText } from '../src/services/user-storage-branch.js';

const source = 'https://example.com/old', target = 'https://example.com/new';
const range = { startDate: '1970-01-01', endDate: '2026-11-25' };
const headSha = 'a'.repeat(40);
const record = (user, day, i, taskUrl = source) => {
  const id = '01K2ABCDEF0123456789ABC' + String(i).padStart(3, '0');
  return buildEntry({ active: buildActiveTimer({ user, id, taskUrl, taskTitle: 'Example task',
    startedAt: day + 'T08:00:00Z', timezone: 'UTC' }), endedAt: day + 'T09:00:00Z' });
};
function fixture(user, id, entries) {
  const files = new Map(), reads = [], snapshots = [];
  const add = (path, text) => files.set(path, { path, text, sha: (files.size + 1).toString(16).padStart(40, '0'), size: text.length });
  for (const month of new Set(entries.map(e => e.entryDate.slice(0, 7)))) {
    add('times/' + month + '/' + user + '.jsonl', serializeMonthlyRecords(entries.filter(e => e.entryDate.startsWith(month))));
  }
  add(TASK_INDEX_PATH, serializeTaskIndex(applyTaskIndexChanges(emptyTaskIndex(user), { add: entries })));
  const github = {
    repositoryKey: user,
    async getText(path) {
      assert.equal(path, '.clockoli/user.json');
      return { text: userBranchMetadataText({ id, login: user }) };
    },
    async listTextFilesSnapshot(prefix, options) {
      snapshots.push(options);
      return { headSha, files: [...files.values()].filter(f => f.path.startsWith(prefix)
        || f.path === options.includeActive || options.includePaths?.includes(f.path)) };
    },
    async getBlobText(path, sha) {
      reads.push(path);
      assert.equal(files.get(path)?.sha, sha);
      return files.get(path);
    },
  };
  return { github, reads, snapshots, files };
}
function repoWithPeople(people) {
  const branches = Object.keys(people);
  return { forBranch(branch) { return branch === 'main' ? this : people[branch].github; },
    async listBranchesWithSha() { return branches.map(branch => ({ branch, headSha })); } };
}
function memoryCache() {
  const values = new Map();
  return { async getReportCache(key) { return structuredClone(values.get(key)); },
    async saveReportCache(value) { values.set(value.repositoryKey, structuredClone(value)); } };
}

test('All time uses selected people only and reuses the index for history over 13 months', async () => {
  const old = Array.from({ length: 24 }, (_, i) => {
    const month = String(i % 12 + 1).padStart(2, '0');
    // Unique ULIDs are needed for every historical record.
    return record('alice', (2022 + Math.floor(i / 12)) + '-' + month + '-01', i);
  });
  const alice = fixture('alice', 1, old);
  const bob = fixture('bob', 2, [record('bob', '2024-01-01', 1)]);
  const github = repoWithPeople({ 'clockoli/users/1': alice, 'clockoli/users/2': bob });
  const service = new ReportService({ github, cache: memoryCache() });
  const result = await service.loadMergeTaskCatalog(range, { defaultBranch: 'main', currentUser: 'alice', selectedUsers: ['alice'] });
  assert.deepEqual(result.availableUsers, ['alice', 'bob']);
  assert.equal(result.tasks[0].sessionCount, 24);
  assert.equal(result.tasks[0].totalSeconds, 24 * 3600);
  assert.deepEqual(alice.reads, [TASK_INDEX_PATH]);
  assert.deepEqual(bob.reads, []);
  assert.equal(bob.snapshots.length, 0);
  await service.loadMergeTaskCatalog(range, { defaultBranch: 'main', currentUser: 'alice', selectedUsers: ['alice'] });
  assert.deepEqual(alice.reads, [TASK_INDEX_PATH], 'unchanged index uses cached blob');
});

test('All time excludes future dates in the current month and future monthly files', async () => {
  const alice = fixture('alice', 1, [
    record('alice', '2023-01-01', 0), record('alice', '2026-11-26', 1, target),
    record('alice', '2026-12-01', 2, target),
  ]);
  const service = new ReportService({ github: repoWithPeople({ 'clockoli/users/1': alice }), cache: memoryCache() });
  const result = await service.loadMergeTaskCatalog(range, { defaultBranch: 'main', currentUser: 'alice' });
  assert.deepEqual(result.tasks.map(t => t.taskUrl), [source]);
  assert.equal(result.tasks[0].sessionCount, 1);
  assert.ok(!alice.reads.includes('times/2026-12/alice.jsonl'));
});

test('All time checks the boundary month even when there are no future monthly files', async () => {
  const alice = fixture('alice', 1, [record('alice', '2023-01-01', 0), record('alice', '2026-11-26', 1, target)]);
  const service = new ReportService({ github: repoWithPeople({ 'clockoli/users/1': alice }), cache: memoryCache() });
  const result = await service.loadMergeTaskCatalog(range, { defaultBranch: 'main', currentUser: 'alice' });
  assert.deepEqual(result.tasks.map(t => t.taskUrl), [source]);
  assert.ok(!alice.reads.includes(TASK_INDEX_PATH), 'out-of-range boundary records require exact monthly history');
});

test('short period reads only intersecting months and duplicate record IDs fail closed', async () => {
  const alice = fixture('alice', 1, [record('alice', '2023-01-01', 0), record('alice', '2026-11-01', 1, target)]);
  const service = new ReportService({ github: repoWithPeople({ 'clockoli/users/1': alice }), cache: memoryCache() });
  const result = await service.loadMergeTaskCatalog({ startDate: '2026-11-01', endDate: '2026-11-25' },
    { defaultBranch: 'main', currentUser: 'alice' });
  assert.deepEqual(result.tasks.map(t => t.taskUrl), [target]);
  assert.deepEqual(alice.reads, ['times/2026-11/alice.jsonl']);
  const item = { taskUrl: source, totalSeconds: 1, recordIds: ['same'] };
  assert.throws(() => combineMergeTaskSummaries([[item], [item]]), /duplicate/i);
});

test('merge scans only existing files and updates the index atomically against the snapshot head', async () => {
  const alice = fixture('alice', 1, [record('alice', '2021-02-01', 0), record('alice', '2026-11-01', 1)]);
  const writes = [];
  alice.github.updateTextsAtomic = async (changes, message, options) => {
    writes.push({ changes, options });
    return { blobShas: Object.fromEntries(changes.map(c => [c.path, 'b'.repeat(40)])) };
  };
  const store = { async getState() { return { pendingWrites: [], recentCache: [] }; }, async patchState() {} };
  const tracker = new TrackerService({ github: alice.github, store, user: 'alice', timezone: 'UTC' });
  const result = await tracker.mergeTasks({ ...range, pairs: [{ sourceTaskUrl: source, targetTaskUrl: target }] });
  assert.equal(result.mergedEntries, 2);
  assert.deepEqual(alice.reads.sort(), [TASK_INDEX_PATH, 'times/2021-02/alice.jsonl', 'times/2026-11/alice.jsonl'].sort());
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.expectedHeadSha, headSha);
  const index = JSON.parse(writes[0].changes.find(c => c.path === TASK_INDEX_PATH).text);
  assert.equal(index.tasks[target].sessionCount, 2);
  assert.equal(index.tasks[source], undefined);
});

test('active-only merge uses an atomic index guard and the snapshot head', async () => {
  const alice = fixture('alice', 1, []);
  const path = activeRecordPath('alice');
  const active = buildActiveTimer({ user: 'alice', id: '01K2ABCDEF0123456789ABC001', taskUrl: source,
    startedAt: '2026-11-25T08:00:00Z', timezone: 'UTC' });
  alice.files.set(path, { path, sha: 'c'.repeat(40), text: serializeActiveRecord(active) });
  const writes = [];
  alice.github.updateTextsAtomic = async (changes, message, options) => {
    writes.push({ changes, options });
    return { blobShas: { [path]: 'd'.repeat(40) } };
  };
  const store = { async getState() { return { pendingWrites: [], recentCache: [] }; }, async patchState() {} };
  const tracker = new TrackerService({ github: alice.github, store, user: 'alice', timezone: 'UTC' });
  const result = await tracker.mergeTasks({ ...range, pairs: [{ sourceTaskUrl: source, targetTaskUrl: target }] });
  assert.deepEqual(result, { mergedEntries: 0, mergedActive: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].changes.length, 1);
  assert.equal(writes[0].options.expectedHeadSha, headSha);
  assert.equal(writes[0].options.guards[0].path, TASK_INDEX_PATH);
});
