import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanJsonlFile } from '../experiments/local-agent-logs/incremental.js';

class LogFile {
  constructor(text) { this.text = text; this.lastModified = 1; this.slices = []; }
  get size() { return new TextEncoder().encode(this.text).length; }
  slice(start, end) {
    this.slices.push([start, end]);
    return new Blob([new TextEncoder().encode(this.text).slice(start, end)]);
  }
  append(text) { this.text += text; this.lastModified++; }
  replace(text) { this.text = text; this.lastModified++; }
}

const line = (type, timestamp = '2026-11-24T12:00:00Z') => JSON.stringify({ type, timestamp }) + '\n';

test('reads only new complete JSONL lines and does not persist trailing private text', async () => {
  const file = new LogFile(line('session_meta') + line('event_msg') + '{"type":"private');
  const first = await scanJsonlFile(file, null, 'codex', { chunkBytes: 1024, maxBytes: 1024 });
  assert.equal(first.newLines, 2);
  assert.deepEqual(first.cursor.types, { session_meta: 1, event_msg: 1 });
  assert.equal(first.cursor.offset, new TextEncoder().encode(line('session_meta') + line('event_msg')).length);
  assert.equal(JSON.stringify(first.cursor).includes('private'), false);
  file.append('"}\n');
  file.slices = [];
  const second = await scanJsonlFile(file, first.cursor, 'codex', { chunkBytes: 1024, maxBytes: 1024 });
  assert.equal(second.newLines, 1);
  assert.equal(second.cursor.lines, 3);
  assert.ok(file.slices.some(([start]) => start === first.cursor.offset));
  assert.ok(file.slices.every(([start, end]) => end - start < file.size));
});

test('rewinds on truncation or same-length replacement without double counting', async () => {
  const file = new LogFile(line('user') + line('assistant'));
  const first = await scanJsonlFile(file, null, 'claude', { chunkBytes: 1024 });
  file.replace(line('system'));
  const truncated = await scanJsonlFile(file, first.cursor, 'claude', { chunkBytes: 1024 });
  assert.equal(truncated.restarted, true);
  assert.equal(truncated.cursor.lines, 1);
  assert.deepEqual(truncated.cursor.types, { system: 1 });
  file.replace(line('user'));
  const replaced = await scanJsonlFile(file, truncated.cursor, 'claude', { chunkBytes: 1024 });
  assert.equal(replaced.restarted, true);
  assert.deepEqual(replaced.cursor.types, { user: 1 });
});

test('bounds each read, catches malformed lines, and does not advance a failing cursor', async () => {
  const file = new LogFile(line('user') + '{invalid}\n');
  await assert.rejects(() => scanJsonlFile(file, null, 'claude', { chunkBytes: 1024 }), /invalid JSONL/);
  file.replace(line('user') + line('assistant'));
  const first = await scanJsonlFile(file, null, 'claude', { chunkBytes: 1024, maxBytes: 32 });
  assert.ok(first.bytesRead <= 32);
  assert.ok(first.cursor.offset < file.size);
  const second = await scanJsonlFile(file, first.cursor, 'claude', { chunkBytes: 1024 });
  assert.equal(second.cursor.lines, 2);
});
