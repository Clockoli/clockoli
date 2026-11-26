import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAgentRow, projectAgentTurns } from '../src/agents/parsers.js';
import { markStaleOpenAgentTurns, summarizeAgentTurns } from '../src/agents/metrics.js';

const at = (second) => `2026-11-24T12:00:${String(second).padStart(2, '0')}Z`;
const codex = (type, turnId, second, duration_ms) => parseAgentRow('codex', {
  type: 'event_msg', timestamp: at(second), payload: { type, turn_id: turnId, duration_ms,
    message: 'PRIVATE', cwd: '/private/work', unknown: { secret: 'PRIVATE' } },
});
const claude = (type, uuid, parentUuid, second, extra = {}) => parseAgentRow('claude', {
  type, uuid, parentUuid, sessionId: 'session-1', timestamp: at(second),
  message: { id: 'same-message', content: [{ type: 'text', text: 'PRIVATE' }] },
  cwd: '/private/work', gitBranch: 'secret', ...extra,
});
const scoped = (event, fileKey = 'opaque-file-A', sessionId = 'opaque-session-A') => ({ ...event, fileKey, sessionId });

test('allowlist strips private content and rejects malformed timestamps, identifiers, and durations', () => {
  const event = codex('task_complete', 'turn-1', 2, 1200);
  assert.deepEqual(event, { type: 'task_complete', timestamp: '2026-11-24T12:00:02.000Z', turnId: 'turn-1', durationMs: 1200 });
  assert.equal(parseAgentRow('codex', { type: 'session_meta', timestamp: at(0), payload: { id: 'session-1', cwd: '/private' } }).sessionId, 'session-1');
  assert.equal(parseAgentRow('claude', { type: 'assistant', timestamp: 'yesterday', uuid: 'u', message: { content: 'PRIVATE' } }).timestamp, null);
  assert.equal(parseAgentRow('claude', { type: 'assistant', timestamp: '2026-02-30T12:00:00Z', uuid: 'u' }).timestamp, null);
  assert.equal(codex('task_complete', 'turn-2', 2, -1).durationMs, null);
  assert.equal(codex('task_complete', 'turn-2', 2, Infinity).durationMs, null);
  assert.equal(codex('task_complete', '/private/path', 2).turnId, null);
  assert.deepEqual(parseAgentRow('codex', { type: 'response_item', payload: { text: 'PRIVATE' } }), { type: 'unknown_event', timestamp: null });
  assert.deepEqual(parseAgentRow('claude', { type: 'mystery', prompt: 'PRIVATE' }), { type: 'unknown_event', timestamp: null });
  assert.equal(parseAgentRow('claude', null).type, 'unknown_event');
  assert.equal(JSON.stringify(claude('assistant', 'assistant-1', 'user-1', 3)).includes('PRIVATE'), false);
});

test('Codex pairs interleaved turns per file/session/id and retains aborts, orphans and open turns', () => {
  const events = [
    scoped(codex('task_started', 'turn-A', 1)), scoped(codex('task_started', 'turn-B', 2)),
    scoped(codex('task_complete', 'turn-B', 4)), scoped(codex('turn_aborted', 'turn-A', 5)),
    scoped(codex('task_complete', 'turn-C', 6)), scoped(codex('task_started', 'turn-D', 7)),
    scoped(codex('task_complete', 'turn-B', 4)),
    scoped(codex('task_started', 'turn-B', 8), 'opaque-file-B'),
  ];
  const { sessions, turns, unknownEvents } = projectAgentTurns('codex', events);
  assert.equal(unknownEvents, 0);
  assert.equal(sessions.length, 2);
  assert.equal(turns.length, 5);
  const byId = Object.fromEntries(turns.filter(t => t.sourceFileKey === 'opaque-file-A').map(t => [t.upstreamTurnId, t]));
  assert.equal(byId['turn-A'].status, 'interrupted');
  assert.equal(byId['turn-A'].elapsedMs, 4000);
  assert.equal(byId['turn-B'].status, 'completed');
  assert.equal(byId['turn-B'].elapsedMs, 2000);
  assert.equal(byId['turn-B'].durationSource, 'event_interval');
  assert.equal(byId['turn-C'].status, 'completed');
  assert.equal(byId['turn-C'].elapsedMs, null);
  assert.equal(byId['turn-C'].startedAt, null);
  assert.equal(byId['turn-D'].status, 'open');
  assert.equal(byId['turn-D'].endedAt, null);
  assert.equal(byId['turn-D'].projectId, null);
  assert.deepEqual(projectAgentTurns('codex', events), { sessions, turns, unknownEvents });
});

