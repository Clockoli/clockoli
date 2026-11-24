import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { annualTimeOffDays } from '../src/domain/time-off-year.js';
import { classifyTimeOffRecords } from '../src/domain/time-off.js';

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
    ReportService, store: {},
    configuredSnapshot: async () => ({ auth: { githubLogin: 'alice' } }),
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
  await assert.rejects(() => context.loadTeamTimeOff({
    type: 'LOAD_TEAM_TIME_OFF', startDate: '2027-01-01', endDate: '2028-01-01',
  }, sender, origin), /one calendar year/);
  await assert.rejects(() => context.loadTeamTimeOff({
    type: 'LOAD_TEAM_TIME_OFF', startDate: '2027-01-01', endDate: '2027-12-31',
  }, { url: origin + 'src/reports/reports.html' }, origin), /Only Time off/);
});
