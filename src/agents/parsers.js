// Pure, metadata-only projection. The caller supplies opaque file and upstream IDs
// before persistence; this module never hashes or stores source lines or paths.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const id = value => typeof value === 'string' && SAFE_ID.test(value) ? value : null;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const duration = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendarDay = new Date(Date.UTC(year, month - 1, day));
  if (calendarDay.getUTCFullYear() !== year || calendarDay.getUTCMonth() + 1 !== month
    || calendarDay.getUTCDate() !== day) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
const unknown = time => ({ type: 'unknown_event', timestamp: time });

/** Parse one already-decoded JSONL row; never return messages, paths or arbitrary keys. */
export function parseAgentRow(provider, row) {
  const source = object(row);
  const time = timestamp(source?.timestamp);
  if (provider === 'codex') {
    if (source?.type === 'session_meta') return { type: 'session_meta', timestamp: time, sessionId: id(source.payload?.id) };
    if (source?.type === 'turn_context') return { type: 'turn_context', timestamp: time };
    if (source?.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(source.payload?.type)) {
      return { type: source.payload.type, timestamp: time, turnId: id(source.payload.turn_id),
        ...(source.payload.duration_ms === undefined ? {} : { durationMs: duration(source.payload.duration_ms) }) };
    }
  } else if (provider === 'claude') {
    const base = { timestamp: time, sessionId: id(source?.sessionId), uuid: id(source?.uuid),
      parentUuid: id(source?.parentUuid), agentId: id(source?.agentId) };
    if (source?.type === 'user') {
      const content = source.message?.content;
      if (Array.isArray(content) && content.length && content.every(block => object(block)?.type === 'tool_result')) {
        return { type: 'tool_result', ...base };
      }
      if (typeof content === 'string' || (Array.isArray(content) && content.length)) return { type: 'user', ...base };
    }
    if (source?.type === 'assistant') return { type: 'assistant', ...base };
    if (source?.type === 'system' && source.subtype === 'turn_duration') {
      return { type: 'turn_duration', ...base, durationMs: duration(source.durationMs) };
    }
  }
  return unknown(time);
}

const key = (...parts) => JSON.stringify(parts);
function session(provider, fileKey, sessionId, agentId = null) {
  return { key: key(provider, fileKey, sessionId, agentId), provider, sourceFileKey: fileKey,
    upstreamSessionId: sessionId, upstreamFamilyKey: sessionId, agentId,
    parentSessionKey: null, sidechain: agentId !== null,
    firstObservedAt: null, lastObservedAt: null, cwdKey: null, repositoryKey: null,
    projectId: null, mapping: { source: 'unresolved', confidence: 'none' }, status: 'idle_unknown' };
}
function turn(provider, owner, turnId) {
  return { key: key(provider, owner.key, turnId), sessionKey: owner.key, provider,
    sourceFileKey: owner.sourceFileKey, upstreamTurnId: turnId, projectId: null,
    parentTurnKey: null, evidenceKeys: [turnId], projectConfidence: 'none',
    startedAt: null, endedAt: null, elapsedMs: null, providerDurationMs: null,
    durationSource: 'none', timingConfidence: 'none', status: 'open' };
}
function validScope(event) {
  return object(event) && id(event.fileKey) && id(event.sessionId);
}
function codexTurns(events, sessions, turns) {
  let unknownEvents = 0;
  for (const event of events) {
    if (!validScope(event)) { unknownEvents++; continue; }
    if (event.type === 'session_meta' || event.type === 'turn_context') continue;
    if (!['task_started', 'task_complete', 'turn_aborted'].includes(event.type) || !id(event.turnId)) {
      unknownEvents++; continue;
    }
    const owner = session('codex', event.fileKey, event.sessionId);
    sessions.set(owner.key, owner);
    const turnKey = key('codex', owner.key, event.turnId);
    const record = turns.get(turnKey) || turn('codex', owner, event.turnId);
    const time = timestamp(event.timestamp);
    if (event.type === 'task_started') {
      if (time && (!record.startedAt || time < record.startedAt)) record.startedAt = time;
    } else {
      const isAbort = event.type === 'turn_aborted';
      if (!record.endedAt || (time && time < record.endedAt)) {
        record.endedAt = time;
        record.status = isAbort ? 'interrupted' : 'completed';
      } else if (isAbort && record.status !== 'interrupted') record.status = 'interrupted';
      const ms = duration(event.durationMs);
      if (ms !== null && record.providerDurationMs === null) record.providerDurationMs = ms;
    }
    turns.set(turnKey, record);
  }
  for (const record of turns.values()) {
    if (record.endedAt && record.startedAt && record.endedAt >= record.startedAt) {
      record.elapsedMs = Date.parse(record.endedAt) - Date.parse(record.startedAt);
      record.durationSource = 'event_interval';
      record.timingConfidence = 'high';
    } else if (record.status !== 'open' && record.providerDurationMs !== null) {
      record.durationSource = 'provider_duration';
      record.timingConfidence = 'high';
    }
    if (record.status === 'open') record.endedAt = null;
  }
  return unknownEvents;
}