test('Codex terminal duration is measured but unanchored without a valid start, and backwards intervals stay unknown', () => {
  const events = [scoped(codex('task_complete', 'orphan', 2, 1500)),
    scoped(codex('task_started', 'backwards', 9)), scoped(codex('task_complete', 'backwards', 1))];
  const { turns } = projectAgentTurns('codex', events);
  const orphan = turns.find(t => t.upstreamTurnId === 'orphan');
  assert.equal(orphan.providerDurationMs, 1500);
  assert.equal(orphan.durationSource, 'provider_duration');
  assert.equal(orphan.startedAt, null);
  assert.equal(turns.find(t => t.upstreamTurnId === 'backwards').elapsedMs, null);
});

test('Claude excludes tool-result-only input, connects cross-file sidechains by UUID ancestry, and measures only explicit duration', () => {
  const user = scoped(claude('user', 'user-1', null, 1), 'opaque-file-A');
  const tool = scoped(claude('user', 'tool-1', 'assistant-1', 2, { message: { content: [{ type: 'tool_result', content: 'PRIVATE' }] } }), 'opaque-file-B');
  const assistant = scoped(claude('assistant', 'assistant-1', 'user-1', 3, { agentId: 'agent-1' }), 'opaque-file-B');
  const assistantAgain = scoped(claude('assistant', 'assistant-2', 'assistant-1', 4, { agentId: 'agent-1', message: { id: 'same-message', content: [{ type: 'text', text: 'PRIVATE' }] } }), 'opaque-file-B');
  const duration = scoped(claude('system', 'duration-1', 'assistant-2', 5, { subtype: 'turn_duration', durationMs: 2600 }), 'opaque-file-B');
  const { turns, sessions, unknownEvents } = projectAgentTurns('claude', [duration, tool, assistantAgain, user, assistant]);
  assert.equal(unknownEvents, 0);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].status, 'completed');
  assert.equal(turns[0].providerDurationMs, 2600);
  assert.equal(turns[0].durationSource, 'provider_duration');
  assert.equal(turns[0].startedAt, '2026-11-24T12:00:01.000Z');
  assert.equal(turns[0].endedAt, '2026-11-24T12:00:05.000Z');
  assert.equal(turns[0].elapsedMs, 4000);
  assert.equal(turns[0].anchored, false);
  assert.equal(summarizeAgentTurns(turns).claude.time.wallClockMs, 0);
  assert.equal(turns[0].projectId, null);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sourceFileKey, 'opaque-file-A');
});

test('Claude unknown user end and orphan duration remain distinct unknown/measured candidates', () => {
  const events = [scoped(claude('user', 'user-1', null, 1)),
    scoped(claude('assistant', 'assistant-1', 'user-1', 2)),
    scoped(claude('system', 'duration-1', 'missing-assistant', 3, { subtype: 'turn_duration', durationMs: 0 })),
    scoped(claude('user', 'tool-1', null, 4, { message: { content: [{ type: 'tool_result' }] } })),
    scoped(parseAgentRow('claude', { type: 'progress', timestamp: at(5) }))];
  const { turns, unknownEvents } = projectAgentTurns('claude', events);
  assert.equal(turns.length, 2);
  assert.equal(turns.find(t => t.upstreamTurnId === 'user-1').status, 'open');
  assert.equal(turns.find(t => t.upstreamTurnId === 'user-1').durationSource, 'none');
  const orphan = turns.find(t => t.upstreamTurnId === 'missing-assistant');
  assert.equal(orphan.providerDurationMs, 0);
  assert.equal(orphan.startedAt, null);
  assert.equal(orphan.endedAt, '2026-11-24T12:00:03.000Z');
  assert.equal(orphan.anchored, false);
  const aged = markStaleOpenAgentTurns(turns, Date.parse('2026-11-26T12:00:00Z'));
  assert.equal(aged.find(t => t.upstreamTurnId === 'user-1').status, 'stale_unknown');
  assert.equal(unknownEvents, 1);
});

test('Claude matching observed bounds anchor measured provider duration', () => {
  const events = [scoped(claude('user', 'u', null, 1)),
    scoped(claude('assistant', 'a', 'u', 2)),
    scoped(claude('system', 'd', 'a', 5, { subtype: 'turn_duration', durationMs: 4000 }))];
  const { turns } = projectAgentTurns('claude', events);
  assert.equal(turns[0].anchored, true);
  assert.equal(turns[0].elapsedMs, 4000);
  const { time } = summarizeAgentTurns(turns).claude;
  assert.equal(time.agentMs, 4000);
  assert.equal(time.wallClockMs, 4000);
  assert.equal(time.unanchoredMeasuredTurns, 0);
});

test('projection rejects unscoped or unsafe events without leaking arbitrary caller keys', () => {
  const result = projectAgentTurns('codex', [codex('task_started', 'turn-A', 1),
    { ...scoped(codex('task_started', 'turn-B', 1)), fileKey: '/private/path' },
    { ...scoped(codex('task_started', 'turn-C', 1)), secret: 'PRIVATE' }]);
  assert.equal(result.turns.length, 1);
  assert.equal(result.unknownEvents, 2);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(result).includes('/private'), false);
});
