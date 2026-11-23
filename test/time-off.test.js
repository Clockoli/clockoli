import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TIME_OFF_TASKS, normalizeTimeOffConfig, parseTimeOffConfig,
  serializeTimeOffConfig, classifyTimeOffRecords, isTimeOffTask,
} from '../src/domain/time-off.js';

test('shared time off task URLs are normalized and limited per repository', () => {
  const url = 'https://github.com/acme/repo/issues/12';
  const parsed = parseTimeOffConfig(serializeTimeOffConfig([url + '?utm=campaign']));
  assert.deepEqual(parsed.taskUrls, [url]);
  assert.equal(isTimeOffTask(url, parsed), true);
  assert.throws(() => normalizeTimeOffConfig({ version: 1, taskUrls: [url, url + '?x=1'] }), /Duplicate/);
  assert.throws(() => normalizeTimeOffConfig({ version: 1, taskUrls: Array.from({ length: MAX_TIME_OFF_TASKS + 1 }, (_, i) => 'https://example.com/' + i) }), /100/);
  for (const value of [{ version: 2, taskUrls: [] }, { version: 1, taskUrls: [], extra: true }]) {
    assert.throws(() => normalizeTimeOffConfig(value), /Invalid/);
  }
  assert.throws(() => parseTimeOffConfig('{broken'), /JSON/);
});

test('same task in another destination remains work; PTO is non-billable in report projection', () => {
  const url = 'https://github.com/acme/repo/issues/12';
  const future = { destinationId: 'github:1', taskUrl: url, endedAt: '2026-12-10T17:00:00.000Z', metadata: { billable: true }, durationSeconds: 28800 };
  const other = { ...future, destinationId: 'github:2' };
  const map = { 'github:1': { version: 1, taskUrls: [url] }, 'github:2': { version: 1, taskUrls: [] } };
  const [planned, work] = classifyTimeOffRecords([future, other], map, new Date('2026-12-01T00:00:00.000Z'));
  assert.equal(planned.isTimeOff, true);
  assert.equal(planned.isPlannedTimeOff, true);
  assert.equal(planned.metadata.billable, false);
  assert.equal(future.metadata.billable, true);
  assert.equal(work.isTimeOff, undefined);
  const [taken] = classifyTimeOffRecords([future], map, new Date('2026-12-11T00:00:00.000Z'));
  assert.equal(taken.isPlannedTimeOff, false);
});