function claudeTurns(events, sessions, turns) {
  let unknownEvents = 0;
  const nodes = new Map();
  const durations = [];
  // UUID ancestry is scoped to an upstream session; file keys identify unrelated
  // sessions even when the same upstream session ID appears in multiple files.
  for (const event of events) {
    if (!validScope(event) || !['user', 'tool_result', 'assistant', 'turn_duration'].includes(event.type)
      || !id(event.uuid)) { unknownEvents++; continue; }
    const nodeKey = key(event.sessionId, event.uuid);
    if (event.type === 'turn_duration') { durations.push(event); continue; }
    const existing = nodes.get(nodeKey);
    if (existing) {
      if (existing.type !== event.type || existing.parentUuid !== (id(event.parentUuid) || null)) unknownEvents++;
      continue;
    }
    nodes.set(nodeKey, { type: event.type, uuid: event.uuid,
      parentUuid: id(event.parentUuid), fileKey: event.fileKey, sessionId: event.sessionId,
      agentId: id(event.agentId) });
  }
  function ancestor(event) {
    let current = event;
    const visited = new Set();
    while (current && current.parentUuid) {
      const parentKey = key(current.sessionId, current.parentUuid);
      if (visited.has(parentKey)) return null;
      visited.add(parentKey);
      const parent = nodes.get(parentKey);
      if (!parent) return null;
      if (parent.type === 'user') return parent;
      current = parent;
    }
    return null;
  }
  function add(candidate) {
    const owner = session('claude', candidate.fileKey, candidate.sessionId, candidate.agentId);
    sessions.set(owner.key, owner);
    const turnKey = key('claude', owner.key, candidate.uuid);
    if (!turns.has(turnKey)) turns.set(turnKey, turn('claude', owner, candidate.uuid));
    return turns.get(turnKey);
  }
  for (const node of nodes.values()) if (node.type === 'user') add(node);
  for (const event of durations) {
    if (duration(event.durationMs) === null || !id(event.parentUuid)) { unknownEvents++; continue; }
    const assistant = nodes.get(key(event.sessionId, event.parentUuid));
    const parent = assistant?.type === 'assistant' ? ancestor(assistant) : null;
    const candidate = parent || { uuid: event.parentUuid, fileKey: event.fileKey,
      sessionId: event.sessionId, agentId: id(event.agentId) };
    const record = add(candidate);
    record.providerDurationMs = event.durationMs;
    record.durationSource = 'provider_duration';
    record.timingConfidence = 'high';
    record.status = 'completed';
  }
  return unknownEvents;
}

/** Project caller-scoped, opaque-ID events. Results never include source JSON. */
export function projectAgentTurns(provider, events) {
  if (!['codex', 'claude'].includes(provider)) throw new TypeError('unknown provider');
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  const sessions = new Map();
  const turns = new Map();
  const unknownEvents = provider === 'codex'
    ? codexTurns(events, sessions, turns) : claudeTurns(events, sessions, turns);
  return { sessions: [...sessions.values()].sort((a, b) => a.key.localeCompare(b.key)),
    turns: [...turns.values()].sort((a, b) => a.key.localeCompare(b.key)), unknownEvents };
}
