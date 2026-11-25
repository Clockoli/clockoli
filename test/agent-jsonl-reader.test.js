import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanAgentJsonl } from '../src/agents/jsonl-reader.js';

class Journal {
  constructor(text) { this.text = text; this.lastModified = 1; this.slices = []; }
  get size() { return new TextEncoder().encode(this.text).length; }
  slice(start, end) {
    this.slices.push([start, end]);
    return new Blob([new TextEncoder().encode(this.text).slice(start, end)]);
  }
  append(text) { this.text += text; this.lastModified++; }
  replace(text) { this.text = text; this.lastModified++; }
}
const line = (type, secret = 'PRIVATE_PROMPT') => JSON.stringify({ type, secret }) + '\n';
const fingerprint = async bytes => String([...bytes].reduce((total, byte) => (total * 31 + byte) >>> 0, 0));
const parseRow = row => ({ kind: row.type });
const scan = (file, cursor, options = {}) => scanAgentJsonl(file, cursor, {
  chunkBytes: 64, readBudget: 4096, maxLineBytes: 1024,
  fingerprint, parseRow, ...options,
});

test('only complete lines advance; private source and incomplete tails never persist', async () => {
  const file = new Journal(line('start') + '{"type":"finish","secret":"PRIVATE');
  const first = await scan(file, null);
  assert.equal(first.cursor.lines, 1);
  assert.equal(first.events.length, 1);
  assert.equal(first.cursor.offset, new TextEncoder().encode(line('start')).length);
  assert.equal(JSON.stringify(first).includes('PRIVATE'), false);
  file.append('_PROMPT"}\n');
  const second = await scan(file, first.cursor);
  assert.equal(second.cursor.lines, 2);
  assert.deepEqual(second.events.map(event => event.kind), ['finish']);
  assert.equal(second.restarted, false);
  assert.equal(JSON.stringify(second).includes('PRIVATE'), false);
});

test('multimegabyte-equivalent line spans small chunks rather than failing at one chunk', async () => {
  const file = new Journal(line('large', 'x'.repeat(340)));
  const result = await scan(file, null);
  assert.equal(result.cursor.offset, file.size);
  assert.equal(result.cursor.lines, 1);
  assert.equal(result.blockedCode, null);
  assert.ok(file.slices.length > 5);
});

test('replacement, including same-size replacement, rewinds without accepting stale observations', async () => {
  const file = new Journal(line('start'));
  const first = await scan(file, null);
  file.replace(line('other'));
  const second = await scan(file, first.cursor);
  assert.equal(second.restarted, true);
  assert.equal(second.cursor.lines, 1);
  assert.deepEqual(second.events.map(event => event.kind), ['other']);
  file.replace(line('end'));
  const third = await scan(file, second.cursor);
  assert.equal(third.restarted, true);
  assert.deepEqual(third.events.map(event => event.kind), ['end']);
});

test('malformed line quarantines its offset without losing earlier complete events', async () => {
  const file = new Journal(line('start') + '{bad}\n' + line('later'));
  const result = await scan(file, null);
  assert.equal(result.blockedCode, 'invalid_jsonl');
  assert.equal(result.cursor.lines, 1);
  assert.equal(result.cursor.offset, new TextEncoder().encode(line('start')).length);
  assert.deepEqual(result.events.map(event => event.kind), ['start']);
  assert.equal(JSON.stringify(result).includes('{bad}'), false);
});

test('oversized line is safely blocked and bounded reads do not leak its bytes', async () => {
  const file = new Journal(line('large', 'PRIVATE_PROMPT'.repeat(100)));
  const result = await scan(file, null, { maxLineBytes: 200, readBudget: 2048 });
  assert.equal(result.blockedCode, 'line_too_large');
  assert.equal(result.cursor.offset, 0);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('budget exhaustion keeps the last complete cursor and permits bounded continuation', async () => {
  const file = new Journal(line('a') + line('b') + line('c'));
  const first = await scan(file, null, { readBudget: 64 });
  assert.ok(first.cursor.offset < file.size);
  const second = await scan(file, first.cursor);
  assert.equal(second.cursor.lines, 3);
  assert.equal(second.cursor.offset, file.size);
});
