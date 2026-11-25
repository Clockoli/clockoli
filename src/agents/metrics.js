// Derived, metadata-only turn coverage. Durations describe observed turn elapsed time,
// not pure model execution or time that can be billed to a human timer.
const PROVIDERS = ['codex', 'claude'];
const FINAL_STATUSES = new Set(['completed', 'interrupted']);
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const duration = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const safeSum = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function markStaleOpenAgentTurns(turns, nowMs = Date.now()) {
  return turns.map(turn => {
    const started = turn.status === 'open' ? Date.parse(turn.startedAt) : NaN;
    return Number.isFinite(started) && nowMs - started > STALE_AFTER_MS
      ? { ...turn, status: 'stale_unknown' } : turn;
  });
}

function instant(value) {
  if (typeof value !== 'string' || !UTC_INSTANT.test(value)) return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  const canonical = new Date(epoch).toISOString();
  // Date.parse normalizes some impossible dates (e.g. February 30); reject them.
  if (canonical !== value.replace(/Z$/, value.includes('.') ?
    `${'0'.repeat(3 - value.slice(value.indexOf('.') + 1, -1).length)}Z` : '.000Z')) return null;
  return epoch;
}

function classify(turn) {
  if (!FINAL_STATUSES.has(turn.status)) return { bucket: 'unknown' };
  const start = instant(turn.startedAt);
  const end = instant(turn.endedAt);
  const interval = start !== null && end !== null && end >= start ? end - start : null;
  const elapsed = duration(turn.elapsedMs);
  const provider = duration(turn.providerDurationMs);
  const confidence = turn.timingConfidence;

  if (confidence === 'high' || confidence === 'medium') {
    if (turn.durationSource === 'event_interval' && interval !== null && elapsed === interval) {
      return { bucket: 'measured', ms: interval,
        interval: turn.anchored === false ? null : [start, end] };
    }
    if ((turn.durationSource === 'provider_duration' || turn.durationSource === 'event_interval') && provider !== null) {
      // A provider duration alone does not establish where the turn occurred.
      return { bucket: 'measured', ms: provider,
        interval: turn.anchored === false || interval !== provider ? null : [start, end] };
    }
  }
  if (turn.durationSource === 'estimated_window' && confidence === 'low' && elapsed !== null &&
      interval !== null && interval === elapsed) {
    return { bucket: 'estimated', ms: elapsed };
  }
  return { bucket: 'unknown' };
}

function safeScan(scan) {
  const result = {};
  if (!scan || typeof scan !== 'object') return result;
  if (typeof scan.complete === 'boolean') result.complete = scan.complete;
  for (const field of ['blockedFiles', 'unknownEvents', 'pendingBytes', 'parserGeneration', 'scannedFiles', 'scannedBytes']) {
    if (duration(scan[field]) !== null) result[field] = scan[field];
  }
  return result;
}

function snapshot(turns, scan) {
  const counts = { discovered: turns.length, measured: 0, estimated: 0, unknown: 0 };
  const status = { interrupted: 0, open: 0, staleUnknown: 0 };
  const time = { agentMs: 0, wallClockMs: 0, estimatedMs: 0, humanWaitingMs: null,
    overlapCount: 0, overlapMs: 0, unanchoredMeasuredTurns: 0 };
  const intervals = [];
  for (const turn of turns) {
    if (turn.status === 'interrupted') status.interrupted++;
    if (turn.status === 'open') status.open++;
    if (turn.status === 'stale_unknown') status.staleUnknown++;
    const value = classify(turn);
    counts[value.bucket]++;
    if (value.bucket === 'estimated') time.estimatedMs = safeSum(time.estimatedMs, value.ms);
    if (value.bucket === 'measured') {
      time.agentMs = safeSum(time.agentMs, value.ms);
      if (value.interval) intervals.push(value.interval);
      else time.unanchoredMeasuredTurns++;
    }
  }
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let unionEnd = null;
  let eligibleSum = 0;
  for (const [start, end] of intervals) {
    eligibleSum = safeSum(eligibleSum, end - start);
    if (unionEnd !== null && start < unionEnd && end > start) time.overlapCount++;
    if (unionEnd === null || start >= unionEnd) {
      time.wallClockMs = safeSum(time.wallClockMs, end - start);
      unionEnd = end;
    } else if (end > unionEnd) {
      time.wallClockMs = safeSum(time.wallClockMs, end - unionEnd);
      unionEnd = end;
    }
  }
  time.overlapMs = Math.max(0, eligibleSum - time.wallClockMs);
  return { turns: counts,
    measuredCoveragePct: counts.discovered ? 100 * counts.measured / counts.discovered : null,
    status, time, scan: safeScan(scan) };
}

/** Summarize distinct normalized turns; no identifiers or source text enter the result. */
export function summarizeAgentTurns(turns, scanHealth = {}) {
  const byProvider = { codex: [], claude: [] };
  const seen = new Set();
  for (const turn of Array.isArray(turns) ? turns : []) {
    if (!turn || !PROVIDERS.includes(turn.provider) || typeof turn.key !== 'string' || !turn.key || seen.has(turn.key)) continue;
    seen.add(turn.key);
    byProvider[turn.provider].push(turn);
  }
  return {
    codex: snapshot(byProvider.codex, scanHealth?.codex),
    claude: snapshot(byProvider.claude, scanHealth?.claude),
    all: snapshot([...byProvider.codex, ...byProvider.claude], scanHealth?.all ?? scanHealth),
  };
}
