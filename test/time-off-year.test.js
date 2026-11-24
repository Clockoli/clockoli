import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { annualTimeOffDays } from '../src/domain/time-off-year.js';
import { ChromeStore } from '../src/storage/chrome-store.js';
import { classifyTimeOffRecords } from '../src/domain/time-off.js';
import { TEAM_TIME_OFF_YEAR_CACHE_KEY, teamTimeOffCacheScope, readCachedTeamTimeOff,
  saveCachedTeamTimeOff, invalidateCachedTeamTimeOff } from '../src/services/time-off-year-cache.js';

class MemoryYearCache {
  constructor() { this.data = {}; }
  async getMany(keys) {
    return Object.fromEntries(keys.filter(key => key in this.data).map(key => [key, this.data[key]]));
  }
  async mutateMany(keys, callback) {
    const change = callback(await this.getMany(keys));
    for (const key of change.delete ?? []) delete this.data[key];
    Object.assign(this.data, change.set ?? {});
    return change.result;
  }
  async deleteMany(keys) { for (const key of keys) delete this.data[key]; }
}

const PTO = 'https://github.com/acme/team/issues/15';
const record = (id, user, date, endedAt, destinationId = 'github:1') => ({
  id, user, entryDate: date, startedAt: date + 'T09:00:00.000Z',
  endedAt, destinationId, taskUrl: PTO, isTimeOff: true, durationSeconds: 28800,
});

test('annual heatmap counts unique users per day across entries and repositories', () => {
  const source = [
    record('a', 'Alice', '2027-03-12', '2027-03-12T17:00:00Z'),
    record('b', 'alice', '2027-03-12', '2027-03-12T18:00:00Z', 'github:2'),
    record('c', 'Bob', '2027-03-12', '2027-03-12T17:00:00Z'),
    record('d', 'Bob', '2027-04-12', '2027-04-12T17:00:00Z'),
    record('e', 'Alice', '2028-03-12', '2028-03-12T17:00:00Z'),
    { ...record('f', 'Mia', '2027-03-12', '2027-03-12T17:00:00Z'), isTimeOff: false },
  ];
  const grouped = annualTimeOffDays(source, 2027, { 'github:1': 'alice' }, '2027-03-11T12:00:00Z');
  const day = grouped.get('2027-03-12');
  assert.equal(day.count, 2);
  assert.deepEqual(day.people.map(person => person.user.toLowerCase()), ['alice', 'bob']);
  assert.equal(day.own, true);
  assert.equal(day.planned, true);
  assert.equal(day.people[0].entries.length, 2);
  assert.equal(day.people[0].seconds, 57600);
  assert.equal(grouped.get('2027-04-12').count, 1);
  assert.equal(grouped.has('2028-03-12'), false);
  const past = annualTimeOffDays(source, 2027, {}, '2027-05-01T00:00:00Z').get('2027-03-12');
  assert.equal(past.planned, false);
  assert.equal(past.taken, true);
  assert.throws(() => annualTimeOffDays(source, 0), /Invalid Time off year/);
});

test('team PTO loader fetches one complete year, honors task configuration and rejects wider requests', async () => {
  const worker = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  const start = worker.indexOf('async function loadTeamTimeOff(');
  const end = worker.indexOf('async function loadMyTimeOff(', start);
  assert.ok(start >= 0 && end > start);
  const calls = [], origin = 'chrome-extension://clockoli/';
  const timeOffCacheBackend = new MemoryYearCache();
  let generation = 3;
  const destination = { id: 'github:1', owner: 'acme', repo: 'time', defaultBranch: 'main' };
  class ReportService {
    async loadRepositoryRange(range, options) {
      calls.push({ range, options });
      return [{ ...record('a', 'alice', '2027-01-03', '2027-01-03T17:00:00Z'), isTimeOff: undefined },
        { ...record('b', 'bob', '2027-12-31', '2027-12-31T17:00:00Z'),
          isTimeOff: undefined, taskUrl: 'https://example.com/work' }];
    }
  }
  const context = vm.createContext({
    ReportService, store: {}, timeOffCacheBackend,
    teamTimeOffCacheScope, readCachedTeamTimeOff, saveCachedTeamTimeOff,
    configuredSnapshot: async () => ({
      auth: { githubLogin: 'alice' }, generation, authGeneration: 9,
    }),
    selectReadDestinations: () => [destination],
    githubForConfig: () => ({}),
    timeOffSettingsForDestination: async () => ({ config: { version: 1, taskUrls: [PTO] } }),
    loadDestinationRecords: async (destinations, read) => ({
      records: (await Promise.all(destinations.map(destination => read(destination)))).flat(),
      partial: false, readStatus: [{ destinationId: 'github:1', status: 'ok' }],
    }),
    withoutInternalMetadata: record => record, classifyTimeOffRecords,
  });
  vm.runInContext(worker.slice(start, end), context);
  const sender = { url: origin + 'src/time-off/time-off.html' };
  const result = await context.loadTeamTimeOff({
    type: 'LOAD_TEAM_TIME_OFF', startDate: '2027-01-01', endDate: '2027-12-31',
  }, sender, origin);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].range)),
    { startDate: '2027-01-01', endDate: '2027-12-31' });
  assert.ok(calls[0].options.budgets.maxTotalFiles > 1000);
  assert.equal(result.entries.length, 1, 'unconfigured work tasks are never counted as PTO');
  const cached = await context.loadTeamTimeOff({
    type: 'LOAD_TEAM_TIME_OFF', startDate: '2027-01-01', endDate: '2027-12-31',
  }, sender, origin);
  assert.equal(cached.cached, true);
  assert.equal(calls.length, 1, 'revisiting a year must not scan GitHub again');
  await context.loadTeamTimeOff({
    type: 'LOAD_TEAM_TIME_OFF', startDate: '2027-01-01', endDate: '2027-12-31', refresh: true,
  }, sender, origin);
  assert.equal(calls.length, 2, 'only explicit Refresh scans GitHub again');
  generation = 4;
  await context.loadTeamTimeOff({
    type: 'LOAD_TEAM_TIME_OFF', startDate: '2027-01-01', endDate: '2027-12-31',
  }, sender, origin);
  assert.equal(calls.length, 3, 'configuration changes invalidate the saved year');
  await assert.rejects(() => context.loadTeamTimeOff({
    type: 'LOAD_TEAM_TIME_OFF', startDate: '2027-01-01', endDate: '2028-01-01',
  }, sender, origin), /one calendar year/);
  await assert.rejects(() => context.loadTeamTimeOff({
    type: 'LOAD_TEAM_TIME_OFF', startDate: '2027-01-01', endDate: '2027-12-31',
  }, { url: origin + 'src/reports/reports.html' }, origin), /Only Time off/);
});


