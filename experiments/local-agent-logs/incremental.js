// Read-only JSONL cursor. No source line, prompt, file path, or partial line is persisted.
const CODEx_TYPES = new Set(['session_meta', 'event_msg', 'response_item', 'turn_context', 'compacted']);
const CLAUDE_TYPES = new Set(['user', 'assistant', 'system', 'summary', 'progress', 'file-history-snapshot']);

function eventType(row, provider) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid JSONL record');
  if (provider === 'codex') {
    if (!CODEx_TYPES.has(row.type)) return 'other';
    if (row.type !== 'event_msg') return row.type;
    const event = row.payload?.type;
    return ['task_started', 'task_complete', 'turn_aborted'].includes(event) ? event : 'event_msg';
  }
  if (provider === 'claude') {
    if (!CLAUDE_TYPES.has(row.type)) return 'other';
    return row.type === 'system' && row.subtype === 'turn_duration' ? 'turn_duration' : row.type;
  }
  throw new Error('unknown provider');
}

async function fingerprint(file, length) {
  const bytes = await file.slice(0, length).arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function scanJsonlFile(file, previous, provider, { chunkBytes = 1024 * 1024, maxBytes = 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 32 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('invalid read budget');
  }
  const headLength = previous?.headLength || Math.min(128, file.size);
  const headHash = await fingerprint(file, headLength);
  const restarted = !!previous && (file.size < previous.offset || previous.headHash !== headHash
    || (file.size === previous.offset && file.lastModified !== previous.lastModified));
  const cursor = restarted || !previous ? {
    offset: 0, lines: 0, types: {}, headLength: Math.min(128, file.size),
    headHash: restarted ? await fingerprint(file, Math.min(128, file.size)) : headHash,
  } : { ...previous, types: { ...previous.types } };
  cursor.lastModified = file.lastModified;
  let newLines = 0;
  let bytesRead = 0;
  while (cursor.offset < file.size && bytesRead < maxBytes) {
    const length = Math.min(chunkBytes, maxBytes - bytesRead, file.size - cursor.offset);
    const bytes = new Uint8Array(await file.slice(cursor.offset, cursor.offset + length).arrayBuffer());
    bytesRead += bytes.length;
    const lastNewline = bytes.lastIndexOf(10);
    if (lastNewline === -1) {
      if (length === chunkBytes && cursor.offset + length < file.size) throw new Error('JSONL line exceeds read chunk');
      break;
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, lastNewline + 1)); }
    catch { throw new Error('invalid JSONL UTF-8'); }
    for (const raw of text.slice(0, -1).split('\n')) {
      let row;
      try { row = JSON.parse(raw); }
      catch { throw new Error('invalid JSONL syntax'); }
      const type = eventType(row, provider);
      cursor.types[type] = (cursor.types[type] || 0) + 1;
      cursor.lines++;
      newLines++;
    }
    cursor.offset += lastNewline + 1;
    if (lastNewline + 1 < bytes.length) break; // Next tick can reread the incomplete tail.
  }
  return { cursor, newLines, bytesRead, restarted };
}
