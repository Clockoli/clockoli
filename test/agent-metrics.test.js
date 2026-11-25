import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markStaleOpenAgentTurns, summarizeAgentTurns, summarizeAgentWorkflow } from '../src/agents/metrics.js';

const at = (second) => `2026-11-24T12:00:${String(second).padStart(2, '0')}Z`;
const turn = (key, provider, start, end, extra = {}) => ({
  key, provider, status: 'completed', startedAt: at(start), endedAt: at(end),
  elapsedMs: (end - start) * 1000, providerDurationMs: null,
  durationSource: 'event_interval', timingConfidence: 'high', ...extra,
});

const counts = (snapshot) => snapshot.turns;

test('overlapping providers retain summed agent time and union only anchored measured intervals', () => {
  const result = summarizeAgentTurns([
    turn('opaque-a', 'codex', 0, 10, { providerDurationMs: 9000 }),
    turn('opaque-b', 'claude', 5, 15),
    turn('opaque-c', 'codex', 20, 22, { status: 'interrupted' }),
  ], { codex: { complete: true, blockedFiles: 0 }, claude: { complete: false, blockedFiles: 2, path: '/private' } });
  assert.deepEqual(counts(result.all), { discovered: 3, measured: 3, estimated: 0, unknown: 0 });
  assert.equal(result.all.measuredCoveragePct, 100);
  assert.deepEqual(result.all.time, {
    agentMs: 22000, wallClockMs: 17000, estimatedMs: 0, humanWaitingMs: null,
    overlapCount: 1, overlapMs: 5000, unanchoredMeasuredTurns: 0,
  });
  assert.equal(result.codex.time.wallClockMs, 12000);
  assert.equal(result.claude.time.wallClockMs, 10000);
  assert.equal(result.codex.status.interrupted, 1);
  assert.equal(result.all.status.interrupted, 1);
  assert.deepEqual(result.claude.scan, { complete: false, blockedFiles: 2 });
  assert.equal(JSON.stringify(result).includes('/private'), false);
  assert.equal(JSON.stringify(result).includes('opaque-'), false);
});

test('unanchored provider duration is agent time, not wall clock or overlap', () => {
  const result = summarizeAgentTurns([
    turn('opaque-1', 'claude', 0, 1, { startedAt: null, endedAt: null,
      elapsedMs: null, providerDurationMs: 4200, durationSource: 'provider_duration', timingConfidence: 'high' }),
    turn('opaque-2', 'codex', 0, 2),
  ]);
  assert.equal(result.all.time.agentMs, 6200);
  assert.equal(result.all.time.wallClockMs, 2000);
  assert.equal(result.all.time.unanchoredMeasuredTurns, 1);
  assert.equal(result.all.time.overlapMs, 0);
});

test('explicit provider duration falls back when event interval is unusable, without inventing an anchor', () => {
  const result = summarizeAgentTurns([
    turn('fallback', 'codex', 0, 1, { endedAt: null, elapsedMs: null,
      providerDurationMs: 1500, durationSource: 'event_interval' }),
    turn('explicit-unanchored', 'codex', 0, 2, { anchored: false }),
  ]);
  assert.deepEqual(result.codex.turns, { discovered: 2, measured: 2, estimated: 0, unknown: 0 });
  assert.equal(result.codex.time.agentMs, 3500);
  assert.equal(result.codex.time.wallClockMs, 0);
  assert.equal(result.codex.time.unanchoredMeasuredTurns, 2);
});

test('incomplete and invalid durations are unknown; statuses remain orthogonal', () => {
  const result = summarizeAgentTurns([
    turn('open', 'codex', 0, 1, { status: 'open', endedAt: null }),
    turn('stale', 'claude', 0, 1, { status: 'stale_unknown', endedAt: null }),
    turn('bad', 'codex', 0, 1, { elapsedMs: -1, providerDurationMs: NaN }),
    turn('other', 'claude', 0, 1, { status: 'unsupported' }),
    turn('interrupted', 'codex', 0, 1, { status: 'interrupted' }),
  ]);
  assert.deepEqual(result.all.turns, { discovered: 5, measured: 1, estimated: 0, unknown: 4 });
  assert.deepEqual(result.all.status, { interrupted: 1, open: 1, staleUnknown: 1 });
  assert.equal(result.all.time.agentMs, 1000);
});

