// Matching is intentionally deterministic and local. No source text, commands,
// absolute directories or arbitrary branch strings are returned in diagnostics.
const COORD = '[A-Za-z0-9_.-]{1,100}';
const TASK = new RegExp('^https://github\\.com/(' + COORD + ')/(' + COORD + ')/(issues|pull)/([1-9][0-9]{0,14})/?$', 'i');
const LINK = new RegExp('https://github\\.com/' + COORD + '/' + COORD + '/(?:issues|pull)/[1-9][0-9]{0,14}(?![0-9A-Za-z])', 'gi');
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const validId = value => typeof value === 'string' && SAFE_ID.test(value) ? value : null;
const boundedString = (value, max) => typeof value === 'string' && value.length <= max ? value : null;
const ms = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
export const MATCH_RULE_VERSION = 2;

export function githubTask(value) {
  const match = typeof value === 'string' && value.match(TASK);
  if (!match) return null;
  const [, owner, repo, kind, number] = match;
  if ([owner, repo].some(part => part === '.' || part === '..')) return null;
  const repository = (owner + '/' + repo).toLowerCase();
  return { repository, kind: kind.toLowerCase(), number, url: 'https://github.com/' + repository + '/' + kind.toLowerCase() + '/' + number };
}
export function githubRepository(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  const match = value.match(new RegExp('^(?:https://github\\.com/|git@github\\.com:|ssh://git@github\\.com/)(' + COORD + ')/(' + COORD + ')/?$', 'i'));
  if (!match) return null;
  const owner = match[1], repo = match[2].replace(/\.git$/i, '');
  return repo && ![owner, repo].some(part => part === '.' || part === '..') ? (owner + '/' + repo).toLowerCase() : null;
}
export function branchIssueNumbers(value) {
  if (typeof value !== 'string' || value.length > 300) return [];
  // Accept conventional issue-prefixed path segments, not arbitrary numbers
  // in a branch name (versions, dates, commit abbreviations, etc.).
  const numbers = new Set();
  for (const part of value.split('/')) {
    if (/^\d{4}[-_]\d{1,2}[-_]\d{1,2}(?:[-_]|$)/.test(part)) continue;
    const match = part.match(/^(?:issue[-_]|#)?([1-9][0-9]{0,14})(?:[-_]|$)/i);
    if (match) numbers.add(match[1]);
  }
  return [...numbers].sort();
}
function promptRefs(parts) {
  let remaining = 32_768, incomplete = false;
  const refs = new Set();
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    if (part.length > remaining) incomplete = true;
    for (const match of part.slice(0, remaining).matchAll(LINK)) {
      const task = githubTask(match[0]);
      if (task) refs.add(task.url);
      if (refs.size > 20) return { refs: [], incomplete: true };
    }
    remaining = Math.max(0, remaining - part.length);
  }
  return { refs: [...refs].sort(), incomplete };
}

/** Small transient evidence records. Caller must not persist these rows. */
export function extractCodexMatchingRow(row) {
  const p = row?.payload;
  if (row?.type === 'session_meta') return { type: 'session', sessionId: validId(p?.id),
    repository: githubRepository(p?.git?.repository_url), branchNumbers: branchIssueNumbers(p?.git?.branch),
    cwd: boundedString(p?.cwd, 4096), client: p?.originator === 'air-plugin:phpstorm' ? 'phpstorm'
      : p?.originator === 'codex_exec' ? 'exec' : 'other' };
  const turnId = validId(p?.turn_id);
  if (!turnId) return null; // Never guess ownership of an unscoped prompt.
  if (row.type === 'turn_context') return { type: 'context', turnId, cwd: boundedString(p.cwd, 4096) };
  if (row.type !== 'event_msg') return null;
  if (['task_started', 'task_complete', 'turn_aborted'].includes(p.type)) {
    return { type: p.type, turnId, timestamp: row.timestamp };
  }
  if (p.type === 'item_completed' && p.item?.type === 'UserMessage' && Array.isArray(p.item.content)) {
    return { type: 'prompt', turnId, ...promptRefs(p.item.content.filter(block => block?.type === 'text').map(block => block.text)) };
  }
  if (p.type === 'user_message' && typeof p.message === 'string') {
    return { type: 'prompt', turnId, ...promptRefs([p.message]) };
  }
  return null;
}

export function matchingEvidenceByTurn(rows) {
  const result = new Map();
  let session = null;
  for (const row of rows) {
    if (row.type === 'session') { session = row; continue; }
    if (!session?.sessionId || !row.turnId) continue;
    const key = JSON.stringify([session.sessionId, row.turnId]);
    let e = result.get(key);
    if (!e) {
      e = { sessionId: session.sessionId, turnId: row.turnId, repository: session.repository,
        branchNumbers: session.branchNumbers, client: session.client, contextSeen: false, cwdMismatch: false,
        refs: [], promptScanIncomplete: false, startedAt: null, endedAt: null };
      result.set(key, e);
    }
    if (row.type === 'context') {
      e.contextSeen ||= Boolean(row.cwd && session.cwd);
      if (row.cwd && session.cwd && row.cwd !== session.cwd) e.cwdMismatch = true;
    } else if (row.type === 'prompt') {
      if (row.semantic) {
        e.semanticMessages ||= [];
        if (!e.semanticMessages.some(m => m.text === row.semantic.text && m.kind === row.semantic.kind)) {
          e.semanticMessages.push(row.semantic);
          e.semanticMessages = e.semanticMessages.slice(-4);
        }
      }
      if (row.semanticOmitted) e.semanticOmitted = true;
      e.refs = [...new Set([...e.refs, ...row.refs])].sort();
      e.promptScanIncomplete ||= row.incomplete || e.refs.length > 20;
      if (e.refs.length > 20) e.refs = [];
    } else if (row.type === 'task_started') {
      const t = ms(row.timestamp);
      if (t !== null && (e.startedAt === null || t < e.startedAt)) e.startedAt = t;
    } else if (['task_complete', 'turn_aborted'].includes(row.type)) {
      const t = ms(row.timestamp);
      if (t !== null && (e.endedAt === null || t < e.endedAt)) e.endedAt = t;
    }
  }
  return [...result.values()];
}

/** Group the actual tracked entries, not all repository issues. */
export function matchingTasks(records, dayStart, dayEnd) {
  const tasks = new Map();
  for (const row of records) {
    const start = ms(row.startedAt), end = ms(row.endedAt);
    if (start === null || end === null || end <= start || start >= dayEnd || end <= dayStart ||
        typeof row.taskUrl !== 'string' || !row.taskUrl || row.taskUrl.length > 2048) continue;
    const canonical = githubTask(row.taskUrl)?.url ?? row.taskUrl;
    let task = tasks.get(canonical);
    if (!task) {
      task = { url: canonical, title: String(row.taskTitle || canonical).slice(0, 500), intervals: [] };
      tasks.set(canonical, task);
    }
    task.intervals.push({ start, end, active: Boolean(row.active) });
  }
  return [...tasks.values()].sort((a, b) => a.url.localeCompare(b.url));
}

export function explainAgentMatch(turn, evidence, tasks, { partial = false } = {}) {
  const start = ms(turn.startedAt), end = ms(turn.endedAt);
  const validInterval = start !== null && end !== null && end >= start;
  const repo = evidence?.cwdMismatch ? null : evidence?.repository ?? null;
  const refs = evidence?.refs ?? [];
  const candidates = tasks.map(task => {
    const identity = githubTask(task.url);
    const overlapMs = validInterval ? task.intervals.reduce((sum, interval) =>
      sum + Math.max(0, Math.min(end, interval.end) - Math.max(start, interval.start)), 0) : 0;
    const contained = validInterval && task.intervals.some(interval => start >= interval.start &&
      start < interval.end && end <= interval.end);
    const repository = Boolean(repo && identity?.repository === repo);
    const branch = Boolean(repository && identity.kind === 'issues' && evidence.branchNumbers.includes(identity.number));
    const explicit = refs.includes(task.url);
    return { url: task.url, title: task.title, overlapMs, contained, repository, branch, explicit };
  });
  let reason = 'no_strong_identity', matchedUrl = null, state = 'unassigned';
  const strong = candidates.filter(c => (c.contained || c.overlapMs > 0) && (c.explicit || c.branch));
  const explicitIdentity = refs.length === 1 ? githubTask(refs[0]) : null;
  const contradictoryBranch = Boolean(explicitIdentity && repo && evidence?.branchNumbers?.length &&
    (explicitIdentity.repository !== repo || explicitIdentity.kind !== 'issues' ||
      !evidence.branchNumbers.includes(explicitIdentity.number)));
  const explicitConflict = refs.length > 1 || contradictoryBranch || (refs.length === 1 && strong.some(c => !c.explicit));
  const branchConflict = (evidence?.branchNumbers?.length ?? 0) > 1;
  if (partial) reason = 'task_history_incomplete';
  else if (!evidence || evidence.error) reason = evidence?.error || 'source_evidence_unavailable';
  else if (evidence.startedAt !== start || evidence.endedAt !== end) reason = 'source_lifecycle_changed';
  else if (!validInterval || !['completed', 'interrupted'].includes(turn.status) || turn.anchored === false) reason = 'interval_unverified';
  else if (evidence.promptScanIncomplete) reason = 'prompt_reference_scan_incomplete';
  else if (evidence.cwdMismatch) reason = 'working_directory_changed';
  else if (explicitConflict || branchConflict || strong.length > 1) reason = 'conflicting_identity';
  else if (strong.length === 1 && (strong[0].explicit || evidence.contextSeen)) {
    state = 'matched'; matchedUrl = strong[0].url;
    reason = strong[0].explicit ? (strong[0].contained ? 'explicit_url_and_containment' : 'explicit_url_and_overlap') : (strong[0].contained ? 'repository_branch_and_containment' : 'repository_branch_and_overlap');
  } else if (strong.length) reason = 'session_context_unverified';
  else if (candidates.some(c => c.explicit || c.branch)) reason = 'identity_outside_tracked_interval';
  else if (candidates.some(c => c.contained && c.repository)) reason = 'repository_only';
  else if (candidates.some(c => c.contained || c.overlapMs > 0)) reason = 'time_only';
  else reason = 'no_overlapping_task';
  return { state, reason, matchedUrl, candidates, signals: {
    repository: evidence?.repository ?? null, branchIssueNumbers: evidence?.branchNumbers ?? [],
    explicitTaskUrls: refs, contextSeen: Boolean(evidence?.contextSeen),
    cwdMismatch: Boolean(evidence?.cwdMismatch), client: evidence?.client ?? null,
  } };
}

// Exact interval arithmetic. No duration cap, no inference of developer idle
// time. A selected day clips only the view; original boundaries are retained.
function unionIntervals(intervals) {
  const sorted = intervals.filter(i => i.end > i.start).sort((a,b) => a.start-b.start || a.end-b.end);
  const merged = [];
  for (const i of sorted) {
    const last = merged.at(-1);
    if (last && i.start <= last.end) last.end = Math.max(last.end,i.end);
    else merged.push({start:i.start,end:i.end});
  }
  return merged;
}
const intervalTotal = intervals => intervals.reduce((sum,i)=>sum+i.end-i.start,0);
export function buildTaskTimeline(intervals, turns, dayStart, dayEnd) {
  const observed = [], unverified = [], seen = new Set();
  for (const t of turns) {
    const id = t.key ?? t.turnId ?? t.upstreamTurnId;
    if (seen.has(id)) continue;
    seen.add(id);
    const start=ms(t.startedAt),end=ms(t.endedAt);
    const turn={turnId:t.turnId??t.upstreamTurnId??id,provider:t.provider,start,end,
      elapsedMs:t.elapsedMs??null,providerDurationMs:t.providerDurationMs??null,status:t.status,
      ...(t.attribution ? {attribution:t.attribution} : {})};
    // Only observed anchored lifecycle intervals count toward coverage.
    // Preserve any contradictory provider duration as distinct evidence.
    if (start===null || end===null || end<start || t.anchored===false ||
        !['completed','interrupted'].includes(t.status) ||
        !['high','medium'].includes(t.timingConfidence) ||
        t.elapsedMs!==end-start) {unverified.push(turn);continue;}
    observed.push(turn);
  }
  const windows = intervals.filter(i=>i.end>dayStart && i.start<dayEnd).map(i=>{
    const start=Math.max(i.start,dayStart),end=Math.min(i.end,dayEnd);
    const segments=observed.filter(t=>t.start<end && (t.end>start || (t.start===t.end && t.start>=start))).map(t=>({...t,visibleStart:Math.max(start,t.start),visibleEnd:Math.min(end,t.end)}))
      .sort((a,b)=>a.visibleStart-b.visibleStart||a.visibleEnd-b.visibleEnd);
    const covered=unionIntervals(segments.map(t=>({start:t.visibleStart,end:t.visibleEnd})));
    const gaps=[];
    let cursor=start;
    for(const i of covered){if(i.start>cursor)gaps.push({start:cursor,end:i.start});cursor=i.end;}
    if(cursor<end)gaps.push({start:cursor,end});
    return {start,end,trackedStart:i.start,trackedEnd:i.end,active:i.active,segments,gaps,
      trackedMs:end-start,coveredMs:intervalTotal(covered),uncoveredMs:intervalTotal(gaps)};
  }).sort((a,b)=>a.start-b.start||a.end-b.end);
  const trackedMs=intervalTotal(unionIntervals(windows));
  const coveredMs=intervalTotal(unionIntervals(windows.flatMap(w=>w.segments.map(t=>({start:t.visibleStart,end:t.visibleEnd})))));
  return {windows,unverified,trackedMs,coveredMs,uncoveredMs:trackedMs-coveredMs,coveragePct:trackedMs?100*coveredMs/trackedMs:null,
    matchedTurns:observed.length+unverified.length,observedTurnMs:observed.reduce((sum,t)=>sum+t.end-t.start,0)};
}

// Temporal overlap is independent of task attribution. Never promote a
// time-only observation to a match, including when there is just one timer.
export function buildObservedTaskTimeline(task, rows, dayStart, dayEnd, assignments = null) {
  const windows = task.intervals.map(i=>({start:Math.max(i.start,dayStart),end:Math.min(i.end,dayEnd)}))
    .filter(i=>i.end>i.start);
  const turns = rows.filter(row=>{
    const start=ms(row.startedAt),end=ms(row.endedAt);
    return windows.some(i=>{
      if(start!==null && end!==null && end>=start)
        return start===end ? start>=i.start && start<i.end : start<i.end && end>i.start;
      // Incomplete observations are shown at known endpoints only.
      return [start,end].some(t=>t!==null && t>=i.start && t<i.end);
    });
  }).map(row=>{
    const url=assignments===null ? row.matchedUrl : assignments.get(row.turnId)?.url;
    const attribution=url===task.url?'matched':url?'other_task':assignments!==null && assignments.has(row.turnId)?'model_unassigned':'unassigned';
    return {...row,key:JSON.stringify([row.provider,row.turnId]),attribution};
  });
  const timeline=buildTaskTimeline(task.intervals,turns,dayStart,dayEnd);
  const matched=buildTaskTimeline(task.intervals,turns.filter(t=>t.attribution==='matched'),dayStart,dayEnd);
  return {...timeline,observedTurns:timeline.matchedTurns,matchedTurns:matched.matchedTurns,
    matchedCoveredMs:matched.coveredMs,
    unresolvedTurns:turns.filter(t=>t.attribution==='unassigned'||t.attribution==='model_unassigned').length,
    otherTaskTurns:turns.filter(t=>t.attribution==='other_task').length};
}
