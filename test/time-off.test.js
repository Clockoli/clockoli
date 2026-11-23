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

import { buildActiveTimer, buildEntry, applyEntryEdits } from '../src/domain/records.js';

test('planned PTO stays editable before its future activity start', () => {
  const active = buildActiveTimer({
    user: 'alice', taskUrl: 'https://example.com/time-off',
    startedAt: '2026-12-07T09:00:00.000Z', timezone: 'UTC',
  });
  const planned = buildEntry({ active, endedAt: '2026-12-07T17:00:00.000Z' });
  const edited = applyEntryEdits(planned, { description: 'Vacation' }, new Date('2026-11-23T12:00:00.000Z'));
  assert.equal(edited.description, 'Vacation');
  assert.equal(edited.startedAt, planned.startedAt);
  assert.equal(edited.endedAt, planned.endedAt);
  assert.ok(Date.parse(edited.updatedAt) >= Date.parse(edited.createdAt));
  assert.ok(Date.parse(edited.updatedAt) >= Date.parse(planned.updatedAt));
});


import { normalizeTimeOffDays, normalizeTimeOffChange, groupTimeOffRecords, timeOffGroupId, timeOffWallClock, timeOffStartInstant } from '../src/domain/time-off.js';

test('exact PTO day schedule rejects duplicate dates, invalid hours, and overlong groups', () => {
  const days = [
    { date: '2026-12-07', startTime: '09:00', durationSeconds: 28800 },
    { date: '2026-12-08', startTime: '09:00', durationSeconds: 14400 },
  ];
  assert.deepEqual(normalizeTimeOffDays(days), days);
  assert.throws(() => normalizeTimeOffDays([...days, days[1]]), /unique/);
  assert.throws(() => normalizeTimeOffDays([{ ...days[0], durationSeconds: 86400 }]), /selected day/);
  assert.throws(() => normalizeTimeOffDays([{ ...days[0], date: '2026-02-30' }]), /Invalid/);
  assert.throws(() => normalizeTimeOffDays(Array.from({ length: 51 }, (_, n) => ({
    date: '2026-12-' + String(n + 1).padStart(2, '0'), durationSeconds: 3600,
  }))), /50/);
  const edit = normalizeTimeOffChange({ taskUrl: 'https://github.com/acme/work/issues/7',
    taskTitle: 'Vacation', description: '', groupId: null, previous: [], days });
  assert.equal(edit.days.length, 2);
  assert.throws(() => normalizeTimeOffChange({ ...edit, days: [] }), /between 1 and 50/);
});

test('one group ID yields one PTO card; legacy records stay separate', () => {
  const id = '01K2ABCDEF0123456789ABCDEF';
  const taskUrl = 'https://github.com/acme/work/issues/7';
  const entries = [
    { id: '01K2ABCDEA0123456789ABCDEF', destinationId: 'github:1', user: 'alice',
      entryDate: '2026-12-07', startedAt: '2026-12-07T09:00:00Z', endedAt: '2026-12-07T17:00:00Z',
      durationSeconds: 28800, isTimeOff: true, taskUrl, metadata: { clockoli: { timeOffGroupId: id } } },
    { id: '01K2ABCDEX0123456789ABCDEF', destinationId: 'github:1', user: 'alice',
      entryDate: '2026-12-08', startedAt: '2026-12-08T09:00:00Z', endedAt: '2026-12-08T17:00:00Z',
      durationSeconds: 28800, isTimeOff: true, taskUrl, metadata: { clockoli: { timeOffGroupId: id } } },
    { id: '01K2ABCDEFG0123456789ABCDEF', destinationId: 'github:1', user: 'alice',
      entryDate: '2026-12-10', startedAt: '2026-12-10T09:00:00Z', endedAt: '2026-12-10T17:00:00Z',
      durationSeconds: 28800, isTimeOff: true, taskUrl, metadata: {} },
  ];
  assert.equal(timeOffGroupId(entries[0]), id);
  const grouped = groupTimeOffRecords(entries, new Date('2026-12-09T12:00:00Z'));
  assert.equal(grouped.length, 2);
  const group = grouped.find(item => item.groupId === id);
  assert.equal(group.entries.length, 2);
  assert.equal(group.taken.length, 2);
  assert.equal(group.planned.length, 0);
  assert.equal(group.totalSeconds, 57600);
  assert.equal(grouped.find(item => item.groupId === null).entries.length, 1);
});

test('PTO uses its saved time zone across DST transitions and rejects nonexistent local times', () => {
  assert.equal(timeOffStartInstant('2027-03-26', '09:00', 'Europe/Amsterdam').toISOString(),
    '2027-03-26T08:00:00.000Z');
  assert.equal(timeOffStartInstant('2027-03-29', '09:00', 'Europe/Amsterdam').toISOString(),
    '2027-03-29T07:00:00.000Z');
  assert.equal(timeOffWallClock('2027-03-29T07:00:00.000Z', 'Europe/Amsterdam'), '09:00');
  assert.equal(timeOffStartInstant('2027-10-31', '02:30', 'Europe/Amsterdam').toISOString(),
    '2027-10-31T00:30:00.000Z', 'new ambiguous times use the earlier occurrence');
  assert.throws(() => timeOffStartInstant('2027-03-28', '02:30', 'Europe/Amsterdam'),
    /does not exist/);
  assert.throws(() => normalizeTimeOffChange({
    taskUrl: 'https://example.com/pto', days: [{ date: '2027-03-29', startTime: '09:00', durationSeconds: 3600 }],
    timezone: 'Not/A_Real_Zone',
  }), /Invalid IANA timezone/);
});
