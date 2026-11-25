import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/options/options.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../src/options/options.js', import.meta.url), 'utf8');

for (const provider of ['codex', 'claude']) {
  test(`${provider} Settings offers independent opt-in, recovery and collector controls`, () => {
    assert.match(html, new RegExp(`id="agent-${provider}"`));
    for (const action of ['select', 'restore', 'pause', 'scan', 'forget']) {
      assert.match(html, new RegExp(`id="agent-${provider}-${action}"`));
    }
    assert.match(html, new RegExp(`id="agent-${provider}-status"`));
    assert.match(html, new RegExp(`id="agent-${provider}-diagnostics"`));
  });
}

test('Settings passes directory handles only to extension-origin storage, never in runtime messages', () => {
  assert.match(script, /showDirectoryPicker\(\{ mode: 'read' \}\)/);
  assert.match(script, /setAgentRoot\(provider, handle\)/);
  assert.match(script, /getAgentRoot\(provider\)/);
  assert.doesNotMatch(script, /send\(\{[^}]*handle/s);
  assert.match(script, /AGENT_COLLECTOR_STATUS/);
  assert.match(script, /AGENT_COLLECTOR_CONTROL/);
});