test('annual team cache survives reloads and is scoped to connected repos and GitHub login', async () => {
  const backend = new MemoryYearCache();
  const repos = [{ id: 'github:1', owner: 'acme', repo: 'time', branch: 'main' }];
  const snapshot = { generation: 1, authGeneration: 4, auth: { githubLogin: 'alice' } };
  const scope = teamTimeOffCacheScope(snapshot, repos);
  assert.equal(teamTimeOffCacheScope({ ...snapshot, authGeneration: 99 }, repos), scope,
    'rotating OAuth tokens for the same GitHub user must not discard team years');
  assert.notEqual(teamTimeOffCacheScope({ ...snapshot, auth: { mode: 'pat' } }, repos),
    teamTimeOffCacheScope({ ...snapshot, auth: { mode: 'pat' }, authGeneration: 99 }, repos),
    'accounts without a known login must still be isolated by auth generation');
  const view = { configured: true, partial: false, readStatus: [], entries: [
    record('one', 'bob', '2027-03-01', '2027-03-01T17:00:00Z'),
  ] };
  assert.equal(await readCachedTeamTimeOff(backend, scope, 2027), null);
  assert.equal(await saveCachedTeamTimeOff(backend, scope, 2027, view), true);
  assert.equal((await readCachedTeamTimeOff(backend, scope, 2027)).cached, true);
  assert.equal((await readCachedTeamTimeOff(backend, scope, 2027)).entries.length, 1);
  assert.equal(await readCachedTeamTimeOff(backend, scope, 2026), null);
  assert.equal(await readCachedTeamTimeOff(backend,
    teamTimeOffCacheScope({ ...snapshot, auth: { githubLogin: 'bob' } }, repos), 2027), null);
  assert.equal(await readCachedTeamTimeOff(backend,
    teamTimeOffCacheScope(snapshot, [{ ...repos[0], branch: 'different' }]), 2027), null);
  assert.equal(await saveCachedTeamTimeOff(backend, scope, 2028, { ...view, partial: true }), false);
  for (let year = 2028; year < 2034; year++) {
    await saveCachedTeamTimeOff(backend, scope, year, view, year);
  }
  assert.ok(Object.keys(backend.data[TEAM_TIME_OFF_YEAR_CACHE_KEY].years).length <= 5);
  await invalidateCachedTeamTimeOff(backend);
  assert.equal(await readCachedTeamTimeOff(backend, scope, 2033), null);
});


test('disconnecting Clockoli clears cached team absences from local storage', async () => {
  const backend = new MemoryYearCache();
  const store = new ChromeStore(backend);
  const scope = teamTimeOffCacheScope({
    generation: 2, authGeneration: 3, auth: { githubLogin: 'alice' },
  }, [{ id: 'github:1', owner: 'acme', repo: 'time' }]);
  await saveCachedTeamTimeOff(backend, scope, 2027, {
    configured: true, partial: false, entries: [record('a', 'alice',
      '2027-01-02', '2027-01-02T17:00:00Z')],
  });
  assert.equal((await readCachedTeamTimeOff(backend, scope, 2027)).entries.length, 1);
  await store.clearConfig();
  assert.equal(await readCachedTeamTimeOff(backend, scope, 2027), null);
});
