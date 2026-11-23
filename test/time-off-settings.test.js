import test from 'node:test';
import assert from 'node:assert/strict';
import { readTimeOffSettings, saveTimeOffSettings } from '../src/services/time-off-settings.js';
import { TIME_OFF_CONFIG_PATH, serializeTimeOffConfig } from '../src/domain/time-off.js';

const sha = 'a'.repeat(40);
function fakeGithub({ config = { version: 1, taskUrls: [] }, admin = true } = {}) {
  const calls = [];
  const github = {
    calls,
    async getText(path) {
      calls.push(['get', path]);
      if (!config) throw Object.assign(new Error('missing'), { status: 404 });
      return { text: serializeTimeOffConfig(config.taskUrls), sha };
    },
    async assertDestinationReachable() { calls.push(['check']); },
    async validateRepository() { calls.push(['repository']); return { permissions: { admin } }; },
    async putText(path, text, message, fileSha) {
      calls.push(['put', path, fileSha, text]);
      return { sha: 'b'.repeat(40) };
    },
  };
  return github;
}

test('missing optional config is empty only after repository reachability is verified', async () => {
  const github = fakeGithub({ config: null });
  const result = await readTimeOffSettings(github);
  assert.deepEqual(result.config.taskUrls, []);
  assert.equal(result.sha, null);
  assert.deepEqual(github.calls, [['get', TIME_OFF_CONFIG_PATH], ['check']]);
});

test('admin can replace PTO URLs with a matching GitHub revision', async () => {
  const github = fakeGithub();
  const url = 'https://github.com/acme/test/issues/12';
  const result = await saveTimeOffSettings(github, { taskUrls: [url], expectedSha: sha });
  assert.deepEqual(result.config.taskUrls, [url]);
  assert.equal(result.sha, 'b'.repeat(40));
  const write = github.calls.find(call => call[0] === 'put');
  assert.equal(write[1], TIME_OFF_CONFIG_PATH);
  assert.equal(write[2], sha);
});

test('stale revision and non-admin changes are rejected without a write', async () => {
  const stale = fakeGithub();
  await assert.rejects(saveTimeOffSettings(stale, { taskUrls: [], expectedSha: null }), /changed on GitHub/);
  assert.equal(stale.calls.some(call => call[0] === 'put'), false);
  const member = fakeGithub({ admin: false });
  await assert.rejects(saveTimeOffSettings(member, { taskUrls: [], expectedSha: sha }), /administrator/);
  assert.equal(member.calls.some(call => call[0] === 'put'), false);
});