test('Claude low coverage retains unknowns and estimated windows separately', () => {
  const result = summarizeAgentTurns([
    turn('duration', 'claude', 0, 1, { startedAt: null, endedAt: null, elapsedMs: null,
      providerDurationMs: 1500, durationSource: 'provider_duration', timingConfidence: 'high' }),
    turn('estimated', 'claude', 1, 4, { durationSource: 'estimated_window', timingConfidence: 'low' }),
    turn('unknown-1', 'claude', 0, 1, { status: 'open', startedAt: at(0), endedAt: null,
      elapsedMs: null, durationSource: 'none', timingConfidence: 'none' }),
    turn('unknown-2', 'claude', 0, 1, { status: 'stale_unknown', endedAt: null,
      elapsedMs: null, durationSource: 'none', timingConfidence: 'none' }),
  ]);
  assert.deepEqual(result.claude.turns, { discovered: 4, measured: 1, estimated: 1, unknown: 2 });
  assert.equal(result.claude.measuredCoveragePct, 25);
  assert.equal(result.claude.time.agentMs, 1500);
  assert.equal(result.claude.time.estimatedMs, 3000);
  assert.equal(result.claude.time.wallClockMs, 0);
});

test('duplicate keys never double count, including duplicate in a second provider', () => {
  const result = summarizeAgentTurns([
    turn('same', 'codex', 0, 5), turn('same', 'codex', 0, 5),
    turn('same', 'claude', 0, 5), turn('other', 'claude', 5, 6),
  ]);
  assert.equal(result.codex.turns.discovered, 1);
  assert.equal(result.claude.turns.discovered, 1);
  assert.equal(result.all.turns.discovered, 2);
  assert.equal(result.all.time.agentMs, 6000);
});

