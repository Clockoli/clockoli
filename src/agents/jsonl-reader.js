// Bounded read-only JSONL reader; decoded rows exist only within parseRow.
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_LINE_BYTES = 16 * 1024 * 1024;
const HEAD_BYTES = 256;
const TAIL_BYTES = 256;

async function bytes(file, start, end) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

function validBudget(value) { return Number.isSafeInteger(value) && value > 0; }

export async function scanAgentJsonl(file, previous, {
  chunkBytes = DEFAULT_CHUNK_BYTES, readBudget = DEFAULT_LINE_BYTES,
  maxLineBytes = DEFAULT_LINE_BYTES, fingerprint, parseRow,
  deadlineAt = Infinity,
} = {}) {
  if (![chunkBytes, readBudget, maxLineBytes].every(validBudget)
      || typeof fingerprint !== 'function' || typeof parseRow !== 'function') {
    throw new TypeError('Invalid journal scan parameters');
  }
  const headLength = previous?.headLength ?? Math.min(HEAD_BYTES, file.size);
  const headHash = await fingerprint(await bytes(file, 0, headLength));
  let restarted = Boolean(previous && (file.size < previous.offset || headHash !== previous.headHash));
  if (previous && !restarted && previous.tailHash !== undefined) {
    const tail = await bytes(file, Math.max(0, previous.offset - TAIL_BYTES), previous.offset);
    if (await fingerprint(tail) !== previous.tailHash) restarted = true;
  }
  const actualHeadLength = restarted ? Math.min(HEAD_BYTES, file.size) : headLength;
  const cursor = {
    offset: restarted ? 0 : previous?.offset || 0,
    lines: restarted ? 0 : previous?.lines || 0,
    headLength: actualHeadLength,
    headHash: restarted ? await fingerprint(await bytes(file, 0, actualHeadLength)) : headHash,
    size: file.size,
    lastModified: file.lastModified ?? null,
  };
  const events = [];
  let unknownEvents = 0, bytesRead = 0, blockedCode = null;
  let position = cursor.offset;
  const initialOffset = cursor.offset;
  let pending = new Uint8Array(0);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (position < file.size && bytesRead < readBudget && Date.now() < deadlineAt) {
    const length = Math.min(chunkBytes, readBudget - bytesRead, file.size - position);
    const chunk = await bytes(file, position, position + length);
    if (!chunk.length) { blockedCode = 'read_stalled'; break; }
    bytesRead += chunk.length;
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      const segment = chunk.subarray(start, index);
      const lineLength = pending.length + segment.length;
      if (lineLength > maxLineBytes) { blockedCode = 'line_too_large'; break; }
      const combined = new Uint8Array(lineLength);
      combined.set(pending); combined.set(segment, pending.length);
      try {
        const row = JSON.parse(decoder.decode(combined));
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid row');
        const event = parseRow(row);
        if (event?.kind === 'unknown') unknownEvents++;
        else if (event) events.push(event);
      } catch {
        blockedCode = 'invalid_jsonl';
        break;
      }
      cursor.offset = position + index + 1;
      cursor.lines++;
      pending = new Uint8Array(0);
      start = index + 1;
    }
    if (blockedCode) break;
    const rest = chunk.subarray(start);
    if (rest.length) {
      if (pending.length + rest.length > maxLineBytes) { blockedCode = 'line_too_large'; break; }
      const next = new Uint8Array(pending.length + rest.length);
      next.set(pending); next.set(rest, pending.length); pending = next;
    }
    position += chunk.length;
  }
  if (position < file.size && cursor.offset === initialOffset && pending.length >= maxLineBytes) {
    blockedCode = 'line_too_large';
  }
  cursor.tailHash = await fingerprint(await bytes(file, Math.max(0, cursor.offset - TAIL_BYTES), cursor.offset));
  return { cursor, events, unknownEvents, bytesRead, restarted, blockedCode,
    atEnd: position >= file.size, backlog: !blockedCode && cursor.offset < file.size };
}
