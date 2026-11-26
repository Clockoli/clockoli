import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubTask, githubRepository, branchIssueNumbers, extractCodexMatchingRow,
  matchingEvidenceByTurn, matchingTasks, explainAgentMatch } from '../src/agents/task-matching.js';

const date = '2026-11-25T';
const at = time => date + time + 'Z';
const start = Date.parse(at('18:00:00')), end = Date.parse(at('20:00:00'));
const url = 'https://github.com/example/buddy/issues/679';
const other = 'https://github.com/example/buddy/issues/680';
const taskRows = [
  { taskUrl: url, taskTitle: 'Hybrid search', startedAt: at('18:00:00'), endedAt: at('19:00:00') },
  { taskUrl: other, taskTitle: 'Other task', startedAt: at('19:00:00'), endedAt: at('20:00:00') },
];
const tasks = matchingTasks(taskRows, start, end);
const turn = { startedAt: at('18:28:40'), endedAt: at('18:28:43'), status: 'completed', provider: 'codex' };
const meta = { type: 'session_meta', payload: { id: 'session-a', cwd: '/private/path',
  originator: 'air-plugin:phpstorm', git: { repository_url: 'git@github.com:example/buddy.git', branch: 'feat/679-hybrid-chat-search' } } };
const makeRows = (metadata = meta, message = 'Write a commit message', cwd = '/private/path') => [
  metadata,
  { type: 'event_msg', timestamp: turn.startedAt, payload: { type: 'task_started', turn_id: 'turn-a' } },
  { type: 'turn_context', payload: { turn_id: 'turn-a', cwd } },
  { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-a',
    item: { type: 'UserMessage', content: [{ type: 'text', text: message }] } } },
  { type: 'event_msg', timestamp: turn.endedAt, payload: { type: 'task_complete', turn_id: 'turn-a' } },
].map(extractCodexMatchingRow).filter(Boolean);
const evidence = (...args) => matchingEvidenceByTurn(makeRows(...args))[0];

test('canonical GitHub coordinates accept HTTPS, SCP and SSH but reject credentials and foreign hosts', () => {
  assert.equal(githubRepository('git@github.com:Example/Buddy.git'), 'example/buddy');
  assert.equal(githubRepository('https://github.com/example/buddy.git'), 'example/buddy');
  assert.equal(githubRepository('ssh://git@github.com/example/buddy.git'), 'example/buddy');
  assert.equal(githubRepository('https://secret@github.com/example/buddy.git'), null);
  assert.equal(githubRepository('https://github.com.evil.test/example/buddy.git'), null);
  assert.equal(githubTask('https://github.com/EXAMPLE/Buddy/issues/679/').url, url);
  assert.deepEqual(branchIssueNumbers('feat/679-hybrid-chat-search'), ['679']);
  assert.deepEqual(branchIssueNumbers('release/2026-11-25'), []);
  assert.deepEqual(branchIssueNumbers('dev'), []);
});

test('repository + branch + verified context + timer containment matches one task and explains other candidates', () => {
  const result = explainAgentMatch(turn, evidence(), tasks);
  assert.equal(result.matchedUrl, url);
  assert.equal(result.reason, 'repository_branch_and_containment');
  assert.equal(result.candidates[0].overlapMs, 3000);
  assert.equal(result.candidates[0].branch, true);
  assert.equal(result.candidates[1].repository, true);
  assert.equal(result.candidates[1].contained, false);
  assert.equal(JSON.stringify(result).includes('/private/path'), false);
  assert.equal(JSON.stringify(result).includes('Write a commit message'), false);
  assert.equal(JSON.stringify(result).includes('session-a'), false);
});

test('smoke prompt in a timer without repository metadata is unassigned, not a false match', () => {
  const sample = { ...meta, payload: { ...meta.payload, git: null, originator: 'codex_exec' } };
  const result = explainAgentMatch(turn, evidence(sample, 'Reply with OK'), tasks);
  assert.equal(result.state, 'unassigned');
  assert.equal(result.reason, 'time_only');
  assert.equal(result.candidates[0].contained, true);
});

test('exact user-linked issue may match without repository; multiple or contradictory references abstain', () => {
  const sample = { ...meta, payload: { ...meta.payload, git: null } };
  assert.equal(explainAgentMatch(turn, evidence(sample, 'Work on ' + url), tasks).reason, 'explicit_url_and_containment');
  assert.equal(explainAgentMatch(turn, evidence(meta, 'Work on ' + other), tasks).reason, 'conflicting_identity');
  assert.equal(explainAgentMatch(turn, evidence(sample, url + ' ' + other), tasks).reason, 'conflicting_identity');
  assert.equal(explainAgentMatch(turn, evidence(meta, 'x'.repeat(32769)), tasks).reason, 'prompt_reference_scan_incomplete');
});

test('context change, changed lifecycle, missing evidence, incomplete task history and boundary crossings abstain', () => {
  assert.equal(explainAgentMatch(turn, evidence(meta, 'task', '/different'), tasks).reason, 'working_directory_changed');
  assert.equal(explainAgentMatch(turn, evidence(), tasks, { partial: true }).reason, 'task_history_incomplete');
  assert.equal(explainAgentMatch(turn, null, tasks).reason, 'source_evidence_unavailable');
  assert.equal(explainAgentMatch({ ...turn, endedAt: at('18:28:44') }, evidence(), tasks).reason, 'source_lifecycle_changed');
  const crossed = { ...turn, endedAt: at('19:01:00') };
  assert.equal(explainAgentMatch(crossed, { ...evidence(), endedAt: Date.parse(crossed.endedAt) }, tasks).reason, 'identity_outside_tracked_interval');
  assert.equal(explainAgentMatch({ ...turn, anchored: false }, evidence(), tasks).reason, 'interval_unverified');
  const long = { ...turn, startedAt: at('18:00:00'), endedAt: at('19:30:00') };
  assert.equal(explainAgentMatch(long, { ...evidence(), startedAt: Date.parse(long.startedAt), endedAt: Date.parse(long.endedAt) }, tasks).reason, 'extended_turn');
});

test('unscoped user messages and tool outputs cannot establish task identity', () => {
  assert.equal(extractCodexMatchingRow({ type: 'event_msg', payload: { type: 'user_message', message: url } }), null);
  assert.equal(extractCodexMatchingRow({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: url }] } }), null);
  assert.equal(extractCodexMatchingRow({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-a', item: { type: 'ToolResult', content: [{ type: 'text', text: url }] } } }), null);
});

test('matching candidates include intervals crossing the local day, but never unrelated days', () => {
  const result = matchingTasks([...taskRows, { taskUrl: 'https://example.com/other', taskTitle: 'yesterday',
    startedAt: '2026-11-24T00:00:00Z', endedAt: '2026-11-24T01:00:00Z' }], start, end);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].intervals, [{ start, end: Date.parse(at('19:00:00')), active: false }]);
});
