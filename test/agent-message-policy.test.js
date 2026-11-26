import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentCollectorRequest, agentMatchingRequest, agentWorkflowRequest, assertMessageAllowed } from '../src/background/message-policy.js';
const origin = 'chrome-extension://collector-test/';
const settings = { url: `${origin}src/options/options.html` };
const activity = { url: `${origin}src/times/times.html` };
const content = { url: 'https://github.com/sample/repo/issues/1', tab: { url: 'https://github.com/sample/repo/issues/1' } };

test('agent collector status is Settings-only with an exact empty payload', () => {
  assert.equal(agentCollectorRequest({ type: 'AGENT_COLLECTOR_STATUS' }, settings, origin).action, 'status');
  for (const sender of [activity, content, { url: `${origin}src/options/options.html/extra` }]) {
    assert.throws(() => agentCollectorRequest({ type: 'AGENT_COLLECTOR_STATUS' }, sender, origin));
  }
  for (const bad of [{ type: 'AGENT_COLLECTOR_STATUS', provider: 'codex' },
    { type: 'AGENT_COLLECTOR_STATUS', text: 'private' }]) {
    assert.throws(() => agentCollectorRequest(bad, settings, origin));
  }
  assert.throws(() => assertMessageAllowed('AGENT_COLLECTOR_STATUS', content, origin));
});

test('agent collector control accepts only exact known actions/providers and Settings sender', () => {
  const request = { type: 'AGENT_COLLECTOR_CONTROL', action: 'scan', provider: 'claude' };
  assert.deepEqual(agentCollectorRequest(request, settings, origin), { action: 'scan', provider: 'claude' });
  for (const action of ['scan', 'pause', 'resume', 'forget']) {
    assert.equal(agentCollectorRequest({ ...request, action }, settings, origin).action, action);
  }
  for (const bad of [{ ...request, action: 'write' }, { ...request, provider: 'other' },
    { ...request, payload: { source: 'PRIVATE' } }, { ...request, provider: null }]) {
    assert.throws(() => agentCollectorRequest(bad, settings, origin));
  }
  assert.throws(() => agentCollectorRequest(request, content, origin));
});

test('workflow summary is read-only, Activity-only and accepts only exact filter enums', () => {
  const request = { type: 'AGENT_WORKFLOW_SUMMARY', period: '7d', provider: 'codex', thresholdMinutes: 15 };
  assert.deepEqual(agentWorkflowRequest(request, activity, origin),
    { period: '7d', provider: 'codex', thresholdMinutes: 15 });
  for (const sender of [settings, content, { url: origin + 'src/times/times.html/extra' }]) {
    assert.throws(() => agentWorkflowRequest(request, sender, origin));
  }
  for (const bad of [{ ...request, period: 'arbitrary' }, { ...request, provider: 'unknown' },
    { ...request, thresholdMinutes: 0 }, { ...request, thresholdMinutes: '15' },
    { ...request, path: '/private' }]) {
    assert.throws(() => agentWorkflowRequest(bad, activity, origin));
  }
  assert.throws(() => assertMessageAllowed('AGENT_WORKFLOW_SUMMARY', content, origin));
});

test('matching diagnostic is Activity-only with an exact date and threshold', () => {
  const request = { type: 'AGENT_MATCHING_DIAGNOSTICS', date: '2026-11-25', thresholdMinutes: 15 };
  assert.deepEqual(agentMatchingRequest(request, activity, origin), { date: '2026-11-25', thresholdMinutes: 15 });
  for (const sender of [settings, content, { url: origin + 'src/times/times.html/extra' }]) {
    assert.throws(() => agentMatchingRequest(request, sender, origin));
  }
  for (const bad of [{ ...request, date: '2026-02-30' }, { ...request, date: 'today' },
    { ...request, thresholdMinutes: '15' }, { ...request, records: [] }, { ...request, path: '/private' }]) {
    assert.throws(() => agentMatchingRequest(bad, activity, origin));
  }
  assert.throws(() => assertMessageAllowed('AGENT_MATCHING_DIAGNOSTICS', content, origin));
});
