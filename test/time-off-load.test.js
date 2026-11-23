import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { classifyTimeOffRecords } from '../src/domain/time-off.js';
import { loadDestinationRecords } from '../src/services/reports.js';

const worker = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
const start = worker.indexOf('async function loadMyTimeOff(');
const end = worker.indexOf('async function loadTaskParticipants(', start);
if (start < 0 || end < 0) throw new Error('Could not find personal PTO loader');

test('personal PTO loads complete history instead of silently clipping distant groups', async () => {
  const taskUrl = 'https://github.com/acme/work/issues/7';
  const source = [
    { id: '01K2ABCDEA0123456789ABCDEF', user: 'alice', entryDate: '2024-01-15',
      taskUrl, endedAt: '2024-01-15T17:00:00Z', startedAt: '2024-01-15T09:00:00Z',
      metadata: { billable: true } },
    { id: '01K2ABCDEB0123456789ABCDEF', user: 'alice', entryDate: '2029-12-15',
      taskUrl, endedAt: '2029-12-15T17:00:00Z', startedAt: '2029-12-15T09:00:00Z',
      metadata: { billable: true } },
  ];
  const calls = [], destination = { id: 'github:1', owner: 'acme', repo: 'time', label: 'acme/time' };
  class ReportService {
    async loadUserRange(range, user, options, budgets) {
      calls.push({ range, user, options, budgets });
      return source;
    }
  }
  const context = vm.createContext({
    store: {}, ReportService, classifyTimeOffRecords, loadDestinationRecords,
    withoutInternalMetadata: entry => entry,
    configuredSnapshot: async () => ({ auth: { githubLogin: 'alice' } }),
    selectReadDestinations: () => [destination],
    destinationUser: async () => 'alice',
    githubForConfig: () => ({}),
    timeOffSettingsForDestination: async () => ({ config: { version: 1, taskUrls: [taskUrl] } }),
    trackerForDestination: async () => ({ projectActivityRecords: async records => ({ records }) }),
  });
  vm.runInContext(worker.slice(start, end), context);
  const origin = 'chrome-extension://clockoli/';
  const result = await context.loadMyTimeOff({ type: 'LOAD_MY_TIME_OFF' },
    { url: origin + 'src/time-off/time-off.html' }, origin);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].range.startDate, '0001-01-01');
  assert.equal(calls[0].range.endDate, '9999-12-31');
  assert.ok(calls[0].budgets.maxFiles > 13, 'a normal one-year report budget would truncate PTO history');
  assert.equal(calls[0].user, 'alice');
  assert.deepEqual(result.entries.map(entry => entry.entryDate), ['2024-01-15', '2029-12-15']);
  assert.ok(result.entries.every(entry => entry.isTimeOff && entry.metadata.billable === false));
  await assert.rejects(() => context.loadMyTimeOff({
    type: 'LOAD_MY_TIME_OFF', startDate: '2026-01-01', endDate: '2026-12-31',
  }, { url: origin + 'src/time-off/time-off.html' }, origin), /Only Time off/);
});