test('zero denominator has null coverage and safe zero numeric aggregates', () => {
  const result = summarizeAgentTurns([], { codex: { complete: false, unknownEvents: 7, secret: 'PRIVATE' } });
  for (const item of [result.codex, result.claude, result.all]) {
    assert.deepEqual(item.turns, { discovered: 0, measured: 0, estimated: 0, unknown: 0 });
    assert.equal(item.measuredCoveragePct, null);
    assert.equal(item.time.wallClockMs, 0);
    assert.equal(item.time.humanWaitingMs, null);
  }
  assert.equal(result.codex.scan.unknownEvents, 7);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('a single caller scan-health object applies to the combined snapshot only', () => {
  const result = summarizeAgentTurns([], { complete: false, pendingBytes: 1024, rootPath: '/private' });
  assert.deepEqual(result.all.scan, { complete: false, pendingBytes: 1024 });
  assert.deepEqual(result.codex.scan, {});
  assert.deepEqual(result.claude.scan, {});
});

test('invalid periods never create negative union, overflow, or a false anchored interval', () => {
  const result = summarizeAgentTurns([
    turn('backwards', 'codex', 10, 1, { elapsedMs: 9000 }),
    turn('bad-date', 'codex', 0, 1, { startedAt: '2026-02-30T00:00:00Z' }),
    turn('mismatch', 'codex', 0, 1, { elapsedMs: 2000 }),
    turn('overflow', 'claude', 0, 1, { durationSource: 'provider_duration',
      providerDurationMs: Number.MAX_VALUE, elapsedMs: null }),
  ]);
  assert.deepEqual(result.all.turns, { discovered: 4, measured: 0, estimated: 0, unknown: 4 });
  assert.equal(result.all.time.agentMs, 0);
  assert.equal(result.all.time.wallClockMs, 0);
});

test('old observed starts become stale unknown without an invented end or duration', () => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  const older = turn('old', 'codex', 0, 1, { status: 'open', startedAt: '2026-11-20T12:00:00Z',
    endedAt: null, elapsedMs: null, durationSource: 'none' });
  const recent = { ...older, key: 'recent', startedAt: '2026-11-24T11:59:00Z' };
  const result = markStaleOpenAgentTurns([older, recent], now);
  assert.equal(result[0].status, 'stale_unknown');
  assert.equal(result[0].endedAt, null);
  assert.equal(result[0].elapsedMs, null);
  assert.equal(result[1].status, 'open');
  assert.equal(older.status, 'open');
});

const workflowTurn = (key, minutes, extra = {}) => {
  const start = Date.parse('2026-11-24T12:00:00Z');
  return { key, provider: 'codex', status: 'completed',
    startedAt: new Date(start).toISOString(), endedAt: new Date(start + minutes * 60000).toISOString(),
    elapsedMs: minutes * 60000, providerDurationMs: null,
    durationSource: 'event_interval', timingConfidence: 'high', ...extra };
};

test('workflow distribution distinguishes many short turns from a few long turns of equal total duration', () => {
  const long = summarizeAgentWorkflow(Array.from({ length: 4 }, (_, i) => workflowTurn('long-' + i, 45)),
    { period: 'all', provider: 'all', thresholdMinutes: 15 });
  const short = summarizeAgentWorkflow(Array.from({ length: 60 }, (_, i) => workflowTurn('short-' + i, 3)),
    { period: 'all', provider: 'all', thresholdMinutes: 15 });
  assert.equal(long.eligibleMs, 10800000);
  assert.equal(short.eligibleMs, long.eligibleMs);
  assert.equal(long.shortSharePct, 0);
  assert.equal(short.shortSharePct, 100);
  assert.equal(long.longCount, 4);
  assert.equal(short.shortCount, 60);
  assert.equal(long.medianMs, 2700000);
  assert.equal(short.medianMs, 180000);
});

test('workflow buckets have exact boundaries; extended, estimated, open and duplicate turns do not inflate the denominator', () => {
  const turns = [0, 1, 5, 15, 30, 60, 61, 14400].map((minutes, i) => workflowTurn('t' + i, minutes));
  turns.push(turns[1], workflowTurn('open', 3, { status: 'open', endedAt: null }),
    workflowTurn('estimated', 3, { durationSource: 'estimated_window', timingConfidence: 'low' }));
  const result = summarizeAgentWorkflow(turns, { period: 'all', provider: 'all', thresholdMinutes: 15 });
  assert.equal(result.totalTurns, 10);
  assert.equal(result.eligibleTurns, 6);
  assert.equal(result.extendedTurns, 2);
  assert.equal(result.unknownTurns, 2);
  assert.deepEqual(result.buckets.map(b => b.count), [1, 1, 1, 1, 2]);
  assert.equal(result.shortMs, 360000);
  assert.equal(result.longMs, 6300000);
  assert.equal(result.longCount, 3);
  assert.equal(result.extendedMs, 14461 * 60000);
  assert.equal(result.medianMs, 10 * 60000);
  assert.equal(JSON.stringify(result).includes('t0'), false);
});

test('workflow counts provider-reported durations without inventing an interval, separates extended elapsed, and preserves unknowns', () => {
  const reported = workflowTurn('reported', 10, { provider: 'claude', startedAt: null,
    elapsedMs: null, providerDurationMs: 120000, durationSource: 'provider_duration', anchored: false });
  const mismatch = workflowTurn('mismatch', 120, { provider: 'claude',
    providerDurationMs: 180000, durationSource: 'provider_duration', anchored: false });
  const undated = { ...reported, key: 'undated', endedAt: null };
  const result = summarizeAgentWorkflow([reported, mismatch, undated, workflowTurn('codex', 5)],
    { period: 'all', provider: 'claude', thresholdMinutes: 5 });
  assert.equal(result.totalTurns, 3);
  assert.equal(result.eligibleTurns, 2);
  assert.equal(result.providerDurationTurns, 2);
  assert.equal(result.extendedTurns, 1);
  assert.equal(result.extendedMs, 180000);
  assert.equal(result.undatedTurns, 1);
  assert.equal(result.shortMs, 240000);
});

test('workflow periods use local calendar days and count whole turns by end or last known start', () => {
  const now = new Date(2026, 10, 25, 12).getTime();
  const localToday = new Date(2026, 10, 25, 0).getTime();
  const crossing = workflowTurn('crossing', 2, {
    startedAt: new Date(localToday - 60000).toISOString(),
    endedAt: new Date(localToday + 60000).toISOString(),
  });
  const previous = workflowTurn('previous', 1, {
    startedAt: new Date(localToday - 120000).toISOString(),
    endedAt: new Date(localToday - 60000).toISOString(),
  });
  const undated = workflowTurn('undated', 1, { startedAt: null, endedAt: null });
  const result = summarizeAgentWorkflow([crossing, previous, undated],
    { period: 'today', provider: 'all', thresholdMinutes: 5 }, now);
  assert.equal(result.totalTurns, 1);
  assert.equal(result.eligibleMs, 120000);
  assert.equal(result.undatedTurns, 1);
  const week = summarizeAgentWorkflow([crossing, previous, undated],
    { period: '7d', provider: 'all', thresholdMinutes: 5 }, now);
  assert.equal(week.totalTurns, 2);
  assert.equal(week.eligibleMs, 180000);
  const empty = summarizeAgentWorkflow([], { period: 'today', provider: 'all', thresholdMinutes: 5 }, now);
  assert.equal(empty.shortSharePct, null);
  assert.equal(empty.medianMs, null);
});
