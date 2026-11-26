import { activeRecordPath, assertUserMonthlyRecordsPath, localTimestamp, monthlyRecordsPath, normalizePlainTitle, parseActiveRecord, parseMonthlyRecords, serializeActiveRecord, serializeMonthlyRecords } from '../domain/work-records.js';
import { applyActiveEdits, applyActiveStartEdit, applyEntryEdits, buildActiveTimer, buildEntry, isBillable, localDateInTimezone, validateActiveTimer, validateEntry } from '../domain/records.js';
import { parseBulkTimeText } from '../domain/bulk-time.js';
import { applyTaskIndexChanges, parseTaskIndex, serializeTaskIndex, TASK_INDEX_PATH } from '../domain/task-index.js';
import { createUlid } from '../domain/ulid.js';
import { entryDateParts, entryDateValue, localDateParts, normalizeStoredTaskIdentity, normalizeTaskUrl, parseGitHubTaskUrl, taskUrlOf, validateEntryId, validatePathSegment } from '../domain/values.js';

export class TrackerConflictError extends Error {
  constructor(message, reason = '') { super(message); this.name = 'TrackerConflictError'; this.code = 'conflict'; this.reason = reason; }
}

function isNotFound(error) { return error?.status === 404 || error?.code === 'not_found'; }
function isConflict(error) { return error?.status === 409 || error?.code === 'conflict'; }
function isRejectedCreate(error) { return isConflict(error) || error?.status === 422 || error?.code === 'validation'; }
function isRetryableReadFailure(error) { return error instanceof TypeError || Number(error?.status) >= 500; }
function isRemoteRecord(record) { return !record._pending && typeof record._sha === 'string' && record._sha.length > 0; }
function recoveryProjection({ active, recent, pendingWrites }) {
  const records = [active, ...recent].filter(Boolean);
  return {
    pendingCount: pendingWrites.length,
    pendingWrites: pendingWrites.map(({ id, operation, status, stage, conflictReason }) => ({
      id, status, stage, ...(status === 'conflict' ? { operation } : {}), ...(conflictReason ? { conflictReason } : {}),
    })),
    // Successful writes retain the returned blob SHA; an empty queue is not proof of a save.
    remoteWriteConfirmed: pendingWrites.length === 0 && records.length > 0
      && records.every(isRemoteRecord),
  };
}

function isPermanentQueuedWriteFailure(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status < 500
    && ![404, 409].includes(status) && error?.code !== 'rate_limit';
}
function taskTitleOf(value) { return normalizePlainTitle(value?.taskTitle ?? value?.issueTitle); }
function withTaskIdentityHistory(updated, previous) {
  const metadata = structuredClone(updated.metadata ?? {});
  const clockoli = metadata.clockoli && typeof metadata.clockoli === 'object' && !Array.isArray(metadata.clockoli)
    ? structuredClone(metadata.clockoli) : {};
  const history = Array.isArray(clockoli.task_identity_history) ? structuredClone(clockoli.task_identity_history) : [];
  clockoli.task_identity_history = [...history, { url: taskUrlOf(previous), title: taskTitleOf(previous) }];
  return { ...updated, metadata: { ...metadata, clockoli } };
}
function taskLabel(value) { const url = taskUrlOf(value), github = parseGitHubTaskUrl(url); return github ? `${github.owner}/${github.repo}#${github.number}` : url; }
function trackedDurationLabel(value) {
  const total = Math.max(0, Math.floor(Number(value?.durationSeconds) || 0));
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
  return `${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${seconds}s`;
}
function githubActorRelationships(github, actor) {
  const actorId = String(actor?.id || '').match(/^github:(\d+)$/)?.[1] || '';
  const actorName = String(actor?.name || '').toLowerCase();
  const matches = identity => Boolean(identity) && (actorId
    ? String(identity.id || '') === actorId
    : actorName && String(identity.login || '').toLowerCase() === actorName);
  const relationships = [];
  if (matches(github?.author)) relationships.push('author');
  if ((github?.assignees ?? []).some(matches)) relationships.push('assignee');
  if ((github?.pull_request?.requested_reviewers ?? []).some(value => value?.kind === 'user' && matches(value))) relationships.push('reviewer');
  return relationships.length ? relationships : ['other'];
}

function sameTimer(a, b) { return Boolean(a?.id && b?.id) && a.id === b.id; }
function timerStartedAt(value) { return new Date(value?.startedAt).getTime(); }
function assertNoActiveOverlap(entries, active) {
  if (active && entries.some(entry => entry.id !== active.id && new Date(entry.endedAt).getTime() > timerStartedAt(active))) {
    const localStart = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: active.timezone,
    }).format(new Date(active.startedAt));
    throw new TrackerConflictError(`This edit would overlap the running timer (Start: ${localStart} ${active.timezone}; ${active.startedAt} UTC). Set the entry End no later than that Start. If Activity says Not tracking, check pending synchronization before changing either record.`);
  }
}
function assertNoCompletedOverlap(updated, entries) {
  const start = new Date(updated.startedAt).getTime(), end = new Date(updated.endedAt).getTime();
  const conflicting = entries.find(entry => entry.id !== updated.id
    && new Date(entry.startedAt).getTime() < end && new Date(entry.endedAt).getTime() > start);
  if (conflicting) {
    const error = new TrackerConflictError('This edit would overlap another entry. Choose a free time range before moving it.');
    error.conflictWith = conflicting;
    throw error;
  }
}
function runningCompletedOverlap(active, entries, through) {
  const start = timerStartedAt(active), end = new Date(through).getTime();
  if (start >= end) return null;
  return entries.find(entry => {
    const otherStart = new Date(entry.startedAt).getTime(), otherEnd = new Date(entry.endedAt).getTime();
    return otherStart < otherEnd && otherStart < end && otherEnd > start;
  }) ?? null;
}
function assertNoRunningCompletedOverlap(active, entries, through) {
  const conflicting = runningCompletedOverlap(active, entries, through);
  if (conflicting) {
    const error = new TrackerConflictError('Timer start would overlap another time entry. Choose a start after that entry ends.');
    error.conflictWith = conflicting;
    throw error;
  }
}
function isNewerTimer(candidate, current) { return timerStartedAt(candidate) > timerStartedAt(current); }
function sameCompletion(entry, operation) { return Boolean(entry?.id && operation?.entry?.id) && entry.id === operation.entry.id; }

function sameValue(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

const SAVED_ENTRY_FIELDS = ['id', 'taskUrl', 'entryDate', 'timezone', 'startedAt', 'endedAt', 'updatedAt', 'description'];
function matchesQueuedOriginal(request, saved) {
  return SAVED_ENTRY_FIELDS.every(key => sameValue(request?.original?.[key], saved?.[key]));
}

function onlyEndEdit(request) {
  return request?.edits && Object.entries(request.edits).every(([key, value]) =>
    key === 'endedAt' || (['taskUrl', 'taskTitle', 'startedAt', 'description'].includes(key)
      && sameValue(value, request.original?.[key]))
    || (key === 'billable' && sameValue(value, isBillable(request.original))));
}

function mergeSupersededEntryRequests(earlier, later) {
  const earliestOriginal = structuredClone(earlier.original);
  const edits = { ...(later.edits ?? {}) };
  for (const [field, earlierValue] of Object.entries(earlier.edits ?? {})) {
    if (Object.hasOwn(edits, field)) continue;
    if (!Object.hasOwn(later.original ?? {}, field)) {
      edits[field] = earlierValue;
      continue;
    }
    const latestAcceptedValue = later.original[field];
    if (!sameValue(latestAcceptedValue, earliestOriginal?.[field])) edits[field] = structuredClone(latestAcceptedValue);
  }
  return {
    ...later,
    path: earlier.path,
    originalSha: earlier.originalSha,
    index: earlier.index,
    original: earliestOriginal,
    edits,
  };
}

function queuedEntryEditsSatisfied(remote, edits) {
  if (!remote) return false;
  try {
    const projected = applyEntryEdits(remote, edits, new Date(remote.updatedAt));
    return ['taskUrl', 'taskTitle', 'issueTitle', 'startedAt', 'endedAt',
      'entryDate', 'timezone', 'description', 'durationSeconds']
      .every(key => sameValue(projected[key], remote[key]))
      && (edits.billable === undefined || projected.metadata?.billable === remote.metadata?.billable);
  } catch { return false; }
}

function entryEditHasValidInterval(request) {
  const startedAt = new Date(request?.edits?.startedAt ?? request?.original?.startedAt).getTime();
  const endedAt = new Date(request?.edits?.endedAt ?? request?.original?.endedAt).getTime();
  return Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt;
}

function assertQueuedEntryIntervals(requests) {
  if (!Array.isArray(requests) || !requests.length || requests.some(request => !entryEditHasValidInterval(request))) {
    throw new TrackerConflictError(
      'The saved edit has an invalid time range. End time must not be before start time.',
      'queued_write_validation',
    );
  }
}

function repairInvertedEntryEdit(request, recentCache) {
  if (entryEditHasValidInterval(request)) return request;
  const cached = (recentCache ?? []).find(entry => entry?._pending && entry?._path === request?.path
    && entry?.id && entry.id === request?.original?.id);
  const cachedStart = new Date(cached?.startedAt).getTime(), cachedEnd = new Date(cached?.endedAt).getTime();
  if (!Number.isFinite(cachedStart) || !Number.isFinite(cachedEnd) || cachedEnd < cachedStart) return request;
  const edits = { ...(request.edits ?? {}) };
  for (const field of ['startedAt', 'endedAt']) {
    if (sameValue(cached[field], request.original?.[field])) delete edits[field];
    else edits[field] = cached[field];
  }
  return { ...request, edits };
}

function compactSupersededQueue(pendingWrites, recentCache = []) {
  const queue = structuredClone(pendingWrites ?? []), latestByTarget = new Map(), removed = new Set();
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const operation = queue[index], type = operation.operation ?? operation.stage;
    // A previous sync may have written this operation before a worker restart.
    // Never merge a newer edit into that in-flight snapshot.
    if (operation.syncInFlight) { latestByTarget.clear(); continue; }
    if (type === 'editEntry') {
      const request = operation.request, targetId = request?.original?.id;
      if (!request?.path || !targetId) { latestByTarget.clear(); continue; }
      const key = `entry\u0000${request.path}\u0000${targetId}`, laterIndex = latestByTarget.get(key);
      if (laterIndex === undefined) { latestByTarget.set(key, index); continue; }
      const later = queue[laterIndex];
      later.request = mergeSupersededEntryRequests(request, later.request);
      removed.add(index);
      continue;
    }
    if (type === 'editActiveStart') {
      const targetId = operation.original?.id;
      if (!targetId) { latestByTarget.clear(); continue; }
      const key = `active\u0000${targetId}`, laterIndex = latestByTarget.get(key);
      if (laterIndex === undefined) { latestByTarget.set(key, index); continue; }
      const later = queue[laterIndex];
      later.original = structuredClone(operation.original);
      if (later.startedAt === undefined && operation.startedAt !== undefined) later.startedAt = operation.startedAt;
      if (later.description === undefined && operation.description !== undefined) later.description = operation.description;
      if (later.billable === undefined && operation.billable !== undefined) later.billable = operation.billable;
      removed.add(index);
      continue;
    }
    // Multi-record edits and timer lifecycle operations are ordering barriers.
    // Their atomic/dependency semantics must remain intact.
    latestByTarget.clear();
  }
  for (const operation of queue) {
    if ((operation.operation ?? operation.stage) !== 'editEntry') continue;
    const repaired = repairInvertedEntryEdit(operation.request, recentCache);
    if (repaired === operation.request) continue;
    operation.request = repaired;
    if (operation.conflictReason === 'queued_write_validation') {
      operation.status = 'pending';
      operation.lastError = '';
      operation.conflictReason = '';
    }
  }
  return queue.filter((_, index) => !removed.has(index));
}

function trailingSupersedable(queue, matches) {
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const operation = queue[index], type = operation.operation ?? operation.stage;
    if (operation.syncInFlight || !['editEntry', 'editActiveStart'].includes(type)) return null;
    if (matches(operation)) return operation;
  }
  return null;
}

function operationEditsEntry(operation, id) {
  const type = operation?.operation ?? operation?.stage;
  if (type === 'editEntry') return operation.request?.original?.id === id;
  if (type === 'editEntries') return (operation.request?.entries ?? []).some(request => request?.original?.id === id);
  return false;
}


function indexedTasksForRecord(taskIndex, id) {
  return Object.entries(taskIndex.index.tasks).filter(([, task]) => task.recordIds.includes(id)).map(([url]) => url);
}

function hasSavedCompletion(taskIndex, entries, id) {
  return indexedTasksForRecord(taskIndex, id).length > 0 || entries.some(entry => entry.id === id);
}

function recoveryRecordFields(entry) {
  return entry ? { id: entry.id, taskUrl: taskUrlOf(entry), taskTitle: taskTitleOf(entry),
    entryDate: entry.entryDate, timezone: entry.timezone, startedAt: entry.startedAt,
    ...(entry.endedAt ? { endedAt: entry.endedAt } : {}),
    description: entry.description || '', billable: isBillable(entry) } : null;
}

function recoveredAddition(entry, now, queueLength) {
  return { operation: 'addTime', id: createUlid(now.getTime() + queueLength),
    status: 'pending', stage: 'addTime', entry: stripInternal(entry),
    retryCount: 0, queuedAt: now.toISOString(), lastError: '' };
}

function assertRecoveryStateUnchanged(latest, reviewed, message) {
  if (!sameValue(latest.pendingWrites, reviewed.pendingWrites)
      || !sameValue(latest.activeCache, reviewed.activeCache)) {
    throw new TrackerConflictError(message);
  }
}

function replaceRecoveryOperations(queue, index, removed, ...replacement) {
  const next = structuredClone(queue).filter((_, at) => !removed.includes(at));
  next.splice(index, 0, ...replacement);
  return next;
}

function savedRecoveryCache(state, saved) {
  return {
    recentCache: [saved, ...(state.recentCache ?? []).filter(entry => entry.id !== saved.id)]
      .sort(newestFirst).slice(0, 50),
    ...(state.summaryCache?.weekEntries ? { summaryCache: { ...state.summaryCache,
      weekEntries: state.summaryCache.weekEntries.map(entry => entry.id === saved.id ? saved : entry) } } : {}),
    ...(state.dayRangeIntervals ? { dayRangeIntervals: updateDayRangeIntervals(state.dayRangeIntervals, [saved]) } : {}),
  };
}

function removedRecoveryCache(state, id) {
  return {
    recentCache: (state.recentCache ?? []).filter(entry => entry.id !== id),
    ...(state.summaryCache?.weekEntries ? { summaryCache: { ...state.summaryCache,
      weekEntries: state.summaryCache.weekEntries.filter(entry => entry.id !== id) } } : {}),
    ...(state.dayRangeIntervals ? { dayRangeIntervals: state.dayRangeIntervals.filter(entry => entry.id !== id) } : {}),
  };
}

function stoppedOverlapReferencesEntry(operation, id) {
  const type = operation?.operation ?? operation?.stage;
  return operation?.id === id || operationEditsEntry(operation, id)
    || operation?.entry?.id === id || operation?.activeSnapshot?.id === id
    || operation?.nextActive?.id === id || operation?.original?.id === id
    || operation?.request?.original?.id === id || operation?.blockedBy?.operationId === id
    || (type === 'bulkAddTimes' && operation.entries?.some(entry => entry.id === id));
}


function stoppedOverlapTimerParts(queue, timerId) {
  const starts = queue.filter(item => item.operation === 'startTimer' && item.id === timerId);
  const stops = queue.filter(item => item.operation === 'completeTimer' && item.id === timerId);
  if (starts.length !== 1 || stops.length !== 1) {
    return { reason: 'This pending timer does not have one matching Start and Stop.' };
  }
  const start = starts[0], stop = stops[0];
  const startIndex = queue.indexOf(start), stopIndex = queue.indexOf(stop);
  if (start.status !== 'conflict' || start.conflictReason !== 'add_time_overlap_changed'
      || start.stage !== 'startNext' || !start.requireNoOverlap || !start.nextActive
      || !['verifyActive', 'appendMonthly'].includes(stop.stage) || stopIndex <= startIndex
      || !sameTimer(start.nextActive, stop.entry) || !sameTimer(start.nextActive, stop.activeSnapshot)
      || start.nextActive.startedAt !== stop.entry.startedAt
      || start.nextActive.startedAt !== stop.activeSnapshot.startedAt) {
    return { reason: 'The pending Start or Stop changed. Review the queued operations.' };
  }
  return { start, stop, startIndex, stopIndex };
}

function stoppedOverlapLocalDeletionParts(queue, timerId) {
  const parts = stoppedOverlapTimerParts(queue, timerId);
  if (parts.reason) return { safe: false, reason: parts.reason };
  const { start, stop } = parts;
  if (queue.some(item => item !== start && item !== stop && stoppedOverlapReferencesEntry(item, timerId))) {
    return { safe: false, reason: 'Another pending change depends on this timer.' };
  }
  return { ...parts, safe: true };
}

function stoppedOverlapQueueParts(queue, timerId, previousId = null) {
  const parts = stoppedOverlapTimerParts(queue, timerId);
  if (parts.reason || parts.stopIndex !== parts.startIndex + 1) return null;
  const { start, stop, stopIndex } = parts;
  const edits = previousId === null ? [] : queue.filter(item => operationEditsEntry(item, previousId));
  const edit = edits.length === 1 && edits[0].operation === 'editEntry' ? edits[0] : null;
  const editIndex = edit ? queue.indexOf(edit) : -1;
  const safe = stop.status !== 'conflict' && (edits.length === 0
    || (edit && editIndex > stopIndex && edit.status === 'pending'))
    && (previousId === null || !queue.some(item => item !== start && item !== stop && item !== edit
      && (stoppedOverlapReferencesEntry(item, timerId) || stoppedOverlapReferencesEntry(item, previousId))));
  return { ...parts, edit, editIndex, safe };
}

// A task switch can be followed by several locally accepted switches before
// an older Stop reaches GitHub. Preserve that later running timer when recovering
// the first Stop; only trust an unbroken chain of matching queued switches.
function queuedSwitchChainReachesActive(queue, afterIndex, initialActive, activeCache) {
  if (!initialActive?.id || !activeCache?._pending) return false;
  let current = initialActive, steps = 0;
  for (const operation of queue.slice(afterIndex + 1)) {
    if (!stoppedOverlapReferencesEntry(operation, current.id)) continue;
    if (operation.operation !== 'completeTimerAndStart' || operation.id !== current.id
        || !sameTimer(operation.activeSnapshot, current) || !operation.nextActive?.id
        || operation.nextActive.id === current.id) return false;
    current = operation.nextActive;
    steps += 1;
  }
  return steps > 0 && sameTimer(current, activeCache);
}

function pendingCompletionConflictParts(queue, operationId, activeCache) {
  const matches = queue.filter(item => ['completeTimer', 'completeTimerAndStart'].includes(item.operation)
    && item.id === operationId);
  if (matches.length !== 1) return null;
  const stop = matches[0], index = queue.indexOf(stop);
  const verificationConflict = stop.stage === 'verifyActive'
    && ['active_missing_no_completion', 'active_changed_no_completion'].includes(stop.conflictReason);
  // Older persisted switches may fail during commitCompletion with no explicit
  // reason. Their original completed entry is still durable in the queue.
  const interruptedCommit = ['appendMonthly', 'commitCompletion'].includes(stop.stage);
  if (stop.status !== 'conflict' || !(verificationConflict || interruptedCommit)
      || !stop.entry || !sameTimer(stop.entry, stop.activeSnapshot)
      || stop.monthlyPath !== monthlyRecordsPath(stop.entry.user, stop.entry.entryDate)
      || (stop.operation === 'completeTimerAndStart'
        && (!stop.nextActive?.id || stop.nextActive.id === stop.entry.id))) return null;
  const dependent = queue.some(item => item !== stop && stoppedOverlapReferencesEntry(item, stop.entry.id));
  // A later timer may already be active in this browser (or mirrored from
  // GitHub). It must not prevent recovering older completed time; the
  // corrected interval and queued next Start are checked separately.
  const laterQueuedSwitch = stop.nextActive
    && queuedSwitchChainReachesActive(queue, index, stop.nextActive, activeCache);
  const activeUnexpected = activeCache?.id === stop.entry.id
    || Boolean(stop.nextActive && activeCache?._pending
      && activeCache.id !== stop.nextActive.id && !laterQueuedSwitch);
  const duplicateStart = stop.nextActive && queue.some(item => item !== stop
    && item.operation === 'startTimer' && item.id === stop.nextActive.id);
  return { stop, index, safe: !dependent && !activeUnexpected && !duplicateStart,
    reason: dependent ? 'Another pending change depends on the stopped time.'
      : activeUnexpected ? 'A different timer is active locally. Review it before recovering this switch.'
        : duplicateStart ? 'The next timer already has a queued Start.' : '' };
}

function recoveredSwitchStart(operation) {
  if (!operation.nextActive) return null;
  // Never overwrite a newer GitHub timer as part of recovering a stopped
  // completion. The pending Start must pass the ordinary overlap checks.
  return { operation: 'startTimer', id: operation.nextActive.id, status: 'pending',
    stage: 'startNext', nextActive: structuredClone(operation.nextActive),
    queuedAt: operation.queuedAt, retryCount: 0, lastError: '',
    requireNoOverlap: true, alignmentRequiresEmptyRemote: true };
}

function activeStartConflictParts(queue, operationId, activeCache) {
  const matches = queue.filter(item => item.id === operationId && item.operation === 'editActiveStart');
  if (matches.length !== 1 || matches[0].status !== 'conflict') return null;
  const edit = matches[0], editIndex = queue.indexOf(edit), timerId = edit.original?.id;
  if (!timerId || !edit.original?.startedAt || !edit.startedAt) return null;
  const stops = queue.filter(item => item.operation === 'completeTimer' && item.id === timerId);
  const stop = stops.length === 1 ? stops[0] : null, stopIndex = stop ? queue.indexOf(stop) : -1;
  const dependent = queue.some(item => item !== edit && item !== stop
    && stoppedOverlapReferencesEntry(item, timerId));
  const safe = stops.length <= 1 && !dependent
    && (stop
      ? stopIndex > editIndex && stop.status === 'pending' && ['verifyActive', 'appendMonthly'].includes(stop.stage)
        && sameTimer(stop.activeSnapshot, edit.original) && sameTimer(stop.entry, edit.original)
        && stop.activeSnapshot.startedAt === edit.startedAt && stop.entry.startedAt === edit.startedAt
      : activeCache?.id === timerId && activeCache.startedAt === edit.startedAt);
  return { edit, stop, editIndex, stopIndex, timerId, safe,
    reason: dependent ? 'Another queued operation depends on this timer and must be reviewed first.'
      : stops.length > 1 ? 'Multiple stopped completions refer to this timer.'
        : stop && !safe ? 'The queued Stop no longer matches the start-time change.'
          : !safe ? 'The running timer changed locally after this edit.' : '' };
}

function completedWriteFootprint(operation) {
  const type = operation?.operation ?? operation?.stage;
  const requests = type === 'editEntry' || type === 'deleteEntry' ? [operation.request]
    : type === 'editEntries' ? operation.request?.entries : null;
  const records = requests?.map(request => {
    const original = request?.original, edits = request?.edits ?? {};
    return [original, ...(type === 'deleteEntry' ? [] : [{ ...original,
      startedAt: edits.startedAt ?? original?.startedAt, endedAt: edits.endedAt ?? original?.endedAt }])];
  }).flat() ?? (type === 'addTime' ? [operation.entry]
    : type === 'bulkAddTimes' ? operation.entries : null);
  if (!Array.isArray(records) || !records.length) return null;
  const intervals = records.map(record => ({
    id: record?.id, start: new Date(record?.startedAt).getTime(), end: new Date(record?.endedAt).getTime(),
  }));
  if (intervals.some(item => !item.id || !Number.isFinite(item.start)
      || !Number.isFinite(item.end) || item.end < item.start)) return null;
  return intervals;
}
export function independentCompletedWrite(operation, blockedOperations) {
  const next = completedWriteFootprint(operation);
  if (!next?.length || !blockedOperations.length) return false;
  for (const blocked of blockedOperations) {
    const earlier = completedWriteFootprint(blocked);
    if (!earlier?.length || next.some(candidate => earlier.some(prior => candidate.id === prior.id
        || (candidate.start < prior.end && candidate.end > prior.start)))) return false;
  }
  return true;
}
function hasLaterEntryEdit(queue, operationId, id) {
  const index = (queue ?? []).findIndex(operation => operation.id === operationId);
  return index >= 0 && queue.slice(index + 1).some(operation => operationEditsEntry(operation, id));
}

function completedCacheAfterSync(state, operation) {
  if (!operation.entry) return state.recentCache ?? [];
  const queue = state.pendingWrites ?? [], position = queue.findIndex(item => item.id === operation.id);
  const later = position < 0 ? [] : queue.slice(position + 1);
  const id = operation.entry.id;
  const deleted = later.some(item => (item.operation ?? item.stage) === 'deleteEntry'
    && item.request?.original?.id === id);
  const edited = later.some(item => operationEditsEntry(item, id));
  const locallyEdited = edited ? (state.recentCache ?? []).find(item => item.id === id) : null;
  const visible = deleted ? null : locallyEdited ?? operation.entry;
  return [...(visible ? [visible] : []), ...(state.recentCache ?? []).filter(item =>
    !sameCompletion(item, operation) && !(item._pending && sameTimer(item, operation.activeSnapshot)))]
    .sort(newestFirst).slice(0, 50);
}

function completedCacheAfterAddition(state, operation, savedEntries) {
  const cache = state.recentCache ?? [], queue = state.pendingWrites ?? [];
  const index = queue.findIndex(item => item.id === operation.id);
  const later = index >= 0 ? queue.slice(index + 1) : [];
  const ids = new Set(savedEntries.map(entry => entry.id));
  const inCache = new Map(cache.map(entry => [entry.id, entry]));
  const updated = savedEntries.flatMap(entry => {
    if (!inCache.has(entry.id) || later.some(item => item.operation === 'deleteEntry'
        && item.request?.original?.id === entry.id)) return [];
    return [later.some(item => operationEditsEntry(item, entry.id)) ? inCache.get(entry.id) : entry];
  });
  return [...updated, ...cache.filter(entry => !ids.has(entry.id))].sort(newestFirst).slice(0, 50);
}

function retargetLaterEntryEdits(queue, currentIndex, savedEntries) {
  const savedById = new Map((savedEntries ?? []).map(entry => [entry.id, entry]));
  const retarget = request => {
    const saved = savedById.get(request?.original?.id);
    return saved ? {
      ...request,
      path: saved._path,
      originalSha: saved._sha,
      index: saved._index,
      original: stripInternal(saved),
    } : request;
  };
  for (let index = currentIndex + 1; index < queue.length; index += 1) {
    const operation = queue[index], type = operation.operation ?? operation.stage;
    if (type === 'editEntry' || type === 'deleteEntry') operation.request = retarget(operation.request);
    else if (type === 'editEntries') operation.request = {
      ...operation.request,
      entries: (operation.request?.entries ?? []).map(retarget),
    };
  }
}

function matchesOriginal(entry, original) {
  if (!entry || !original) return false;
  if (original.id) return entry.id === original.id;
  return false;
}

function locateEntry(entries, index, original) {
  if (Number.isInteger(index) && entries[index] && (!original || matchesOriginal(entries[index], original))) return index;
  if (original) {
    const matches = entries.map((entry, position) => matchesOriginal(entry, original) ? position : -1).filter(position => position >= 0);
    if (matches.length === 1) return matches[0];
  }
  return -1;
}
function startDate(entry) { return entry.entryDate; }
function localReportDate(now, offset = 0) {
  return entryDateValue(localDateParts(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12, 0, 0)));
}
function runningTrackedMs(active, now, start, end) {
  return active && startDate(active) >= start && startDate(active) <= end
    ? Math.max(0, now.getTime() - new Date(active.startedAt).getTime()) : 0;
}
function overlayPendingEntries(entries, pendingWrites) {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  for (const operation of pendingWrites) {
    if (['completeTimer', 'completeTimerAndStart'].includes(operation.operation) && operation.entry && !byId.has(operation.entry.id)) {
      byId.set(operation.entry.id, { ...operation.entry, _path: operation.monthlyPath, _sha: null, _index: -1, _pending: true });
    }
    if (operation.operation === 'addTime' || operation.operation === 'bulkAddTimes') {
      const accepted = operation.operation === 'addTime' ? [operation.entry] : operation.entries ?? [];
      for (const entry of accepted) {
        if (entry?.id && !byId.has(entry.id)) byId.set(entry.id, {
          ...entry, _path: monthlyRecordsPath(entry.user, entry.entryDate),
          _sha: null, _index: -1, _pending: true,
        });
      }
    }
    if (operation.operation === 'deleteEntry') byId.delete(operation.request?.original?.id);
    const requests = operation.operation === 'editEntry' ? [operation.request]
      : operation.operation === 'editEntries' ? operation.request.entries : [];
    for (const request of requests) {
      // The accepted original is authoritative even if the remote entry changed or disappeared.
      const updated = applyEntryEdits(request.original, request.edits, new Date(Math.max(
        new Date(operation.queuedAt).getTime(), new Date(request.original.updatedAt).getTime(),
      )));
      const cached = byId.get(updated.id);
      byId.set(updated.id, { ...updated, _path: request.path, _sha: cached?._sha ?? request.originalSha, _index: cached?._index ?? request.index, _pending: true });
    }
  }
  return [...byId.values()];
}

function summaryProjection(state, now) {
  const cache = state.summaryCache, today = localReportDate(now);
  if (!cache || cache.reportDate !== today || !Array.isArray(cache.weekEntries)) {
    return { todayTrackedMs: null, weekTrackedMs: null, remoteWriteConfirmed: false };
  }
  const thisWeekStart = localReportDate(now, -((now.getDay() + 6) % 7));
  const pendingWrites = state.pendingWrites ?? [];
  const entries = overlayPendingEntries([...cache.weekEntries, ...(state.recentCache ?? [])], pendingWrites);
  const trackedMs = start => entries.filter(entry => startDate(entry) >= start && startDate(entry) <= today)
    .reduce((sum, entry) => sum + Math.max(0, new Date(entry.endedAt) - new Date(entry.startedAt)), 0)
    + runningTrackedMs(state.activeCache, now, start, today);
  return {
    todayTrackedMs: trackedMs(today), weekTrackedMs: trackedMs(thisWeekStart),
    remoteWriteConfirmed: recoveryProjection({ active: state.activeCache, recent: entries, pendingWrites }).remoteWriteConfirmed,
  };
}
function newestFirst(a, b) { return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(); }
function stripInternal(value) { return Object.fromEntries(Object.entries(value || {}).filter(([key]) => !['_path', '_sha', '_index', '_pending', 'destinationId'].includes(key))); }
function appendQueueDiagnostic(operation, message) {
  const diagnostics = Array.isArray(operation.diagnostics) ? operation.diagnostics : (operation.diagnostics = []);
  diagnostics.push({ at: new Date().toISOString(), message: String(message).slice(0, 300) });
  if (diagnostics.length > 60) diagnostics.splice(0, diagnostics.length - 60);
}
function monthFromPath(path, user) { return assertUserMonthlyRecordsPath(path, user).month; }
function monthsInRange(startDate, endDate) {
  const start = entryDateParts(startDate), end = entryDateParts(endDate);
  if (startDate > endDate) throw new Error('Task merge end date must not precede start date');
  const months = [];
  for (let year = Number(start.year), month = Number(start.month); year < Number(end.year) || (year === Number(end.year) && month <= Number(end.month));) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month === 13) { year += 1; month = 1; }
  }
  return months;
}
function editClock(clock, entry) { return new Date(Math.max(clock().getTime(), new Date(entry.updatedAt).getTime())); }
function localMidnight(date) {
  const [year, month, day] = date.split('-').map(Number);
  return localTimestamp(new Date(year, month - 1, day, 0, 0, 0, 0));
}
function nextLocalMidnight(date) {
  const [year, month, day] = date.split('-').map(Number);
  return localTimestamp(new Date(year, month - 1, day + 1, 0, 0, 0, 0));
}
// Keep locally accepted Multiple days intervals available for overlap checks
// even after the small Recent cache drops old dates. Store only timestamps and
// stable IDs; this is an occupancy hint, not a second source of work records.
const MAX_LOCAL_DAY_RANGE_INTERVALS = 5000;
function rememberDayRangeIntervals(previous, entries) {
  const known = new Map((previous ?? []).map(item => [item.id, item]));
  for (const entry of entries) {
    if (!entry?.id) continue;
    known.delete(entry.id);
    known.set(entry.id, { id: entry.id, entryDate: entry.entryDate,
      startedAt: entry.startedAt, endedAt: entry.endedAt });
  }
  return [...known.values()].slice(-MAX_LOCAL_DAY_RANGE_INTERVALS);
}
function updateDayRangeIntervals(previous, updates = [], removals = []) {
  const known = new Map((previous ?? []).map(item => [item.id, item]));
  for (const id of removals) known.delete(id);
  for (const entry of updates) {
    if (!known.has(entry.id)) continue;
    known.delete(entry.id);
    known.set(entry.id, { id: entry.id, entryDate: entry.entryDate,
      startedAt: entry.startedAt, endedAt: entry.endedAt });
  }
  return [...known.values()];
}
function knownLocalIntervals(state) {
  // The day-range index is an occupancy hint, not an authoritative record.
  return overlayPendingEntries([...(state.dayRangeIntervals ?? []), ...(state.summaryCache?.weekEntries ?? []),
    ...(state.recentCache ?? [])], state.pendingWrites ?? []);
}

function replaceCachedFiles(cache, replacements, touchedPaths = replacements.map(entry => entry._path)) {
  const paths = new Set(touchedPaths);
  return [...replacements, ...(cache ?? []).filter(entry => !paths.has(entry._path))]
    .sort(newestFirst).slice(0, 50);
}

function replaceCachedDeletedFile(cache, saved, path, laterWrites = []) {
  const cachedIds = new Set((cache ?? []).filter(entry => entry._path === path).map(entry => entry.id));
  // A GitHub delete rewrites the entire monthly file. Preserve every newer
  // local edit, Stop and deletion made while that rewrite was in flight.
  const projected = overlayPendingEntries(saved, laterWrites);
  return replaceCachedFiles(cache, projected.filter(entry => entry._path === path && cachedIds.has(entry.id)), [path]);
}

export class TrackerService {
  constructor({
    github, store, reports = null, user, actorId = '', actorName = user, producer, timezone,
    clock = () => new Date(), idFactory = () => createUlid(), recentDays = 7,
  }) {
    this.github = github;
    this.store = store;
    this.reports = reports;
    this.user = validatePathSegment(user, 'user');
    this.actor = { kind: 'human', id: actorId || `clockoli-user:${this.user}`, name: actorName || this.user };
    this.producer = producer;
    this.timezone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    this.clock = clock;
    this.idFactory = idFactory;
    this.stopTail = Promise.resolve();
    this.recentDays = Math.min(31, Math.max(1, Number(recentDays) || 7));
    this.currentQueueDiagnostic = null;
    const priorRequestDiagnostics = this.github.requestDiagnostics;
    this.github.requestDiagnostics = event => {
      try { priorRequestDiagnostics?.(event); }
      finally { this.currentQueueDiagnostic?.(event); }
    };
  }

  validateTaskUrl(value) { return normalizeTaskUrl(value); }
  buildActive(values) {
    return buildActiveTimer({ user: this.user, actor: this.actor, producer: this.producer, timezone: this.timezone,
      ...values, importedStoredIdentity: !/^https?:\/\//.test(values.taskUrl) });
  }

  async enrichGitHubMetadata(active) {
    const issue = active?.issue ?? parseGitHubTaskUrl(taskUrlOf(active));
    if (!issue || active?.metadata?.github || typeof this.github.getTaskMetadata !== 'function') return active;
    let details;
    try { details = (await this.github.getTaskMetadata([issue], { batchSize: 1, maxRequests: 1, includeSnapshot: true })).get(issue.url); }
    catch { return active; }
    if (!details?.github || typeof details.github !== 'object' || Array.isArray(details.github)) return active;
    const github = structuredClone(details.github);
    github.actor_relationship = githubActorRelationships(github, active.actor);
    const title = taskTitleOf(active) || normalizePlainTitle(details.title);
    const capturedAt = github.snapshot?.captured_at;
    return {
      ...active,
      ...(title ? { taskTitle: title, issueTitle: title } : {}),
      metadata: { ...(active.metadata ?? {}), github },
      ...(capturedAt && !Number.isNaN(new Date(capturedAt).getTime()) ? { updatedAt: new Date(capturedAt).toISOString() } : {}),
    };
  }

  uniqueRecordId(timestamp, usedIds) {
    let id = this.idFactory(timestamp), offset = 1;
    while (usedIds.has(id)) id = createUlid(timestamp + offset++);
    usedIds.add(id);
    return id;
  }

  async mutateState(mutate) {
    if (typeof this.store.mutateState === 'function') return this.store.mutateState(mutate);
    const state = await this.store.getState(), patch = mutate(state);
    if (patch) await this.store.patchState(patch);
    return { ...state, ...(patch || {}) };
  }

  async persistQueueOperation(operation, { remove = false, patch = {}, savedEntries = [] } = {}) {
    return this.mutateState(state => {
      const pendingWrites = [...(state.pendingWrites ?? [])], index = pendingWrites.findIndex(item => item.id === operation.id);
      if (index < 0) return null;
      const hasLaterOperation = index < pendingWrites.length - 1;
      if (remove && savedEntries.length) retargetLaterEntryEdits(pendingWrites, index, savedEntries);
      if (remove) pendingWrites.splice(index, 1); else pendingWrites[index] = structuredClone(operation);
      const resolved = typeof patch === 'function' ? patch(state) : patch;
      if (hasLaterOperation && Object.hasOwn(resolved, 'activeCache')) delete resolved.activeCache;
      return { ...resolved, pendingWrites };
    });
  }

  async patchActiveForOperation(operation, activeCache) {
    return this.mutateState(state => {
      const pendingWrites = state.pendingWrites ?? [], index = pendingWrites.findIndex(item => item.id === operation.id);
      return index >= 0 && index === pendingWrites.length - 1 ? { activeCache } : null;
    });
  }

  async confirmFileMissing(error) {
    if (!isNotFound(error)) throw error;
    await this.github.assertDestinationReachable();
  }

  async readRemoteActive({ signal } = {}) {
    const path = activeRecordPath(this.user);
    try {
      const file = await this.github.getText(path, { signal });
      signal?.throwIfAborted();
      const active = parseActiveRecord(file.text, { user: this.user, path, sha: file.sha });
      validateActiveTimer(active);
      return active;
    } catch (error) {
      await this.confirmFileMissing(error);
      return null;
    }
  }

  async refreshActive({ signal } = {}) {
    const remoteActive = await this.readRemoteActive({ signal });
    let effectiveActive = remoteActive;
    await this.mutateState(state => {
      if ((state.pendingWrites ?? []).length) {
        effectiveActive = state.activeCache;
        return {};
      }
      return { activeCache: remoteActive };
    });
    return effectiveActive;
  }

  async getState({ refresh = false, signal, includeSummary = false } = {}) {
    let state = await this.store.getState();
    signal?.throwIfAborted();
    if (refresh) {
      try { await this.refreshActive({ signal }); }
      catch (error) {
        state = await this.store.getState();
        if (!state.activeCache || !isRetryableReadFailure(error)) throw error;
      }
      state = await this.store.getState();
    }
    signal?.throwIfAborted();
    return {
      active: state.activeCache, recent: state.recentCache ?? [], pendingWrites: state.pendingWrites ?? [],
      ...(includeSummary ? summaryProjection(state, this.clock()) : {}),
    };
  }

  async projectActivityRecords(remoteRecords, { startDate: from, endDate: through } = {}) {
    // The unsynced IndexedDB state remains authoritative for Activity reloads.
    // Apply the complete pending queue before filtering: edits can move records
    // across the requested day boundary.
    const state = await this.store.getState();
    const pendingWrites = state.pendingWrites ?? [];
    const records = overlayPendingEntries(remoteRecords, pendingWrites);
    const replacedRecordIds = pendingWrites.flatMap(operation => {
      if (operation.operation === 'deleteEntry' || operation.operation === 'editEntry') {
        return operation.request?.original?.id ? [operation.request.original.id] : [];
      }
      if (operation.operation === 'editEntries') {
        return (operation.request?.entries ?? []).map(request => request.original?.id).filter(Boolean);
      }
      return [];
    });
    return {
      records: records.filter(entry => (!from || entry.entryDate >= from)
        && (!through || entry.entryDate <= through)),
      replacedRecordIds,
      recovery: recoveryProjection({
        active: state.activeCache, recent: records, pendingWrites,
      }),
    };
  }

  async getRecoveryState() { return recoveryProjection(await this.getState()); }

  async getCachedSummary() {
    return summaryProjection(await this.store.getState(), this.clock());
  }

  async start(taskUrl, taskTitle = '', description = '', { background = false, billable } = {}) {
    if (background) return this.queueStart(taskUrl, taskTitle, description, { billable });
    const state = await this.store.getState();
    if ((state.pendingWrites ?? []).length) throw new Error('A stopped entry is still waiting to sync. Sync it before starting another timer.');
    const existing = await this.refreshActive();
    if (existing) throw new Error(`A timer is already tracking ${taskLabel(existing)}`);
    const now = this.clock(), id = this.idFactory(now.getTime());
    const active = await this.enrichGitHubMetadata(this.buildActive({ id, taskUrl: normalizeStoredTaskIdentity(taskUrl), startedAt: now, description, taskTitle, billable }));
    const path = activeRecordPath(this.user);
    try {
      const result = await this.github.putText(path, serializeActiveRecord(active), `timer: start ${this.user}`);
      const cached = { ...active, _path: path, _sha: result.sha };
      await this.store.patchState({ activeCache: cached });
      return cached;
    } catch (error) {
      if (isConflict(error)) throw new TrackerConflictError('Your timer changed on another device. Reload the GitHub timer before starting.');
      throw error;
    }
  }

  async queueStart(taskUrl, taskTitle = '', description = '', { startedAt = this.clock(), overlapGuards = null, overlapHeadSha = null, requireNoOverlap = false, billable } = {}) {
    const state = await this.store.getState();
    if (state.activeCache) throw new Error(`A timer is already tracking ${taskLabel(state.activeCache)}`);
    const { operation, pendingActive } = this.prepareQueuedStart(taskUrl, taskTitle, description, { startedAt, overlapGuards, overlapHeadSha, requireNoOverlap, billable });
    await this.mutateState(current => {
      if (current.activeCache) throw new Error(`A timer is already tracking ${taskLabel(current.activeCache)}`);
      if (requireNoOverlap) assertNoRunningCompletedOverlap(pendingActive, knownLocalIntervals(current), this.clock());
      return { pendingWrites: [...(current.pendingWrites ?? []), operation], activeCache: pendingActive };
    });
    return pendingActive;
  }

  prepareQueuedStart(taskUrl, taskTitle = '', description = '', { startedAt = this.clock(), id = null, blockedBy = null, overlapGuards = null, overlapHeadSha = null, requireNoOverlap = false, billable } = {}) {
    const start = new Date(startedAt), activeId = id || this.idFactory(start.getTime());
    const active = this.buildActive({ id: activeId, taskUrl: normalizeStoredTaskIdentity(taskUrl), startedAt: start, description, taskTitle, billable });
    const operation = {
      operation: 'startTimer', id: activeId, status: 'pending', retryCount: 0,
      stage: blockedBy ? 'awaitSourceCompletion' : 'startNext',
      nextActive: stripInternal(active), queuedAt: start.toISOString(), lastError: '',
      ...(blockedBy ? { blockedBy: structuredClone(blockedBy) } : {}),
      ...(overlapGuards ? { overlapGuards: structuredClone(overlapGuards) } : {}),
      ...(overlapHeadSha ? { overlapHeadSha } : {}),
      ...(requireNoOverlap ? { requireNoOverlap: true } : {}),
    };
    return {
      operation,
      pendingActive: { ...active, _path: activeRecordPath(this.user), _sha: null, _pending: true },
    };
  }

  async switchTask(taskUrl, taskTitle = '', description, { background = false, billable } = {}) {
    const targetUrl = normalizeStoredTaskIdentity(taskUrl);
    if (background) return this.queueTaskSwitch(targetUrl, taskTitle, description, billable);
    const current = await this.refreshActive();
    if (!current) return { stopped: null, active: await this.queueStart(targetUrl, taskTitle, ''), pending: true };
    if (taskUrlOf(current) === targetUrl) return { stopped: null, active: current };
    const stopped = await this.stop(description, { billable });
    if (stopped.pending) throw new Error('The previous timer was saved locally but must sync before another timer can start.');
    return { stopped, active: await this.start(targetUrl, taskTitle, '') };
  }

  async queueTaskSwitch(targetUrl, taskTitle = '', description, billable) {
    const state = await this.store.getState();
    const current = state.activeCache;
    if (!current) return { stopped: null, active: await this.queueStart(targetUrl, taskTitle, ''), pending: true };
    validateActiveTimer(current);
    if (taskUrlOf(current) === targetUrl) return { stopped: null, active: current, pending: false };
    const changedAt = this.clock(), id = current.id;
    const entry = buildEntry({ active: current, endedAt: changedAt, now: changedAt, description, billable });
    const generatedNextId = this.idFactory(changedAt.getTime());
    const nextId = generatedNextId === id ? createUlid(changedAt.getTime() + 1) : generatedNextId;
    const nextActive = this.buildActive({ id: nextId, taskUrl: targetUrl, taskTitle, startedAt: changedAt, description: '' });
    const operation = {
      operation: 'completeTimerAndStart', id, status: 'pending', retryCount: 0, stage: 'verifyActive',
      monthlyPath: monthlyRecordsPath(this.user, current.entryDate), entry, activeSnapshot: stripInternal(current), activeSha: current._sha,
      nextActive: stripInternal(nextActive), queuedAt: changedAt.toISOString(), lastError: '',
    };
    const pendingEntry = { ...entry, _path: operation.monthlyPath, _sha: null, _index: -1, _pending: true };
    const pendingActive = { ...nextActive, _path: activeRecordPath(this.user), _sha: null, _pending: true };
    await this.mutateState(latest => {
      if (!sameTimer(latest.activeCache, current)) throw new Error('The local timer changed before this switch was accepted. Retry the action.');
      return {
        pendingWrites: [...(latest.pendingWrites ?? []), operation], activeCache: pendingActive,
        recentCache: [pendingEntry, ...(latest.recentCache ?? []).filter(item => !sameCompletion(item, operation))].slice(0, 50),
      };
    });
    return { stopped: { entry, localEntry: pendingEntry, pending: true }, active: pendingActive, pending: true };
  }

  stop(description, { background = false, billable } = {}) {
    const result = this.stopTail.then(() => background ? this.queueStop(description, billable) : this.stopInternal(description, billable));
    this.stopTail = result.catch(() => {});
    return result;
  }

  async queueStop(description, billable) {
    const state = await this.store.getState();
    const active = state.activeCache;
    if (!active) throw new Error('No timer is running');
    const { operation, pendingEntry, entry } = this.prepareQueuedStop(active, description, { billable });
    await this.mutateState(latest => {
      if (!sameTimer(latest.activeCache, active)) throw new Error('The local timer changed before Stop was accepted. Retry the action.');
      return {
        pendingWrites: [...(latest.pendingWrites ?? []), operation], activeCache: null,
        recentCache: [pendingEntry, ...(latest.recentCache ?? []).filter(item => !sameCompletion(item, operation))].slice(0, 50),
      };
    });
    return { entry, localEntry: pendingEntry, pending: true };
  }

  prepareQueuedStop(active, description, { endedAt = this.clock(), billable } = {}) {
    const persistedActive = stripInternal(active);
    validateActiveTimer(persistedActive);
    const end = new Date(endedAt), id = persistedActive.id;
    const entry = buildEntry({ active: persistedActive, endedAt: end, now: end, description, billable });
    const operation = {
      operation: 'completeTimer', id, status: 'pending', retryCount: 0, stage: 'verifyActive',
      monthlyPath: monthlyRecordsPath(this.user, active.entryDate), entry, activeSnapshot: stripInternal(active), activeSha: active._sha,
      queuedAt: end.toISOString(), lastError: '',
    };
    return {
      operation, entry,
      pendingEntry: { ...entry, _path: operation.monthlyPath, _sha: null, _index: -1, _pending: true },
    };
  }

  async discardActive({ background = false } = {}) {
    const discarded = await this.queueDiscardActive();
    if (!background) await this.syncPending();
    const pending = (await this.store.getState()).pendingWrites.some(operation => operation.id === discarded.operationId);
    return { id: discarded.id, operationId: discarded.operationId, pending };
  }

  async queueDiscardActive() {
    const queuedAt = this.clock();
    return this.mutateState(state => {
      const active = state.activeCache;
      if (!active) throw new Error('No timer is running');
      validateActiveTimer(active);
      const operation = {
        operation: 'discardActive', id: createUlid(queuedAt.getTime() + (state.pendingWrites ?? []).length),
        status: 'pending', retryCount: 0, stage: 'discardActive', activeSnapshot: stripInternal(active),
        activeSha: active._sha, queuedAt: queuedAt.toISOString(), lastError: '',
      };
      return { pendingWrites: [...(state.pendingWrites ?? []), operation], activeCache: null };
    }).then(state => {
      const operation = state.pendingWrites.at(-1);
      return { id: operation.activeSnapshot.id, operationId: operation.id, pending: true };
    });
  }

  async stopInternal(description, billable) {
    const state = await this.store.getState();
    if ((state.pendingWrites ?? []).some(operation => operation.nextActive)) {
      throw new Error('The task switch is still syncing. Wait for it to finish before stopping.');
    }
    const cached = state.activeCache;
    let active, activeVerified = true;
    try { active = await this.refreshActive(); }
    catch (error) {
      if (!cached || !isRetryableReadFailure(error)) throw error;
      active = cached; activeVerified = false;
    }
    if (cached && active && !sameTimer(cached, active)) throw new TrackerConflictError('The active timer changed on another device. Reload before stopping.');
    const candidate = active || cached;
    const existing = (state.pendingWrites ?? []).find(operation => operation.operation === 'completeTimer' && sameTimer(operation.activeSnapshot, candidate));
    if (existing) { await this.store.patchState({ activeCache: null }); return { entry: existing.entry, pending: true }; }
    if (!active && cached) {
      validateActiveTimer(cached);
      const file = await this.readMonthly(monthlyRecordsPath(this.user, cached.entryDate));
      const matches = file.entries.filter(entry => sameTimer(entry, cached));
      if (matches.length > 1) throw new TrackerConflictError('Multiple completed entries match the timer that another device stopped. Reload before continuing.');
      if (matches.length === 1) {
        const adopted = matches[0];
        const recentCache = [adopted, ...(state.recentCache ?? []).filter(item =>
          item._path !== adopted._path || item._index !== adopted._index)].sort(newestFirst).slice(0, 50);
        await this.store.patchState({ activeCache: null, recentCache });
        return { entry: adopted, pending: false };
      }
    }
    if (!active) throw new Error('No timer is running');
    const endedAt = this.clock();
    const id = active.id;
    const entry = buildEntry({ active, endedAt, now: endedAt, description, billable });
    const operation = {
      operation: 'completeTimer', id, status: 'pending', retryCount: 0, stage: activeVerified ? 'appendMonthly' : 'verifyActive',
      monthlyPath: monthlyRecordsPath(this.user, active.entryDate), entry, activeSnapshot: stripInternal(active), activeSha: active._sha,
      queuedAt: endedAt.toISOString(), lastError: '',
    };
    const pendingEntry = { ...entry, _path: operation.monthlyPath, _sha: null, _index: -1, _pending: true };
    await this.store.patchState({
      pendingWrites: [...(state.pendingWrites ?? []), operation], activeCache: null,
      recentCache: [pendingEntry, ...(state.recentCache ?? []).filter(item => !sameCompletion(item, operation))].slice(0, 50),
    });
    await this.syncPending();
    const next = await this.store.getState();
    const pending = (next.pendingWrites ?? []).some(item => item.id === id);
    const exact = (next.recentCache ?? []).find(item => sameCompletion(item, operation));
    const sameStart = (next.recentCache ?? []).filter(item => sameTimer(item, operation.activeSnapshot));
    const persisted = exact || (sameStart.length === 1 ? sameStart[0] : entry);
    return { entry: persisted, pending };
  }

  async readMonthly(path) {
    const month = monthFromPath(path, this.user);
    try {
      const file = await this.github.getText(path);
      return { path, month, sha: file.sha, entries: parseMonthlyRecords(file.text, { user: this.user, month, path, sha: file.sha }) };
    } catch (error) {
      await this.confirmFileMissing(error);
      return { path, month, sha: null, entries: [] };
    }
  }

  async putMonthly(file, entries, message) {
    const text = serializeMonthlyRecords(entries);
    if (!text) {
      if (!file.sha) return { sha: null };
      await this.github.deleteFile(file.path, message, file.sha);
      return { sha: null };
    }
    return this.github.putText(file.path, text, message, file.sha || undefined);
  }

  async readTaskIndex() {
    try {
      const file = await this.github.getText(TASK_INDEX_PATH);
      return { path: TASK_INDEX_PATH, sha: file.sha, index: parseTaskIndex(file.text, { user: this.user }) };
    } catch (error) {
      if (isNotFound(error)) throw new Error('The mandatory Clockoli task index is missing from this personal branch.', { cause: error });
      throw error;
    }
  }

  async assertKnownImportedTask(taskUrl, indexFile = null, conflictReason = null) {
    indexFile ||= await this.readTaskIndex();
    if (!Object.hasOwn(indexFile.index.tasks, taskUrl)) {
      const shared = await this.reports?.loadRepositoryTask?.(taskUrl, { scanAllUsers: true });
      if (!shared?.length) {
        const message = 'Select an existing imported task in this time repository.';
        if (conflictReason) throw new TrackerConflictError(message, conflictReason);
        throw new Error(message);
      }
    }
    return indexFile;
  }

  async updateCompletedRecords(changes, message, { remove = [], add = [], guards = [], expectedHeadSha = null, indexFile = null } = {}) {
    indexFile ||= await this.readTaskIndex();
    const index = applyTaskIndexChanges(indexFile.index, { remove, add });
    return this.github.updateTextsAtomic([
      ...changes,
      { path: TASK_INDEX_PATH, sha: indexFile.sha, text: serializeTaskIndex(index) },
    ], message, { guards, expectedHeadSha });
  }

  async activeStateFor(operation) {
    const path = activeRecordPath(this.user);
    try {
      const file = await this.github.getText(path), active = parseActiveRecord(file.text, { user: this.user, path, sha: file.sha });
      if (sameTimer(active, operation.activeSnapshot)) {
        const remoteActive = stripInternal(active), localCompletion = operation.entry;
        if (operation.editedCompletion && !sameValue(remoteActive, operation.activeSnapshot)) {
          throw new TrackerConflictError('The original timer changed on GitHub. The edited completion is still stored locally.');
        }
        operation.activeSha = file.sha;
        operation.activeSnapshot = remoteActive;
        if (!operation.editedCompletion) {
          operation.entry = buildEntry({
            active: remoteActive,
            endedAt: localCompletion.endedAt,
            now: localCompletion.updatedAt,
            description: localCompletion.description,
            billable: isBillable(localCompletion),
          });
          operation.monthlyPath = monthlyRecordsPath(this.user, remoteActive.entryDate);
        }
        return 'matching';
      }
      await this.patchActiveForOperation(operation, active);
      if (operation.nextActive && operation.entry && isNewerTimer(active, operation.activeSnapshot)) {
        const localCompletion = operation.entry;
        const endedAt = new Date(Math.min(new Date(localCompletion.endedAt).getTime(), timerStartedAt(active))).toISOString();
        operation.entry = buildEntry({
          active: operation.activeSnapshot,
          endedAt,
          now: localCompletion.updatedAt,
          description: localCompletion.description,
          billable: isBillable(localCompletion),
        });
        operation.preserveActive = true;
        operation.activeCleared = true;
        return 'superseded';
      }
      return 'changed';
    } catch (error) {
      await this.confirmFileMissing(error);
      await this.patchActiveForOperation(operation, null); return 'missing';
    }
  }

  sameEditedCompletion(saved, expected) {
    return ['id', 'entryDate', 'timezone', 'startedAt', 'endedAt', 'description'].every(key =>
      sameValue(saved?.[key], expected?.[key]))
      && taskUrlOf(saved) === taskUrlOf(expected)
      && taskTitleOf(saved) === taskTitleOf(expected)
      && isBillable(saved) === isBillable(expected);
  }

  verifiedSavedCompletion(expected, monthly, taskIndex) {
    const records = monthly?.entries?.filter(entry => entry.id === expected.id) ?? [];
    const indexedTasks = Object.entries(taskIndex?.index?.tasks ?? {}).flatMap(([task, details]) =>
      (details.recordIds ?? []).filter(id => id === expected.id).map(() => task));
    if (records.length !== 1 || indexedTasks.length !== 1
        || indexedTasks[0] !== taskUrlOf(expected)
        || taskUrlOf(records[0]) !== indexedTasks[0]
        || !this.sameEditedCompletion(records[0], expected)) return null;
    return records[0];
  }

  async completionAlreadySaved(file, operation) {
    const exact = file.entries.find(entry => sameCompletion(entry, operation));
    if (exact) {
      if (operation.editedCompletion && !this.sameEditedCompletion(exact, operation.entry)) {
        throw new TrackerConflictError('A different version of this timer was saved on GitHub. Review it before retrying.');
      }
      return exact;
    }
    const sameStart = file.entries.filter(entry => sameTimer(entry, operation.entry));
    if (!sameStart.length) return null;
    const activeState = await this.activeStateFor(operation);
    if (activeState === 'missing' && sameStart.length === 1) return sameStart[0];
    if (activeState === 'changed') throw new TrackerConflictError('The active timer changed on another device while this completion was syncing.');
    return null;
  }

  async ensureEntry(operation) {
    let [file, indexFile] = await Promise.all([
      this.readMonthly(operation.monthlyPath),
      this.readTaskIndex(),
    ]);
    let found = await this.completionAlreadySaved(file, operation);
    if (found) return found;
    const proposed = [...file.entries, operation.entry];
    let overlap = null;
    if (operation.requireNoOverlap) {
      overlap = await this.readEditOverlapFiles([operation.entry]);
      assertNoCompletedOverlap(operation.entry, overlap.files.flatMap(item => item.entries));
      if (overlap.files.find(item => item.path === file.path)?.sha !== file.sha) {
        throw new TrackerConflictError('Completed time changed while checking the stopped timer.');
      }
    }
    try {
      const activePath = activeRecordPath(this.user);
      const changes = [
        { path: file.path, sha: file.sha, text: serializeMonthlyRecords(proposed) },
        ...(operation.preserveActive ? [] : [{ path: activePath, sha: operation.activeSha, text: null }]),
      ];
      const result = await this.updateCompletedRecords(changes, `time: ${this.user} tracked ${trackedDurationLabel(operation.entry)} on ${taskLabel(operation.entry)}`, {
        add: [operation.entry], indexFile,
        guards: overlap?.files.filter(item => item.path !== file.path).map(item => ({ path: item.path, sha: item.sha })) ?? [],
        expectedHeadSha: overlap?.headSha ?? null,
      });
      operation.activeSha = null; operation.activeCleared = true;
      return parseMonthlyRecords(serializeMonthlyRecords(proposed), {
        user: this.user, month: file.month, path: file.path, sha: result.blobShas[file.path],
      }).at(-1);
    } catch (error) {
      if (!isConflict(error) && error?.code !== 'validation') throw error;
      file = await this.readMonthly(operation.monthlyPath);
      found = await this.completionAlreadySaved(file, operation);
      if (found) return found;
      const activeState = await this.activeStateFor(operation);
      if (activeState === 'matching') {
        throw new Error('The repository changed while this timer was stopping. Retry will converge automatically.');
      }
      if (activeState === 'changed' || activeState === 'superseded') {
        throw new TrackerConflictError('The active timer changed on another device while this completion was syncing.',
          'active_changed_no_completion');
      }
      throw new TrackerConflictError('The active timer disappeared before its completion was saved.',
        'active_missing_no_completion');
    }
  }

  async clearMatchingActive(operation) {
    const path = activeRecordPath(this.user);
    let sha = operation.activeSha;
    if (!sha) {
      try {
        const file = await this.github.getText(path), remote = parseActiveRecord(file.text, { user: this.user, path, sha: file.sha });
        if (!sameTimer(remote, operation.activeSnapshot)) {
          await this.patchActiveForOperation(operation, remote);
          throw new TrackerConflictError('The active timer changed on another device. The completed entry was saved, but the newer timer was not cleared.', 'completion_saved_newer_timer');
        }
        sha = file.sha;
      } catch (error) { await this.confirmFileMissing(error); return; }
    }
    try { await this.github.deleteFile(path, `timer: clear ${this.user}`, sha); }
    catch (error) {
      if (isNotFound(error)) {
        try { await this.github.getText(path); } catch (verificationError) { await this.confirmFileMissing(verificationError); return; }
      }
      if (isConflict(error)) {
        let file;
        try { file = await this.github.getText(path); } catch (readError) { await this.confirmFileMissing(readError); return; }
        const remote = parseActiveRecord(file.text, { user: this.user, path, sha: file.sha });
        if (!sameTimer(remote, operation.activeSnapshot)) {
          await this.patchActiveForOperation(operation, remote);
          throw new TrackerConflictError('The active timer changed while it was being cleared. The newer timer was preserved.', 'completion_saved_newer_timer');
        }
        try { await this.github.deleteFile(path, `timer: clear ${this.user}`, file.sha); return; }
        catch (retryError) { if (isConflict(retryError)) throw new TrackerConflictError('The active timer changed while it was being cleared.', 'completion_saved_newer_timer'); throw retryError; }
      }
      throw error;
    }
  }

  async startQueuedActive(operation) {
    const path = activeRecordPath(this.user), queuedTarget = operation.nextActive;
    if (!queuedTarget) return null;
    let indexGuard = null;
    // A pending start can remain local across days or months. Persisted guards
    // only describe an earlier attempt; recheck the current horizon every time.
    if (operation.requireNoOverlap) {
      const now = this.clock();
      const [index, { files, headSha }] = await Promise.all([
        this.readTaskIndex(), this.readAddTimeOverlapFiles(queuedTarget.entryDate, now,
          localDateInTimezone(now, this.timezone)),
      ]);
      if (hasSavedCompletion(index, files.flatMap(file => file.entries), queuedTarget.id)) {
        throw new TrackerConflictError('This timer already has a saved completion on GitHub. Review Activity to confirm saved time.', 'add_time_overlap_changed');
      }
      // Guard the index as well: a completion may have moved to a different
      // month, outside the normal overlap horizon, since the previous attempt.
      indexGuard = { path: TASK_INDEX_PATH, sha: index.sha };
      const startMs = new Date(queuedTarget.startedAt).getTime(), nowMs = this.clock().getTime();
      if (files.some(file => file.entries.some(entry => new Date(entry.startedAt).getTime() < nowMs
          && new Date(entry.endedAt).getTime() > startMs))) {
        operation.overlapGuards = files.map(file => ({ path: file.path, sha: file.sha }));
        throw new TrackerConflictError('Added time would overlap existing time. Review Activity or discard the queued start.', 'add_time_overlap_changed');
      }
      operation.overlapGuards = files.map(file => ({ path: file.path, sha: file.sha }));
      operation.overlapHeadSha = headSha;
      await this.persistQueueOperation(operation);
    }
    const target = await this.enrichGitHubMetadata(queuedTarget);
    let sha = undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (operation.overlapGuards) {
          const result = await this.github.updateTextsAtomic([
            { path, sha: sha ?? null, text: serializeActiveRecord(target) },
          ], `timer: start ${this.user}`, { guards: [...operation.overlapGuards, ...(indexGuard ? [indexGuard] : [])],
            expectedHeadSha: operation.overlapHeadSha || null });
          return { ...target, _path: path, _sha: result.blobShas[path] };
        }
        const result = await this.github.putText(path, serializeActiveRecord(target), `timer: start ${this.user}`, sha);
        return { ...target, _path: path, _sha: result.sha };
      } catch (error) {
        if (!isRejectedCreate(error)) throw error;
        if (operation.overlapGuards) {
          const files = await Promise.all(operation.overlapGuards.map(guard => this.readMonthly(guard.path)));
          if (files.some((file, index) => file.sha !== operation.overlapGuards[index].sha)) {
            throw new TrackerConflictError('Completed time changed while starting this timer. Review Activity before retrying.', 'add_time_overlap_changed');
          }
        }
        if (indexGuard && (await this.readTaskIndex()).sha !== indexGuard.sha) {
          throw new TrackerConflictError('The GitHub task index changed while starting this timer. Review Activity.', 'add_time_overlap_changed');
        }
        let file;
        try { file = await this.github.getText(path); }
        catch (readError) {
          if (operation.overlapHeadSha) throw new TrackerConflictError('Completed time changed while starting this timer. Review Activity before retrying.', 'add_time_overlap_changed');
          throw error;
        }
        const remote = parseActiveRecord(file.text, { user: this.user, path, sha: file.sha });
        if (sameTimer(remote, target)
            && (!operation.alignmentRequiresEmptyRemote
              || (remote.startedAt === target.startedAt && remote.entryDate === target.entryDate
                && remote.timezone === target.timezone))) return remote;
        if (operation.alignmentRequiresEmptyRemote) {
          const conflict = new TrackerConflictError('Another timer is active on GitHub. Your queued Start is still saved in this browser and will not overwrite it.', 'queued_start_remote_active');
          conflict.remoteActive = remote;
          throw conflict;
        }
        if (operation.overlapHeadSha) throw new TrackerConflictError('Completed time changed while starting this timer. Review Activity before retrying.', 'add_time_overlap_changed');
        // Deterministic conflict policy: the later timer start wins. Equal start times
        // preserve the remote timer, avoiding an arbitrary overwrite across devices.
        if (!isNewerTimer(target, remote)) return remote;
        sha = file.sha;
      }
    }
    throw new Error('The active timer changed repeatedly while applying the latest start. Retry will converge automatically.');
  }

  async rebaseQueuedEntryEdit(operation) {
    const operationType = operation.operation ?? operation.stage;
    const requests = ['editEntry', 'deleteEntry'].includes(operationType) ? [operation.request] : operation.request?.entries;
    if (!Array.isArray(requests) || !requests.length) throw new Error('The saved edit is incomplete and cannot be retried.');
    const sources = new Map();
    for (const request of requests) {
      if (!sources.has(request.path)) sources.set(request.path, await this.readMonthly(request.path));
    }
    const rebased = [];
    for (const request of requests) {
      let path = request.path, source = sources.get(path);
      let position = locateEntry(source.entries, request.index, request.original);
      if (position < 0 && request.original?.entryDate) {
        // A stale local projection can carry a different month path. Never
        // create or rewrite that file: find the same stable ID at its canonical
        // recorded month before changing the durable queued request.
        const canonical = monthlyRecordsPath(this.user, request.original.entryDate);
        if (canonical !== path) {
          if (!sources.has(canonical)) sources.set(canonical, await this.readMonthly(canonical));
          const candidate = sources.get(canonical);
          const candidatePosition = locateEntry(candidate.entries, request.index, request.original);
          if (candidatePosition >= 0) { path = canonical; source = candidate; position = candidatePosition; }
        }
      }
      if (position < 0) throw new TrackerConflictError('The edited entry no longer exists in the latest Activity data. Reload Activity and review it before editing again.', 'queued_entry_missing');
      rebased.push({ ...request, path, originalSha: source.sha, index: position, original: stripInternal(source.entries[position]) });
    }
    operation.request = ['editEntry', 'deleteEntry'].includes(operationType) ? rebased[0] : { ...operation.request, entries: rebased };
  }

  async alreadyAppliedEntryEdits(requests) {
    const files = new Map(), saved = [];
    for (const request of requests) {
      if (!request?.original?.id || !request?.edits) return null;
      const proposed = applyEntryEdits(request.original, request.edits, editClock(this.clock, request.original));
      const paths = new Set([request.path, monthlyRecordsPath(this.user, proposed.entryDate)]);
      let remote = null;
      for (const path of paths) {
        if (!files.has(path)) files.set(path, await this.readMonthly(path));
        remote = files.get(path).entries.find(entry => entry.id === request.original.id);
        if (remote) break;
      }
      if (!queuedEntryEditsSatisfied(remote, request.edits)) return null;
      saved.push(remote);
    }
    return saved;
  }

  async stoppedOverlapDeletionReadback(request) {
    const [file, index] = await Promise.all([this.readMonthly(request.path), this.readTaskIndex()]);
    const id = request.original.id;
    return !file.entries.some(entry => entry.id === id)
      && !Object.values(index.index.tasks).some(task => task.recordIds.includes(id)) ? file.entries : null;
  }

  async compactPendingQueue() {
    return this.mutateState(state => {
      const pendingWrites = compactSupersededQueue(state.pendingWrites, state.recentCache);
      // Freeze this batch in IndexedDB before any GitHub I/O. A later local
      // edit must append a new operation, never mutate an outgoing snapshot.
      for (const operation of pendingWrites) operation.syncInFlight = true;
      return { pendingWrites };
    }).then(state => state.pendingWrites ?? []);
  }

  async syncPending({ canSync = async () => true } = {}) {
    const queue = await this.compactPendingQueue();
    const blockedOperations = [];
    for (const operation of [...queue]) {
      if (!queue.some(item => item.id === operation.id)) continue;
      if (operation.stage === 'awaitSourceCompletion') break;
      // A completed-record conflict need not hold unrelated time for days.
      // Retain dependent writes in order; the independent ones still use
      // normal SHA, task-index, and overlap checks before GitHub commits.
      if (blockedOperations.length && !independentCompletedWrite(operation, blockedOperations)) {
        blockedOperations.push(operation);
        continue;
      }
      // A newer local change must postpone every not-yet-started GitHub write,
      // even when several queued operations belong to the same repository.
      if (!(await canSync())) break;
      const attemptStartedAt = Date.now();
      this.currentQueueDiagnostic = event => {
        appendQueueDiagnostic(operation, `GitHub ${event.method} ${event.path}: ${event.status} in ${event.durationMs}ms.`);
      };
      appendQueueDiagnostic(operation, `Sync attempt ${(operation.retryCount ?? 0) + 1} started at ${operation.stage}.`);
      try {
        const operationType = operation.operation ?? operation.stage;
        if (operation.status === 'conflict') {
          if (String(operation.conflictReason || '').startsWith('queued_write_')) break;
          const retryQueuedStart = operation.stage === 'startNext' && operation.nextActive
            && operation.conflictReason !== 'add_time_overlap_changed';
          const retryOldDayRange = operation.operation === 'bulkAddTimes'
            && operation.conflictReason === 'bulk_add_validation'
            && operation.requested?.length > 0
            && operation.requested.every(item => item.startTime === '09:00')
            && !operation.autoReplanAttempted;
          if (retryOldDayRange) {
            // Older extension versions could queue 09:00–13:00 again after
            // saving a first 09:00–13:00 batch. Give the shared planner one
            // automatic recovery attempt after upgrading, not endless retries.
            operation.status = 'pending'; operation.lastError = ''; operation.conflictReason = '';
            operation.autoReplanAttempted = true;
            await this.persistQueueOperation(operation);
          } else if (retryQueuedStart) {
            operation.status = 'pending'; operation.lastError = ''; operation.conflictReason = '';
            await this.persistQueueOperation(operation);
          } else {
            if (!['editEntry', 'editEntries', 'deleteEntry'].includes(operationType)) {
              if (!completedWriteFootprint(operation)) break;
              blockedOperations.push(operation);
              continue;
            }
            operation.operation ??= operationType;
            if (operation.strictOriginal) {
              const source = await this.readMonthly(operation.request.path);
              if (source.sha !== operation.request.originalSha
                  && !(operationType === 'deleteEntry'
                    ? await this.stoppedOverlapDeletionReadback(operation.request)
                    : await this.alreadyAppliedEntryEdits([operation.request]))) break;
            }
            if (!operation.strictOriginal) await this.rebaseQueuedEntryEdit(operation);
            operation.status = 'pending'; operation.lastError = ''; operation.conflictReason = '';
            await this.persistQueueOperation(operation);
          }
        }
        if (operationType === 'editEntry') assertQueuedEntryIntervals([operation.request]);
        if (operationType === 'editEntries') assertQueuedEntryIntervals(operation.request?.entries);
        if (operation.operation === 'addTime') {
          const entry = operation.entry;
          let saved;
          try {
            saved = (await this.addTime({
              taskUrl: entry.taskUrl, taskTitle: entry.taskTitle, startedAt: entry.startedAt,
              endedAt: entry.endedAt, description: entry.description, billable: isBillable(entry),
            }, { fixedId: entry.id, acceptedEntry: entry, updateCache: false })).entry;
          } catch (error) {
            if (/Select an existing imported task/i.test(error.message || '')) {
              throw new TrackerConflictError(error.message, 'add_time_invalid_identity');
            }
            throw error;
          }
          const index = queue.findIndex(item => item.id === operation.id);
          if (index >= 0) queue.splice(index, 1);
          await this.persistQueueOperation(operation, {
            remove: true, savedEntries: [saved],
            patch: state => ({ recentCache: completedCacheAfterAddition(state, operation, [saved]) }),
          });
          continue;
        }
        if (operation.operation === 'bulkAddTimes') {
          let result;
          try {
            const multipleDays = operation.requested?.length > 0
              && operation.requested.every(item => item.startTime === '09:00');
            const onRelocated = multipleDays ? async revised => {
              const accepted = revised.map(stripInternal);
              const byId = new Map(accepted.map(entry => [entry.id, entry]));
              await this.mutateState(latest => {
                const pendingWrites = [...(latest.pendingWrites ?? [])];
                const index = pendingWrites.findIndex(item => item.id === operation.id);
                if (index < 0 || pendingWrites[index].status !== 'pending'
                    || pendingWrites[index].entries?.some((entry, offset) =>
                      entry.id !== operation.entries[offset]?.id
                      || entry.startedAt !== operation.entries[offset]?.startedAt)
                    || pendingWrites.slice(index + 1).some(item =>
                      accepted.some(entry => operationEditsEntry(item, entry.id)
                        || item.operation === 'deleteEntry' && item.request?.original?.id === entry.id))) {
                  throw new TrackerConflictError(
                    'This addition was edited after it was queued. Its original times are preserved for review.',
                    'bulk_add_validation');
                }
                pendingWrites[index] = { ...pendingWrites[index], entries: accepted };
                const updateCache = entries => entries.map(entry => byId.has(entry.id)
                  ? { ...entry, ...byId.get(entry.id), _pending: true } : entry);
                return {
                  pendingWrites,
                  recentCache: updateCache(latest.recentCache ?? []),
                  summaryCache: latest.summaryCache?.weekEntries
                    ? { ...latest.summaryCache, weekEntries: updateCache(latest.summaryCache.weekEntries) }
                    : latest.summaryCache,
                  dayRangeIntervals: rememberDayRangeIntervals(latest.dayRangeIntervals, accepted),
                };
              });
              operation.entries = accepted;
              appendQueueDiagnostic(operation, 'Moved Multiple days to free intervals found on GitHub before the atomic sync.');
            } : null;
            result = await this.bulkAddTimes('', {
              requested: operation.requested, ids: operation.entries.map(entry => entry.id),
              acceptedEntries: operation.entries, updateCache: false, includeEntries: true, onRelocated,
            });
          } catch (error) {
            if (error instanceof TrackerConflictError) throw error;
            if (/^Line \d+:|already overlaps|do not fit|overlap the running timer/i.test(error.message || '')) {
              throw new TrackerConflictError(error.message, 'bulk_add_validation');
            }
            throw error;
          }
          const saved = result.savedEntries;
          const index = queue.findIndex(item => item.id === operation.id);
          if (index >= 0) queue.splice(index, 1);
          await this.persistQueueOperation(operation, {
            remove: true, savedEntries: saved,
            patch: state => ({
              recentCache: completedCacheAfterAddition(state, operation, saved),
              ...(operation.requested?.every(item => item.startTime === '09:00')
                ? { dayRangeIntervals: rememberDayRangeIntervals(state.dayRangeIntervals, saved) } : {}),
            }),
          });
          continue;
        }
        if (operation.operation === 'editEntry') {
          // Batch only consecutive independent edits. Stop/switch operations
          // stay as FIFO barriers so each completion retains its issue-linked
          // "time: ... tracked ..." commit.
          const startIndex = queue.findIndex(item => item.id === operation.id);
          const batch = [];
          const targets = new Set();
          for (const candidate of queue.slice(startIndex)) {
            if (candidate.operation !== 'editEntry' || candidate.status === 'conflict'
                || !candidate.request?.original?.id || !candidate.request.path
                || (blockedOperations.length && !independentCompletedWrite(candidate, blockedOperations))) break;
            const key = candidate.request.path + '\\u0000' + candidate.request.original.id;
            if (targets.has(key) || batch.length === 50) break;
            targets.add(key);
            batch.push(candidate);
          }
          if (batch.length > 1) {
            try {
              const saved = await this.editEntries({ entries: batch.map(item => item.request) }, { updateCache: false });
              const batchIds = new Set(batch.map(item => item.id));
              const savedById = new Map(saved.map(item => [item.id, item]));
              await this.mutateState(latest => {
                const pendingWrites = structuredClone(latest.pendingWrites ?? []);
                for (const item of batch) {
                  const index = pendingWrites.findIndex(op => op.id === item.id);
                  if (index !== -1) retargetLaterEntryEdits(pendingWrites, index, saved);
                }
                const remaining = pendingWrites.filter(item => !batchIds.has(item.id));
                return {
                  pendingWrites: remaining,
                  recentCache: (latest.recentCache ?? []).map(entry => {
                    const persisted = savedById.get(entry.id);
                    return persisted && !remaining.some(item => operationEditsEntry(item, entry.id))
                      ? persisted : entry;
                  }),
                };
              });
              for (const item of batch) {
                const index = queue.findIndex(candidate => candidate.id === item.id);
                if (index !== -1) queue.splice(index, 1);
              }
              continue;
            } catch (error) {
              if (!(error instanceof TrackerConflictError)) throw error;
              // Preserve existing per-entry rebasing and conflict reporting.
              // Do not drop a queued operation when a batch cannot be committed.
            }
          }
          let saved;
          try { saved = await this.editEntry(operation.request, { updateCache: false }); }
          catch (error) {
            if (!(error instanceof TrackerConflictError)) throw error;
            saved = (await this.alreadyAppliedEntryEdits([operation.request]))?.[0];
            if (!saved) {
              if (operation.strictOriginal) throw error;
              await this.rebaseQueuedEntryEdit(operation);
              assertQueuedEntryIntervals([operation.request]);
              saved = await this.editEntry(operation.request, { updateCache: false });
            }
          }
          const index = queue.findIndex(item => item.id === operation.id);
          if (index >= 0) queue.splice(index, 1);
          await this.persistQueueOperation(operation, { remove: true, savedEntries: [saved], patch: latest => ({
            recentCache: hasLaterEntryEdit(latest.pendingWrites, operation.id, saved.id)
              ? latest.recentCache ?? []
              : (latest.recentCache ?? []).map(entry => entry.id === saved.id ? saved : entry),
          }) });
          continue;
        }
        if (operation.operation === 'editEntries') {
          let saved;
          try { saved = await this.editEntries(operation.request, { updateCache: false }); }
          catch (error) {
            if (!(error instanceof TrackerConflictError)) throw error;
            saved = await this.alreadyAppliedEntryEdits(operation.request?.entries ?? []);
            if (!saved) {
              await this.rebaseQueuedEntryEdit(operation);
              assertQueuedEntryIntervals(operation.request?.entries);
              saved = await this.editEntries(operation.request, { updateCache: false });
            }
          }
          const index = queue.findIndex(item => item.id === operation.id);
          if (index >= 0) queue.splice(index, 1);
          await this.persistQueueOperation(operation, { remove: true, savedEntries: saved, patch: latest => {
            const savedById = new Map(saved.map(entry => [entry.id, entry]));
            return { recentCache: (latest.recentCache ?? []).map(entry => {
              const persisted = savedById.get(entry.id);
              return persisted && !hasLaterEntryEdit(latest.pendingWrites, operation.id, entry.id) ? persisted : entry;
            }) };
          } });
          continue;
        }
        if (operation.operation === 'deleteEntry') {
          let result;
          try {
            if (operation.strictOriginal) {
              const source = await this.readMonthly(operation.request.path);
              if (source.sha !== operation.request.originalSha) {
                const entries = await this.stoppedOverlapDeletionReadback(operation.request);
                if (!entries) throw new TrackerConflictError('The saved entry changed before deletion. Pending work was preserved.');
                result = { deleted: true, entries };
              }
            }
            result ??= await this.deleteEntry(operation.request, { updateCache: false });
          }
          catch (error) {
            if (!(error instanceof TrackerConflictError)) throw error;
            if (operation.strictOriginal) {
              const entries = await this.stoppedOverlapDeletionReadback(operation.request);
              if (!entries) throw error;
              result = { deleted: true, entries };
            } else try { await this.rebaseQueuedEntryEdit(operation); }
            catch (rebaseError) {
              if (!(rebaseError instanceof TrackerConflictError) || rebaseError.reason !== 'queued_entry_missing') throw rebaseError;
              // GitHub may have committed this deletion before the worker
              // stopped, leaving the original operation unacknowledged locally.
              // Verify both canonical stores: a moved record still exists in
              // the task index and must not be silently treated as deleted.
              const id = operation.request?.original?.id;
              const index = await this.readTaskIndex();
              const indexed = Object.values(index.index.tasks).some(task => task.recordIds.includes(id));
              if (indexed) throw rebaseError;
              const file = await this.readMonthly(operation.request.path);
              if (file.entries.some(entry => entry.id === id)) throw rebaseError;
              result = { deleted: true, entries: file.entries };
            }
            if (!result) result = await this.deleteEntry(operation.request, { updateCache: false });
          }
          const index = queue.findIndex(item => item.id === operation.id);
          if (index >= 0) queue.splice(index, 1);
          if (operation.stoppedOverlapCancelEditId) {
            await this.mutateState(latest => {
              const pendingWrites = [...(latest.pendingWrites ?? [])];
              const at = pendingWrites.findIndex(item => item.id === operation.id);
              const editAt = pendingWrites.findIndex(item => item.id === operation.stoppedOverlapCancelEditId);
              if (at < 0) throw new TrackerConflictError('The queued deletion changed after GitHub confirmed it. Review pending work.');
              if (editAt >= 0 && pendingWrites[editAt].operation === 'editEntry'
                  && pendingWrites[editAt].request?.original?.id === operation.request.original.id) {
                if (sameValue(pendingWrites[editAt].request, operation.stoppedOverlapDependentEdit)) {
                  pendingWrites.splice(editAt, 1);
                } else {
                  // The edit changed during the remote write. Keep its new data
                  // visible as a conflict, but do not let it strand the stopped
                  // timer behind an already confirmed deletion on every retry.
                  pendingWrites[editAt] = { ...pendingWrites[editAt], strictOriginal: true,
                    status: 'conflict', conflictReason: 'queued_entry_missing',
                    lastError: 'The earlier entry was deleted on GitHub. This newer edit was kept for review.' };
                }
              }
              pendingWrites.splice(pendingWrites.findIndex(item => item.id === operation.id), 1);
              return { pendingWrites, recentCache: replaceCachedDeletedFile(latest.recentCache,
                result.entries, operation.request.path, pendingWrites) };
            });
            const dependent = queue.findIndex(item => item.id === operation.stoppedOverlapCancelEditId);
            if (dependent >= 0) queue.splice(dependent, 1);
          } else await this.persistQueueOperation(operation, { remove: true, savedEntries: result.entries, patch: latest => {
            const at = (latest.pendingWrites ?? []).findIndex(item => item.id === operation.id);
            const laterWrites = at >= 0 ? latest.pendingWrites.slice(at + 1) : [];
            return { recentCache: replaceCachedDeletedFile(latest.recentCache, result.entries, operation.request.path, laterWrites) };
          } });
          continue;
        }
        if (operation.operation === 'discardActive') {
          await this.clearMatchingActive(operation);
          const index = queue.findIndex(item => item.id === operation.id);
          if (index >= 0) queue.splice(index, 1);
          await this.persistQueueOperation(operation, { remove: true, patch: latest => ({
            activeCache: sameTimer(latest.activeCache, operation.activeSnapshot) ? null : latest.activeCache,
          }) });
          continue;
        }
        if (operation.operation === 'editActiveStart') {
          const saved = await this.editActiveStart(
            { original: operation.original, startedAt: operation.startedAt, description: operation.description, billable: operation.billable },
            { updateCache: false },
          );
          const index = queue.findIndex(item => item.id === operation.id);
          if (index >= 0) queue.splice(index, 1);
          await this.persistQueueOperation(operation, { remove: true, patch: { activeCache: saved } });
          continue;
        }
        if (!['verifyActive', 'appendMonthly', 'commitCompletion', 'clearActive', 'startNext'].includes(operation.stage)) {
          throw new TrackerConflictError('This queued completion uses an unsupported storage stage. It was preserved for manual recovery.');
        }
        if (operation.stage === 'verifyActive') {
          const activeState = await this.activeStateFor(operation);
          if (activeState === 'missing' || activeState === 'changed') {
            const file = await this.readMonthly(operation.monthlyPath);
            const matches = file.entries.filter(entry => sameTimer(entry, operation.entry));
            if (matches.length > 1) throw new TrackerConflictError('Multiple completed entries match the timer that disappeared during verification. Reload before continuing.');
            if (matches.length === 1 && operation.editedCompletion
                && !this.sameEditedCompletion(matches[0], operation.entry)) {
              throw new TrackerConflictError('Another version of this timer was saved. The local edit was preserved.');
            }
            if (matches.length === 0) {
              const missing = activeState === 'missing';
              throw new TrackerConflictError(
                missing ? 'The active timer no longer exists and no matching completion was found. No completion was saved.'
                  : 'The active timer changed on another device and no matching completion was found. No completion was saved.',
                missing ? 'active_missing_no_completion' : 'active_changed_no_completion',
              );
            }
            operation.entry = matches[0]; operation.stage = 'clearActive'; operation.lastError = ''; operation.conflictReason = '';
          } else {
            operation.stage = 'appendMonthly'; operation.lastError = ''; operation.conflictReason = '';
          }
          await this.persistQueueOperation(operation, { patch: operation.nextActive ? { activeCache: { ...operation.nextActive, _path: activeRecordPath(this.user), _sha: null, _pending: true } } : {} });
        }
        if (operation.stage === 'appendMonthly') {
          operation.stage = 'commitCompletion'; operation.lastError = '';
          await this.persistQueueOperation(operation, { patch: operation.nextActive ? { activeCache: { ...operation.nextActive, _path: activeRecordPath(this.user), _sha: null, _pending: true } } : {} });
        }
        if (operation.stage === 'commitCompletion') {
          operation.entry = await this.ensureEntry(operation);
          operation.stage = 'clearActive'; operation.lastError = '';
          await this.persistQueueOperation(operation, { patch: operation.nextActive ? { activeCache: { ...operation.nextActive, _path: activeRecordPath(this.user), _sha: null, _pending: true } } : {} });
        }
        let nextActive = null;
        if (operation.stage !== 'startNext') {
          if (!operation.activeCleared) await this.clearMatchingActive(operation);
          if (operation.nextActive) { operation.stage = 'startNext'; await this.persistQueueOperation(operation, { patch: { activeCache: { ...operation.nextActive, _path: activeRecordPath(this.user), _sha: null, _pending: true } } }); }
        }
        if (operation.stage === 'startNext') nextActive = await this.startQueuedActive(operation);
        const index = queue.findIndex(item => item.id === operation.id);
        if (index >= 0) queue.splice(index, 1);
        await this.persistQueueOperation(operation, { remove: true, savedEntries: operation.entry ? [operation.entry] : [],
          patch: latest => ({
            activeCache: nextActive,
            // An edit or delete accepted while Stop synced is still authoritative.
            recentCache: completedCacheAfterSync(latest, operation),
          }),
        });
      } catch (caughtError) {
        const rejectionDetail = String(caughtError?.message || '').trim();
        const detail = rejectionDetail && rejectionDetail !== 'GitHub rejected the request' ? ` GitHub said: ${rejectionDetail}` : '';
        const error = isPermanentQueuedWriteFailure(caughtError)
          ? new TrackerConflictError(
            operation.stage === 'startNext'
              ? `GitHub rejected starting this queued timer. Check the configured repository and access, then retry.${detail}`
              : `GitHub rejected this queued write. Check the configured repository and access, then retry.${detail}`,
            `queued_write_${caughtError.code || caughtError.status}`,
          )
          : caughtError;
        operation.retryCount = (operation.retryCount ?? 0) + 1;
        operation.lastError = error.message || 'GitHub is temporarily unreachable';
        operation.status = error instanceof TrackerConflictError ? 'conflict' : 'pending';
        operation.conflictReason = error instanceof TrackerConflictError
          ? (error.reason || (['editEntry', 'editEntries', 'deleteEntry', 'addTime', 'bulkAddTimes'].includes(operation.operation) ? 'queued_entry_edit_conflict' : '')) : '';
        operation.conflictWith = error instanceof TrackerConflictError && error.conflictWith
          ? { id: error.conflictWith.id, entryDate: error.conflictWith.entryDate,
            startedAt: error.conflictWith.startedAt, endedAt: error.conflictWith.endedAt,
            taskTitle: error.conflictWith.taskTitle, taskUrl: error.conflictWith.taskUrl } : null;
        const remoteConflict = error instanceof TrackerConflictError && operation.stage === 'startNext' ? error.remoteActive : null;
        const keepPendingTarget = operation.nextActive && (!remoteConflict && (!(error instanceof TrackerConflictError) || operation.stage === 'startNext'));
        await this.persistQueueOperation(operation, { patch:
          remoteConflict ? { activeCache: remoteConflict }
            : keepPendingTarget ? { activeCache: { ...operation.nextActive, _path: activeRecordPath(this.user), _sha: null, _pending: true } } : {}
        });
        if (isNotFound(error)) throw error;
        if (error instanceof TrackerConflictError && !String(operation.conflictReason || '').startsWith('queued_write_')
            && completedWriteFootprint(operation)) {
          blockedOperations.push(operation);
          continue;
        }
        break;
      } finally {
        const elapsedMs = Math.max(0, Date.now() - attemptStartedAt);
        appendQueueDiagnostic(operation, `Sync attempt finished in ${elapsedMs}ms.`);
        this.currentQueueDiagnostic = null;
      }
    }
    return (await this.store.getState()).pendingWrites ?? [];
  }


  async getActiveStartConflictContext(operationId) {
    validateEntryId(operationId);
    const state = await this.store.getState(), queue = state.pendingWrites ?? [];
    const parts = activeStartConflictParts(queue, operationId, state.activeCache);
    if (!parts) return null;
    const { edit, stop, timerId } = parts, remote = await this.readRemoteActive();
    const validRemote = sameTimer(remote, edit.original) && remote.startedAt === edit.original.startedAt;
    const endTime = stop?.entry?.endedAt ?? this.clock().toISOString();
    const validEnd = Number.isFinite(Date.parse(endTime))
      && new Date(endTime).getTime() > new Date(edit.original.startedAt).getTime();
    let previous = null, choices = [], alreadySaved = false;
    if (validRemote) {
      const taskIndex = await this.readTaskIndex();
      alreadySaved = Object.values(taskIndex.index.tasks).some(task => task.recordIds.includes(timerId));
    }
    if (validRemote && validEnd && !alreadySaved) {
      const pending = { ...remote, startedAt: edit.startedAt, endedAt: endTime };
      const { files } = await this.readEditOverlapFiles([pending]);
      alreadySaved = files.some(file => file.entries.some(entry => entry.id === timerId));
      const entries = files.flatMap(file => file.entries).filter(entry => entry.id !== timerId);
      const overlaps = start => entries.filter(entry =>
        new Date(entry.startedAt).getTime() < new Date(endTime).getTime()
        && new Date(entry.endedAt).getTime() > new Date(start).getTime());
      const overlapping = overlaps(edit.startedAt);
      if (overlapping.length === 1) previous = overlapping[0];
      if (parts.safe && !alreadySaved && new Date(edit.original.startedAt) < new Date(endTime)
          && !overlaps(edit.original.startedAt).length) choices.push('undo');
      if (parts.safe && !alreadySaved && previous && new Date(previous.endedAt) < new Date(endTime)
          && !overlaps(previous.endedAt).length) choices.push('after');
      if (parts.safe && !alreadySaved) choices.push('manual');
    }
    const fields = item => item ? ({ id: item.id, taskTitle: taskTitleOf(item), taskUrl: taskUrlOf(item),
      entryDate: item.entryDate, timezone: item.timezone, startedAt: item.startedAt, endedAt: item.endedAt }) : null;
    const blocked = stop?.entry ?? (validRemote ? { ...remote, startedAt: edit.startedAt, endedAt: endTime } : null);
    return { kind: 'active_start', id: operationId, originalStart: edit.original.startedAt,
      proposedStart: edit.startedAt, blocked: blocked ? { ...fields(blocked), description: blocked.description || '',
        billable: isBillable(blocked) } : null, previous: fields(previous),
      canEdit: Boolean(parts.safe && validRemote && !alreadySaved && stop && state.activeCache?.id !== timerId),
      canDelete: Boolean(parts.safe && validRemote && !alreadySaved && stop && state.activeCache?.id !== timerId),
      endTime, choices, canResolve: parts.safe && validRemote && validEnd && choices.length > 0,
      reason: parts.reason || (alreadySaved
        ? 'This timer already has a saved completion on GitHub. Review the saved entry before changing queued time.'
        : !validRemote
        ? 'The running timer on GitHub no longer matches the original edit.'
        : !validEnd ? 'The original start is after the queued Stop.'
          : !previous ? 'There is no single saved entry to align with; choose a free Start manually.' : ''),
      linkedCount: stop ? 2 : 1 };
  }

  async resolveActiveStartConflict(operationId, { choice, startedAt } = {}) {
    validateEntryId(operationId);
    if (!['undo', 'after', 'manual'].includes(choice)) {
      throw new TrackerConflictError('Choose how to resolve the start-time conflict.');
    }
    const context = await this.getActiveStartConflictContext(operationId);
    if (!context?.canResolve || !context.choices.includes(choice)) {
      throw new TrackerConflictError(context?.reason || 'This timer changed. Reload and review its pending work.');
    }
    if (choice === 'after' && startedAt !== context.previous?.endedAt) {
      throw new TrackerConflictError('The earlier entry changed after the preview. Review the conflict again.');
    }
    const target = choice === 'undo' ? context.originalStart
      : choice === 'after' ? context.previous?.endedAt : startedAt;
    if (typeof target !== 'string' || !Number.isFinite(Date.parse(target))
        || new Date(target).toISOString() !== target
        || new Date(target).getTime() > this.clock().getTime()
        || new Date(target).getTime() >= new Date(context.endTime).getTime()) {
      throw new TrackerConflictError('Choose a valid Start before the timer was stopped.');
    }
    const state = await this.store.getState(), queue = state.pendingWrites ?? [];
    const parts = activeStartConflictParts(queue, operationId, state.activeCache);
    const { edit, stop, editIndex, stopIndex, timerId } = parts ?? {};
    const remote = await this.readRemoteActive();
    if (!parts?.safe || !sameTimer(remote, edit.original)
        || remote.startedAt !== edit.original.startedAt
        || edit.startedAt !== context.proposedStart || remote.startedAt !== context.originalStart
        || stop?.entry?.endedAt !== (stop ? context.endTime : undefined)) {
      throw new TrackerConflictError('The remote timer or pending queue changed. Nothing was discarded.');
    }
    const updated = applyActiveStartEdit(remote, target, this.clock());
    if (stop && target >= stop.entry.endedAt) {
      throw new TrackerConflictError('The Start cannot be after the queued Stop.');
    }
    const { files } = await this.readEditOverlapFiles([{ ...updated, endedAt: context.endTime }]);
    if (stop && files.some(file => file.entries.some(entry => entry.id === timerId))) {
      throw new TrackerConflictError('This timer has already been saved on GitHub. The pending work was preserved.');
    }
    assertNoCompletedOverlap({ ...updated, endedAt: context.endTime }, files.flatMap(file => file.entries));
    const otherIntervals = queue.filter(item => item !== edit && item !== stop)
      .flatMap(item => completedWriteFootprint(item) ?? []);
    if (otherIntervals.some(item => item.id !== timerId
        && item.start < Date.parse(context.endTime) && item.end > Date.parse(target))) {
      throw new TrackerConflictError('Another pending entry uses this time. Your queue was preserved.');
    }
    let replacement = null;
    if (stop) {
      const stoppedActive = applyActiveStartEdit(stop.activeSnapshot, target, this.clock());
      replacement = buildEntry({ active: stoppedActive, endedAt: stop.entry.endedAt, now: stop.entry.updatedAt,
        description: stop.entry.description, billable: isBillable(stop.entry) });
      validateEntry(replacement);
    }
    await this.mutateState(latest => {
      assertRecoveryStateUnchanged(latest, state, 'The pending queue or active timer changed. Reload before resolving.');
      const next = structuredClone(queue);
      next[editIndex].startedAt = target;
      next[editIndex].status = 'pending'; next[editIndex].conflictReason = ''; next[editIndex].lastError = '';
      if (stop) {
        next[stopIndex].activeSnapshot = applyActiveStartEdit(next[stopIndex].activeSnapshot, target, this.clock());
        // A stopped completion may be queued at appendMonthly already. Reverify
        // the amended remote active timer before writing its monthly record.
        next[stopIndex].stage = 'verifyActive';
        next[stopIndex].activeSha = null;
        next[stopIndex].entry = replacement;
        next[stopIndex].monthlyPath = monthlyRecordsPath(this.user, replacement.entryDate);
        next[stopIndex].requireNoOverlap = true;
      }
      const recentCache = (latest.recentCache ?? []).map(item =>
        replacement && item.id === timerId ? { ...replacement, _path: next[stopIndex].monthlyPath, _pending: true } : item);
      return { pendingWrites: next, recentCache,
        ...(replacement && latest.dayRangeIntervals ? { dayRangeIntervals: updateDayRangeIntervals(latest.dayRangeIntervals, [replacement]) } : {}),
        ...(latest.activeCache?.id === timerId
          ? { activeCache: { ...applyActiveStartEdit(latest.activeCache, target, this.clock()), _pending: true } } : {}) };
    });
    const remaining = await this.syncPending({ canSync: async () =>
      (await this.store.getState()).pendingWrites.some(item => item.id === operationId
        || (stop && item.id === timerId && item.operation === 'completeTimer')) });
    return { resolved: !remaining.some(item => item.id === operationId
      || (stop && item.id === timerId && item.operation === 'completeTimer')) };
  }


  async checkedStoppedActiveConflict(operationId) {
    validateEntryId(operationId);
    const context = await this.getActiveStartConflictContext(operationId);
    const state = await this.store.getState(), queue = state.pendingWrites ?? [];
    const parts = activeStartConflictParts(queue, operationId, state.activeCache);
    if (!context || !parts?.safe || !parts.stop || state.activeCache?.id === parts.timerId) {
      throw new TrackerConflictError(context?.reason || 'The stopped timer changed. Review the conflict again.');
    }
    const { edit, stop } = parts;
    const remote = await this.readRemoteActive();
    if (!remote || !sameTimer(remote, edit.original)
        || stop.activeSha && remote._sha !== stop.activeSha
        || remote.startedAt !== edit.original.startedAt || edit.startedAt !== context.proposedStart
        || stop.entry.endedAt !== context.endTime || stop.entry.startedAt !== context.blocked?.startedAt
        || taskUrlOf(remote) !== taskUrlOf(stop.activeSnapshot)
        || taskTitleOf(remote) !== taskTitleOf(stop.activeSnapshot)
        || remote.entryDate !== stop.activeSnapshot.entryDate
        || remote.timezone !== stop.activeSnapshot.timezone) {
      throw new TrackerConflictError('The saved timer or queued Stop changed. No local time was discarded.');
    }
    return { context, state, queue, parts, remote };
  }

  async correctedOverlapEntry(original, edits) {
    const taskUrl = normalizeStoredTaskIdentity(edits?.taskUrl);
    if (typeof edits?.taskTitle !== 'string' || edits.taskTitle.length > 500
        || typeof edits?.description !== 'string' || edits.description.length > 2000
        || typeof edits?.billable !== 'boolean') {
      throw new TrackerConflictError('The edited task, description, or billability is invalid.');
    }
    if (!/^https?:\/\//.test(taskUrl) && taskUrl !== original.taskUrl) {
      await this.assertKnownImportedTask(taskUrl);
    }
    const now = this.clock(), entry = applyEntryEdits(original, { ...edits, taskUrl }, now);
    const start = Date.parse(entry.startedAt), end = Date.parse(entry.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)
        || end <= start || end > now.getTime() || end - start > 86_400_000) {
      throw new TrackerConflictError('Choose a completed interval within 24 hours, not in the future.');
    }
    return { entry, now };
  }

  async editStoppedActiveConflict(operationId, edits) {
    const { state, queue, parts, remote } = await this.checkedStoppedActiveConflict(operationId);
    const { edit, stop, editIndex, stopIndex, timerId } = parts;
    const { entry: replacement } = await this.correctedOverlapEntry(stop.entry, edits);
    const start = Date.parse(replacement.startedAt), end = Date.parse(replacement.endedAt);
    const [{ files }, index] = await Promise.all([this.readEditOverlapFiles([replacement]), this.readTaskIndex()]);
    if (hasSavedCompletion(index, files.flatMap(file => file.entries), timerId)) {
      throw new TrackerConflictError('This timer is already saved on GitHub. The queued time was preserved.');
    }
    assertNoCompletedOverlap(replacement, files.flatMap(file => file.entries));
    const other = queue.filter(item => item !== edit && item !== stop)
      .flatMap(item => completedWriteFootprint(item) ?? []);
    if (other.some(item => item.id !== timerId && item.start < end && item.end > start)) {
      throw new TrackerConflictError('Other queued time overlaps the edited interval. Nothing was discarded.');
    }
    await this.mutateState(latest => {
      assertRecoveryStateUnchanged(latest, state, 'The queued timer changed while editing. No time was discarded.');
      // Sync the corrected completion directly, without first writing an
      // overlapping active Start. Keep the original remote timer as a SHA guard.
      const updatedStop = structuredClone(stop);
      Object.assign(updatedStop, { entry: replacement, activeSnapshot: stripInternal(remote),
        activeSha: remote._sha, monthlyPath: monthlyRecordsPath(this.user, replacement.entryDate),
        editedCompletion: true, requireNoOverlap: true, stage: 'verifyActive', status: 'pending',
        lastError: '', conflictReason: '' });
      const pendingWrites = replaceRecoveryOperations(queue, editIndex, [editIndex, stopIndex], updatedStop);
      return { pendingWrites, recentCache: (latest.recentCache ?? []).map(entry =>
        entry.id === timerId ? { ...replacement, _path: updatedStop.monthlyPath, _pending: true } : entry),
        ...(latest.dayRangeIntervals ? { dayRangeIntervals: updateDayRangeIntervals(latest.dayRangeIntervals, [replacement]) } : {}) };
    });
    const remaining = await this.syncPending({ canSync: async () =>
      (await this.store.getState()).pendingWrites.some(item => item.id === timerId && item.operation === 'completeTimer') });
    return { resolved: !remaining.some(item => item.id === timerId && item.operation === 'completeTimer') };
  }

  async deleteStoppedActiveConflict(operationId) {
    const { state, queue, parts, remote } = await this.checkedStoppedActiveConflict(operationId);
    const { editIndex, stopIndex, timerId } = parts;
    // Never remove local tracked time until GitHub has acknowledged deleting
    // the original active timer. Check all months and the task index first.
    const history = await this.readRecoveryHistory();
    if (hasSavedCompletion(history.index, history.entries, timerId)) {
      throw new TrackerConflictError('This timer is already saved on GitHub. No time was deleted.');
    }
    if (!sameValue(remote, history.remote)) {
      throw new TrackerConflictError('GitHub changed during deletion checks. Local time was kept.');
    }
    const freshSnapshot = await this.assertRecoverySnapshotCurrent(history);
    // Check the branch head and task index in the same GitHub commit.
    // A completed record saved after our history scan must block deletion.
    await this.github.updateTextsAtomic([
      { path: activeRecordPath(this.user), sha: remote._sha, text: null },
    ], 'timer: discard stopped ' + this.user, {
      guards: [{ path: TASK_INDEX_PATH, sha: history.index.sha }],
      expectedHeadSha: freshSnapshot.headSha,
    });
    await this.mutateState(latest => {
      assertRecoveryStateUnchanged(latest, state, 'The local queue changed after GitHub deleted the timer. Local time was kept for review.');
      return { pendingWrites: queue.filter((_, index) => index !== editIndex && index !== stopIndex),
        ...removedRecoveryCache(latest, timerId) };
    });
    return { deleted: true };
  }

  // The original active timer disappeared or was replaced before its Stop
  // could be saved. Preserve the stopped entry; it is a separate completed
  // record, not an instruction to overwrite the newer remote active timer.
  async getPendingCompletionConflictContext(operationId) {
    validateEntryId(operationId);
    const state = await this.store.getState(), queue = state.pendingWrites ?? [];
    const parts = pendingCompletionConflictParts(queue, operationId, state.activeCache);
    if (!parts) return null;
    const { stop } = parts;
    validateEntry(stop.entry);
    const [remote, index] = await Promise.all([this.readRemoteActive(), this.readTaskIndex()]);
    const indexed = Object.values(index.index.tasks).some(task => task.recordIds.includes(stop.entry.id));
    const saved = await this.readEditOverlapFiles([stop.entry]);
    const alreadySaved = indexed || saved.files.some(file => file.entries.some(entry => entry.id === stop.entry.id));
    const matchingSaved = this.verifiedSavedCompletion(stop.entry,
      saved.files.find(file => file.path === stop.monthlyPath), index);
    const remoteSameTimer = sameTimer(remote, stop.entry);
    const available = Boolean(parts.safe && !alreadySaved && !remoteSameTimer);
    const canConfirm = Boolean(parts.safe && matchingSaved && !remoteSameTimer);
    return {
      kind: 'pending_completion', id: operationId,
      blocked: recoveryRecordFields(stop.entry), remote: recoveryRecordFields(remote),
      next: recoveryRecordFields(stop.nextActive), switching: stop.operation === 'completeTimerAndStart',
      canEdit: available, canDelete: available, canConfirm,
      reason: parts.reason || (remoteSameTimer
        ? 'This timer is still running on GitHub. Review it before changing the queued Stop.'
        : matchingSaved
          ? 'The completion matches GitHub. Confirm saved time to clear this local conflict.'
          : alreadySaved
            ? 'GitHub has a record with this ID, but the completed time does not match the queued entry or task index. Review both copies before proceeding.'
            : ''),
    };
  }

  async confirmSavedCompletionConflict(operationId) {
    validateEntryId(operationId);
    const context = await this.getPendingCompletionConflictContext(operationId);
    if (!context?.canConfirm) {
      throw new TrackerConflictError(context?.reason || 'The saved completion could not be verified. Local time was preserved.');
    }
    const state = await this.store.getState(), queue = state.pendingWrites ?? [];
    const parts = pendingCompletionConflictParts(queue, operationId, state.activeCache);
    if (!parts?.safe) throw new TrackerConflictError('The pending completion changed. Nothing was removed.');
    const stop = parts.stop, activePath = activeRecordPath(this.user);
    const snapshotOptions = { includeActive: activePath, includePaths: [TASK_INDEX_PATH] };
    const [snapshot, month, index, remote] = await Promise.all([
      this.github.listTextFilesSnapshot('times/', snapshotOptions),
      this.readMonthly(stop.monthlyPath), this.readTaskIndex(), this.readRemoteActive(),
    ]);
    const saved = this.verifiedSavedCompletion(stop.entry, month, index);
    const fileSha = path => snapshot.files.find(file => file.path === path)?.sha ?? null;
    if (!saved || sameTimer(remote, stop.entry)
        || fileSha(month.path) !== month.sha
        || fileSha(index.path) !== index.sha
        || fileSha(activePath) !== (remote?._sha ?? null)) {
      throw new TrackerConflictError('The saved time, index or active timer changed. Nothing was removed. Recheck GitHub.');
    }
    // A read-only acknowledgment still needs fresh remote and local checks:
    // never discard a queued edit because an older snapshot contained its ID.
    await this.assertRecoverySnapshotCurrent({ snapshot, snapshotOptions });
    await this.mutateState(latest => {
      assertRecoveryStateUnchanged(latest, state, 'The local queue changed during confirmation. No time was discarded.');
      const next = structuredClone(queue), nextStart = recoveredSwitchStart(stop);
      next.splice(parts.index, 1, ...(nextStart ? [nextStart] : []));
      return { pendingWrites: next, ...savedRecoveryCache(latest, saved) };
    });
    return { confirmed: true, ...(stop.nextActive ? { nextTimerPending: true } : {}) };
  }

  async editPendingCompletionConflict(operationId, edits) {
    const context = await this.getPendingCompletionConflictContext(operationId);
    if (!context?.canEdit) {
      throw new TrackerConflictError(context?.reason || 'This stopped timer changed. Recheck it before editing.');
    }
    const state = await this.store.getState(), queue = state.pendingWrites ?? [];
    const parts = pendingCompletionConflictParts(queue, operationId, state.activeCache);
    if (!parts?.safe || !sameValue(context.blocked, recoveryRecordFields(parts.stop.entry))) {
      throw new TrackerConflictError('The local completion changed while editing. No time was discarded.');
    }
    const { entry: corrected, now } = await this.correctedOverlapEntry(parts.stop.entry, edits);
    const [remote, taskIndex, overlap] = await Promise.all([
      this.readRemoteActive(), this.readTaskIndex(), this.readEditOverlapFiles([corrected]),
    ]);
    if (sameTimer(remote, corrected)) {
      throw new TrackerConflictError('The timer is still running on GitHub. Your stopped time was kept.');
    }
    if (remote && Date.parse(corrected.endedAt) > Date.parse(remote.startedAt)) {
      throw new TrackerConflictError('The edited time overlaps the current GitHub timer. Choose an End before its Start.');
    }
    if (state.activeCache && Date.parse(corrected.endedAt) > Date.parse(state.activeCache.startedAt)) {
      throw new TrackerConflictError('The edited time overlaps the timer running in this browser.');
    }
    if (parts.stop.nextActive && Date.parse(corrected.endedAt) > Date.parse(parts.stop.nextActive.startedAt)) {
      throw new TrackerConflictError('The stopped time overlaps the next queued timer. Choose an earlier End.');
    }
    if (hasSavedCompletion(taskIndex, overlap.files.flatMap(file => file.entries), corrected.id)) {
      throw new TrackerConflictError('This completed time is already saved on GitHub. No queued time was changed.');
    }
    assertNoCompletedOverlap(corrected, overlap.files.flatMap(file => file.entries));
    const other = queue.filter(item => item !== parts.stop)
      .flatMap(item => completedWriteFootprint(item) ?? (item.operation === 'completeTimer'
        && item.entry ? [{ id: item.entry.id, start: Date.parse(item.entry.startedAt),
          end: Date.parse(item.entry.endedAt) }] : []));
    if (other.some(item => item.id !== corrected.id
        && item.start < Date.parse(corrected.endedAt) && item.end > Date.parse(corrected.startedAt))) {
      throw new TrackerConflictError('Another queued entry overlaps this time. Your queued Stop was preserved.');
    }
    const addition = recoveredAddition(corrected, now, queue.length);
    await this.mutateState(latest => {
      assertRecoveryStateUnchanged(latest, state, 'The pending queue changed while editing. Your time was preserved.');
      const pendingWrites = structuredClone(queue);
      const recoveredStart = recoveredSwitchStart(parts.stop);
      pendingWrites.splice(parts.index, 1, addition, ...(recoveredStart ? [recoveredStart] : []));
      const local = { ...corrected, _path: monthlyRecordsPath(this.user, corrected.entryDate), _pending: true };
      const cache = latest.recentCache ?? [];
      const existing = cache.some(item => item.id === corrected.id);
      return { pendingWrites,
        recentCache: (existing ? cache.map(item => item.id === corrected.id ? local : item)
          : [local, ...cache]).slice(0, 50),
        dayRangeIntervals: updateDayRangeIntervals(latest.dayRangeIntervals, [corrected]),
      };
    });
    const remaining = await this.syncPending({ canSync: async () =>
      (await this.store.getState()).pendingWrites.some(item => item.id === addition.id
        || parts.stop.nextActive && item.id === parts.stop.nextActive.id) });
    return { resolved: !remaining.some(item => item.id === addition.id),
      ...(parts.stop.nextActive ? { nextTimerPending: remaining.some(item => item.id === parts.stop.nextActive.id) } : {}) };
  }

  async deletePendingCompletionConflict(operationId) {
    const context = await this.getPendingCompletionConflictContext(operationId);
    if (!context?.canDelete) {
      throw new TrackerConflictError(context?.reason || 'This stopped time changed. Recheck it before deleting.');
    }
    const state = await this.store.getState(), queue = state.pendingWrites ?? [];
    const parts = pendingCompletionConflictParts(queue, operationId, state.activeCache);
    if (!parts?.safe || parts.stop.entry.startedAt !== context.blocked.startedAt
        || parts.stop.entry.endedAt !== context.blocked.endedAt) {
      throw new TrackerConflictError('The queued Stop changed. Nothing was deleted.');
    }
    // A lost GitHub acknowledgement is not proof that the time was never
    // stored. Check every historical month plus the mandatory task index.
    const history = await this.readRecoveryHistory();
    if (sameTimer(history.remote, parts.stop.entry) || hasSavedCompletion(history.index, history.entries, operationId)) {
      throw new TrackerConflictError('This time already exists on GitHub. The local completion was preserved.');
    }
    await this.assertRecoverySnapshotCurrent(history);
    await this.mutateState(latest => {
      assertRecoveryStateUnchanged(latest, state, 'The queued Stop changed. No tracked time was deleted.');
      const next = structuredClone(queue);
      const recoveredStart = recoveredSwitchStart(parts.stop);
      next.splice(parts.index, 1, ...(recoveredStart ? [recoveredStart] : []));
      return { pendingWrites: next,
        ...removedRecoveryCache(latest, operationId),
        dayRangeIntervals: (latest.dayRangeIntervals ?? []).filter(item => item.id !== operationId) };
    });
    return { deleted: true, ...(parts.stop.nextActive ? { nextTimerPending: true } : {}) };
  }

  async getStoppedOverlapContext(timerId) {
    validateEntryId(timerId);
    const state = await this.store.getState(), queue = state.pendingWrites ?? [];
    const initial = stoppedOverlapQueueParts(queue, timerId);
    if (!initial) return null;
    const blocked = initial.stop.entry;
    validateEntry(blocked);
    const remoteActive = await this.readRemoteActive();
    const { files } = await this.readEditOverlapFiles([blocked]);
    const matches = files.flatMap(file => file.entries).filter(item =>
      new Date(item.startedAt).getTime() < new Date(blocked.endedAt).getTime()
      && new Date(item.endedAt).getTime() > new Date(blocked.startedAt).getTime());
    if (matches.length !== 1 || matches[0].id === timerId) return null;
    const previous = matches[0], parts = stoppedOverlapQueueParts(queue, timerId, previous.id);
    const edit = parts?.edit, request = edit?.request;
    let queuedPrevious = null;
    if (edit) {
      try { queuedPrevious = applyEntryEdits(previous, request.edits, editClock(this.clock, previous)); }
      catch { /* Show the pair without allowing an unsafe edit. */ }
    }
    const fullEditable = !state.activeCache && !remoteActive && parts?.safe
      && initial.stop.monthlyPath === monthlyRecordsPath(this.user, blocked.entryDate)
      && (!edit || (queuedPrevious && request.path === monthlyRecordsPath(this.user, previous.entryDate)
        && request.originalSha === files.find(file => file.path === request.path)?.sha
        && matchesQueuedOriginal(request, previous)));
    const editable = fullEditable && (!edit || onlyEndEdit(request));
    const localDelete = stoppedOverlapLocalDeletionParts(queue, timerId);
    const canDeleteLocal = localDelete.safe && state.activeCache?.id !== timerId
      && !sameTimer(remoteActive, { id: timerId });
    const editBlockedReason = editable ? '' : remoteActive
      ? 'Another timer is running on GitHub. Review its state before editing this overlap.'
      : state.activeCache
        ? 'A timer is active in this browser. Its pending operations must be resolved before editing this overlap.'
      : !parts?.safe ? 'The queue contains other edits or dependencies that prevent moving this boundary.'
        : edit && !onlyEndEdit(request)
          ? 'The queued edit of the saved entry changes more than its End time.'
          : edit && request.originalSha !== files.find(file => file.path === request.path)?.sha
            ? 'The saved GitHub entry changed since the earlier edit was queued.'
            : 'The queued records or GitHub entry no longer match the expected state.';
    const canEditLocal = localDelete.safe && !state.activeCache && !remoteActive;
    return { blocked: recoveryRecordFields(blocked), previous: recoveryRecordFields(previous),
      reviewedPrevious: { id: previous.id, sha: previous._sha },
      queuedPrevious: recoveryRecordFields(queuedPrevious), editable: Boolean(editable),
      canEditLocal, canEditPrevious: Boolean(fullEditable), canDeletePrevious: Boolean(fullEditable),
      editBlockedReason, canDeleteLocal,
      localDeleteBlockedReason: canDeleteLocal ? '' : localDelete.reason
        || (sameTimer(remoteActive, { id: timerId })
          ? 'This timer is already running on GitHub.' : 'This timer is still active in this browser.') };
  }

  async deleteLocalStoppedOverlap(timerId) {
    const state = await this.store.getState(), queue = state.pendingWrites ?? [];
    const parts = stoppedOverlapLocalDeletionParts(queue, timerId);
    if (!parts.safe || state.activeCache?.id === timerId) {
      throw new TrackerConflictError(parts.reason || 'This timer is still active locally. No pending work was deleted.');
    }
    const { stop, startIndex, stopIndex } = parts;
    validateEntry(stop.entry);
    if (stop.monthlyPath !== monthlyRecordsPath(this.user, stop.entry.entryDate)) {
      throw new TrackerConflictError('The pending Stop has an unexpected storage path. No pending work was deleted.');
    }

    // A missing acknowledgement is not proof that GitHub never saved the timer.
    // Check the entire personal time history, task index, and active timer.
    const history = await this.readRecoveryHistory();
    if (hasSavedCompletion(history.index, history.entries, timerId)
        || sameTimer(history.remote, { id: timerId })) {
      throw new TrackerConflictError('This stopped timer is already on GitHub. No pending work was deleted.');
    }
    await this.assertRecoverySnapshotCurrent(history);
    await this.mutateState(latest => {
      assertRecoveryStateUnchanged(latest, state, 'The pending queue changed before deletion. No pending work was deleted.');
      return {
        pendingWrites: queue.filter((_, index) => index !== startIndex && index !== stopIndex),
        ...removedRecoveryCache(latest, timerId),
      };
    });
    return { deleted: true };
  }

  async checkedStoppedOverlap(timerId, { fullEdit = false, reviewedPrevious } = {}) {
    const context = await this.getStoppedOverlapContext(timerId);
    if (!reviewedPrevious?.id || !reviewedPrevious.sha
        || context?.reviewedPrevious?.id !== reviewedPrevious.id
        || context?.reviewedPrevious?.sha !== reviewedPrevious.sha
        || !(fullEdit ? context?.canEditPrevious : context?.editable)) {
      throw new TrackerConflictError('The stopped overlap changed. Reload Activity and review the pending work.');
    }
    const state = await this.store.getState(), queue = state.pendingWrites ?? [];
    const parts = stoppedOverlapQueueParts(queue, timerId, context.previous.id);
    const { stop, edit } = parts ?? {};
    const path = monthlyRecordsPath(this.user, context.previous.entryDate);
    const [source, remoteActive] = await Promise.all([this.readMonthly(path), this.readRemoteActive()]);
    const saved = source.entries.find(item => item.id === context.previous.id);
    if (!parts?.safe || source.sha !== reviewedPrevious.sha
        || stop.monthlyPath !== monthlyRecordsPath(this.user, stop.entry.entryDate)
        || ['id', 'startedAt', 'endedAt'].some(key => !sameValue(stop.entry[key], context.blocked[key]))
        || (edit && (edit.request?.path !== path || edit.request.originalSha !== source.sha
          || (!fullEdit && !onlyEndEdit(edit.request)) || !matchesQueuedOriginal(edit.request, saved)))
        || !saved || ['id', 'entryDate', 'timezone', 'startedAt', 'endedAt']
          .some(key => !sameValue(saved[key], context.previous[key]))
        || taskUrlOf(saved) !== context.previous.taskUrl
        || state.activeCache || remoteActive) {
      throw new TrackerConflictError('The queued work or GitHub entry changed. No work was discarded.');
    }
    return { context, queue, parts, path, source, saved };
  }

  async editLocalStoppedOverlap(timerId, edits) {
    validateEntryId(timerId);
    const state = await this.store.getState(), queue = state.pendingWrites ?? [];
    const parts = stoppedOverlapLocalDeletionParts(queue, timerId);
    if (!parts.safe || state.activeCache) {
      throw new TrackerConflictError(parts.reason || 'The pending timer changed locally. No tracked time was discarded.');
    }
    const { stop, startIndex, stopIndex } = parts;
    validateEntry(stop.entry);
    if (stop.monthlyPath !== monthlyRecordsPath(this.user, stop.entry.entryDate)) {
      throw new TrackerConflictError('The pending timer has an unexpected storage path.');
    }
    const { entry: updated, now } = await this.correctedOverlapEntry(stop.entry, edits);
    const start = Date.parse(updated.startedAt), end = Date.parse(updated.endedAt);
    const [remoteActive, taskIndex, overlap] = await Promise.all([
      this.readRemoteActive(), this.readTaskIndex(), this.readEditOverlapFiles([updated]),
    ]);
    if (remoteActive) {
      throw new TrackerConflictError('A timer is running on GitHub. Review it before editing the queued time.');
    }
    if (hasSavedCompletion(taskIndex, overlap.files.flatMap(file => file.entries), timerId)) {
      throw new TrackerConflictError('This timer already has saved time on GitHub. The local timer was preserved.');
    }
    assertNoCompletedOverlap(updated, overlap.files.flatMap(file => file.entries));
    const other = queue.filter(item => item !== parts.start && item !== stop)
      .flatMap(item => completedWriteFootprint(item) ?? []);
    if (other.some(item => item.id !== timerId && item.start < end && item.end > start)) {
      throw new TrackerConflictError('Another queued change uses the edited interval. Nothing was discarded.');
    }
    // A queued edit of the earlier saved entry must go first: adding time
    // in the same month changes that file's SHA, which would otherwise strand
    // the earlier edit even when the corrected timer does not overlap it.
    const context = await this.getStoppedOverlapContext(timerId);
    const related = context ? stoppedOverlapQueueParts(queue, timerId, context.previous.id) : null;
    const earlierEdit = related?.safe ? related.edit : null;
    // This timer was never started remotely. Convert the linked local Start
    // and Stop into a single durable completed addition, keeping its record ID.
    const addition = recoveredAddition(updated, now, queue.length);
    await this.mutateState(latest => {
      assertRecoveryStateUnchanged(latest, state, 'The queued timer changed while editing. No time was discarded.');
      const next = replaceRecoveryOperations(queue, startIndex, [startIndex, stopIndex, earlierEdit ? related.editIndex : -1],
        ...(earlierEdit ? [structuredClone(earlierEdit)] : []), addition);
      return { pendingWrites: next,
        recentCache: (latest.recentCache ?? []).map(item => item.id === timerId
          ? { ...updated, _path: monthlyRecordsPath(this.user, updated.entryDate), _pending: true } : item),
        ...(latest.dayRangeIntervals ? { dayRangeIntervals: updateDayRangeIntervals(latest.dayRangeIntervals, [updated]) } : {}),
      };
    });
    const remaining = await this.syncPending({ canSync: async () =>
      (await this.store.getState()).pendingWrites.some(item => item.id === addition.id) });
    return { resolved: !remaining.some(item => item.id === addition.id) };
  }

  async editSavedStoppedOverlap(timerId, edits, reviewedPrevious) {
    const { queue, parts, path, source, saved } = await this.checkedStoppedOverlap(timerId, { fullEdit: true, reviewedPrevious });
    const { start, stop, edit, startIndex, stopIndex, editIndex } = parts;
    const { entry: revised, now } = await this.correctedOverlapEntry(saved, edits);
    const overlap = await this.readEditOverlapFiles([revised, stop.entry], source);
    if (overlap.files.find(file => file.path === path)?.sha !== source.sha) {
      throw new TrackerConflictError('The saved entry changed on GitHub. No queued changes were discarded.');
    }
    const others = overlap.files.flatMap(file => file.entries).filter(item => item.id !== saved.id);
    assertNoCompletedOverlap(revised, others);
    assertNoCompletedOverlap(stop.entry, [...others.filter(item => item.id !== timerId), revised]);
    const pending = queue.filter(item => item !== start && item !== stop && item !== edit)
      .flatMap(item => completedWriteFootprint(item) ?? []);
    if (pending.some(item => item.id !== timerId && item.id !== saved.id
        && [revised, stop.entry].some(record => item.start < Date.parse(record.endedAt)
          && item.end > Date.parse(record.startedAt)))) {
      throw new TrackerConflictError('Another queued entry uses the changed time. Nothing was discarded.');
    }
    const correctedEdit = edit ? structuredClone(edit) : {
      operation: 'editEntry', id: createUlid(now.getTime() + queue.length),
      stage: 'editEntry', status: 'pending', retryCount: 0, queuedAt: now.toISOString(), lastError: '',
    };
    Object.assign(correctedEdit, {
      operation: 'editEntry', stage: 'editEntry', status: 'pending',
      strictOriginal: true, lastError: '', conflictReason: '',
      request: { path, originalSha: source.sha, index: source.entries.findIndex(item => item.id === saved.id),
        original: stripInternal(saved), edits: { ...edits, taskUrl: revised.taskUrl } },
    });
    await this.mutateState(latest => {
      if (!sameValue(latest.pendingWrites, queue) || latest.activeCache) {
        throw new TrackerConflictError('The pending queue changed while editing the saved entry.');
      }
      const nextStart = structuredClone(start), nextStop = structuredClone(stop);
      nextStart.status = 'pending'; nextStart.conflictReason = ''; nextStart.lastError = '';
      nextStart.alignmentRequiresEmptyRemote = true;
      nextStop.requireNoOverlap = true;
      const next = replaceRecoveryOperations(queue, startIndex, [startIndex, stopIndex, editIndex],
        correctedEdit, nextStart, nextStop);
      return { pendingWrites: next,
        recentCache: (latest.recentCache ?? []).map(item => item.id === saved.id
          ? { ...revised, _path: monthlyRecordsPath(this.user, revised.entryDate), _pending: true } : item),
        ...(latest.dayRangeIntervals ? { dayRangeIntervals: updateDayRangeIntervals(latest.dayRangeIntervals, [revised]) } : {}),
      };
    });
    const remaining = await this.syncPending({ canSync: async () =>
      (await this.store.getState()).pendingWrites.some(item => item.id === timerId
        || item.id === correctedEdit.id) });
    return { resolved: !remaining.some(item => item.id === timerId || item.id === correctedEdit.id) };
  }

  async editStoppedOverlap(timerId, { side, edits, reviewedPrevious } = {}) {
    validateEntryId(timerId);
    if (!['local', 'previous'].includes(side) || !edits || typeof edits !== 'object') {
      throw new TrackerConflictError('Choose which time entry to edit.');
    }
    return side === 'local'
      ? this.editLocalStoppedOverlap(timerId, edits)
      : this.editSavedStoppedOverlap(timerId, edits, reviewedPrevious);
  }

  async deleteStoppedOverlap(timerId, { side, reviewedPrevious } = {}) {
    validateEntryId(timerId);
    if (!['previous', 'local'].includes(side)) throw new TrackerConflictError('Choose a stopped overlap row to delete.');
    if (side === 'local') return this.deleteLocalStoppedOverlap(timerId);
    const { queue, parts, path, source, saved } = await this.checkedStoppedOverlap(timerId, { fullEdit: true, reviewedPrevious });
    const { edit, startIndex, stopIndex } = parts;
    const request = edit?.request;
    const queuedAt = this.clock();
    const deletion = {
      operation: 'deleteEntry', id: createUlid(queuedAt.getTime() + queue.length), status: 'pending',
      retryCount: 0, stage: 'deleteEntry', strictOriginal: true,
      ...(edit ? { stoppedOverlapCancelEditId: edit.id,
        stoppedOverlapDependentEdit: structuredClone(request) } : {}),
      request: { path, originalSha: source.sha, index: source.entries.indexOf(saved), original: stripInternal(saved) },
      queuedAt: queuedAt.toISOString(), lastError: '',
    };
    await this.mutateState(latest => {
      if (!sameValue(latest.pendingWrites, queue) || latest.activeCache) {
        throw new TrackerConflictError('The pending queue changed before deletion. No pending work was deleted.');
      }
      const next = structuredClone(queue);
      next[startIndex].status = 'pending'; next[startIndex].lastError = ''; next[startIndex].conflictReason = '';
      next[startIndex].alignmentRequiresEmptyRemote = true;
      next[stopIndex].requireNoOverlap = true;
      next.splice(startIndex, 0, deletion);
      return { pendingWrites: next };
    });
    const remaining = await this.syncPending({ canSync: async () =>
      (await this.store.getState()).pendingWrites.some(item => item.id === timerId || item.id === deletion.id) });
    return { deleted: !remaining.some(item => item.id === deletion.id),
      resolved: !remaining.some(item => item.id === timerId || item.id === deletion.id) };
  }

  async resolveStoppedOverlap(timerId, { side, startedAt, endedAt, reviewedPrevious } = {}) {
    validateEntryId(timerId);
    if (!['previous', 'local'].includes(side) || typeof startedAt !== 'string' || typeof endedAt !== 'string'
        || !Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(endedAt))
        || new Date(startedAt).toISOString() !== startedAt || new Date(endedAt).toISOString() !== endedAt) {
      throw new TrackerConflictError('Select one valid UTC interval to resolve the stopped overlap.');
    }
    const { context, queue, parts, path, source, saved } = await this.checkedStoppedOverlap(timerId, { reviewedPrevious });
    const { start, stop, edit, startIndex, stopIndex, editIndex } = parts;
    const previous = context.previous, remotePrevious = saved;
    const localStart = side === 'local' ? startedAt : context.blocked.startedAt;
    const previousEnd = side === 'previous' ? endedAt : context.queuedPrevious?.endedAt ?? previous.endedAt;
    if ((side === 'previous' && startedAt !== previous.startedAt)
        || (side === 'local' && endedAt !== context.blocked.endedAt)
        || new Date(previousEnd) > new Date(localStart)
        || new Date(localStart) > new Date(context.blocked.endedAt)
        || new Date(previousEnd) < new Date(previous.startedAt)) {
      throw new TrackerConflictError('The selected boundaries still overlap or change an unselected endpoint.');
    }
    const active = side === 'local'
      ? applyActiveStartEdit(start.nextActive, localStart, this.clock()) : start.nextActive;
    if (active.entryDate !== start.nextActive.entryDate) {
      throw new TrackerConflictError('The selected start crosses the timer date. Review Activity.');
    }
    const completion = buildEntry({ active, endedAt: stop.entry.endedAt, now: this.clock(),
      description: stop.entry.description, billable: isBillable(stop.entry) });
    validateEntry(completion);
    let correctedEdit = null;
    if (edit || side === 'previous') {
      correctedEdit = edit ? structuredClone(edit) : {
        operation: 'editEntry', id: createUlid(this.clock().getTime() + queue.length),
        stage: 'editEntry', status: 'pending', retryCount: 0, lastError: '',
        queuedAt: this.clock().toISOString(),
        request: { path, originalSha: source.sha, index: source.entries.indexOf(remotePrevious),
          original: stripInternal(remotePrevious), edits: {} },
      };
      correctedEdit.request.edits.endedAt = previousEnd;
      correctedEdit.strictOriginal = true;
      correctedEdit.status = 'pending'; correctedEdit.lastError = ''; correctedEdit.conflictReason = '';
    }
    const revisedPrevious = correctedEdit
      ? applyEntryEdits(remotePrevious, correctedEdit.request.edits, editClock(this.clock, remotePrevious)) : null;
    // Persist the repaired dependency chain without changing the other queued
    // operations or their relative order. Strict edits never silently rebase.
    await this.mutateState(latest => {
      if (!sameValue(latest.pendingWrites, queue) || latest.activeCache) {
        throw new TrackerConflictError('The pending queue or active timer changed. Reload before resolving.');
      }
      const nextStart = structuredClone(start), nextStop = structuredClone(stop);
      nextStart.nextActive = active;
      nextStart.alignmentRequiresEmptyRemote = true;
      nextStart.status = 'pending'; nextStart.conflictReason = ''; nextStart.lastError = '';
      nextStop.entry = completion; nextStop.activeSnapshot = active; nextStop.requireNoOverlap = true;
      const next = replaceRecoveryOperations(queue, startIndex, [startIndex, stopIndex, editIndex],
        ...(correctedEdit ? [correctedEdit] : []), nextStart, nextStop);
      return { pendingWrites: next, recentCache: (latest.recentCache ?? []).map(item =>
        item.id === timerId ? { ...completion, _path: stop.monthlyPath, _pending: true }
          : revisedPrevious && item.id === previous.id
            ? { ...revisedPrevious, _path: path, _pending: true } : item) };
    });
    const remaining = await this.syncPending({ canSync: async () =>
      (await this.store.getState()).pendingWrites.some(item => item.id === timerId
        || (correctedEdit && item.id === correctedEdit.id)) });
    return { resolved: !remaining.some(item => item.id === timerId || (correctedEdit && item.id === correctedEdit.id)) };
  }

  async readRecoveryHistory() {
    const activePath = activeRecordPath(this.user);
    const snapshotOptions = { includeActive: activePath, includePaths: [TASK_INDEX_PATH] };
    const [snapshot, remote, index] = await Promise.all([
      this.github.listTextFilesSnapshot('times/', snapshotOptions), this.readRemoteActive(), this.readTaskIndex(),
    ]);
    const fileSha = path => snapshot.files.find(file => file.path === path)?.sha ?? null;
    if (fileSha(activePath) !== (remote?._sha ?? null) || fileSha(TASK_INDEX_PATH) !== index.sha) {
      throw new TrackerConflictError('GitHub changed while checking queued time. Recheck GitHub.');
    }
    // Read the user's entire history at the reviewed blob SHAs: edits may
    // have moved the record outside its original monthly partition.
    const monthly = snapshot.files.flatMap(file => {
      try { return [{ ...file, month: monthFromPath(file.path, this.user) }]; }
      catch { return []; }
    });
    const entries = [];
    for (let offset = 0; offset < monthly.length; offset += 6) {
      const batch = await Promise.all(monthly.slice(offset, offset + 6).map(async file => {
        const cached = await this.reports?.cachedMonthly(file.path, file.sha);
        if (cached) return cached.entries;
        const blob = await this.github.getBlobText(file.path, file.sha);
        return parseMonthlyRecords(blob.text, { user: this.user, month: file.month,
          path: file.path, sha: file.sha });
      }));
      entries.push(...batch.flat());
    }
    return { snapshot, snapshotOptions, remote, index, entries };
  }

  async assertRecoverySnapshotCurrent({ snapshot, snapshotOptions }) {
    const fresh = await this.github.listTextFilesSnapshot('times/', snapshotOptions);
    if (snapshot.headSha !== fresh.headSha || !sameValue(snapshot.files, fresh.files)) {
      throw new TrackerConflictError('GitHub changed during recovery checks. The queued work was kept. Recheck GitHub.');
    }
    return fresh;
  }

  // A conflicted Start may represent historical work even after a newer
  // GitHub timer has stopped. Let the user supply the actual End without
  // overwriting a running timer or silently dropping the old Start.
  async inspectQueuedStartRecovery(operationId) {
    validateEntryId(operationId);
    const state = await this.store.getState(), queue = state.pendingWrites ?? [];
    const matches = queue.filter(item => item.id === operationId && item.operation === 'startTimer');
    if (matches.length !== 1) return null;
    const operation = matches[0], active = operation.nextActive;
    if (operation.status !== 'conflict' || operation.stage !== 'startNext'
        || !['add_time_overlap_changed', 'queued_start_remote_active'].includes(operation.conflictReason)
        || !operation.requireNoOverlap || !active) return null;
    validateActiveTimer(active);
    if (active.id !== operationId) return null;
    const { snapshot, snapshotOptions, remote, index, entries } = await this.readRecoveryHistory();
    const fileSha = path => snapshot.files.find(file => file.path === path)?.sha ?? null;
    const savedRecords = entries.filter(entry => entry.id === active.id);
    const indexedTasks = indexedTasksForRecord(index, active.id);
    const alreadySaved = Boolean(savedRecords.length || indexedTasks.length);
    const saved = savedRecords.length === 1 ? savedRecords[0] : null;
    const verified = Boolean(saved && indexedTasks.length === 1
      && indexedTasks[0] === taskUrlOf(saved) && fileSha(saved._path) === saved._sha);
    const dependent = queue.some(item => item !== operation && stoppedOverlapReferencesEntry(item, active.id));
    const unrelatedLocal = state.activeCache?._pending && state.activeCache.id !== active.id;
    return { state, queue, operation, active, remote, snapshot, snapshotOptions, entries,
      alreadySaved, saved, verified, dependent, unrelatedLocal };
  }

  async getQueuedStartRecoveryContext(operationId) {
    return this.queuedStartRecoveryContext(await this.inspectQueuedStartRecovery(operationId));
  }

  queuedStartRecoveryContext(inspection) {
    if (!inspection) return null;
    const { operation, active, remote, entries, alreadySaved, saved, verified, dependent, unrelatedLocal } = inspection;
    const operationId = operation.id;
    const started = Date.parse(active.startedAt), remoteStarted = Date.parse(remote?.startedAt);
    const canConfirm = verified && !dependent && !sameTimer(remote, active);
    if (alreadySaved) return {
      kind: 'queued_start_recovery', id: operationId, remote: recoveryRecordFields(remote),
      alreadySaved: true, canComplete: false, preview: null, canConfirm, saved: recoveryRecordFields(saved),
      ...(canConfirm ? { savedSha: saved._sha } : {}),
      reason: !verified ? 'The saved record and GitHub task index do not agree. Your local Start has been kept.'
        : dependent ? 'Another queued change depends on this Start. Review it before confirming saved time.'
          : sameTimer(remote, active) ? 'This timer is also still running on GitHub. Recheck before confirming.'
            : 'This timer already has a completed entry on GitHub. Confirm saved time to keep that entry and clear only the obsolete local Start.',
    };
    const now = this.clock();
    const limit = Math.min(now.getTime(), remote ? remoteStarted : Infinity);
    const canComplete = (!remote || !sameTimer(remote, active) && remoteStarted > started)
      && !dependent && !unrelatedLocal && started < limit;
    let suggestedStart = active.startedAt;
    if (canComplete) {
      const overlapping = entries.filter(entry =>
        entry.id !== active.id && Date.parse(entry.startedAt) <= started
        && Date.parse(entry.endedAt) > started);
      if (overlapping.length === 1 && Date.parse(overlapping[0].endedAt) < limit) {
        suggestedStart = overlapping[0].endedAt;
      }
    }
    const candidate = Date.parse(suggestedStart);
    const end = Math.min(candidate + 5 * 60_000, limit);
    const preview = canComplete && end > candidate
      ? { id: active.id, taskUrl: taskUrlOf(active), taskTitle: taskTitleOf(active),
        entryDate: localDateInTimezone(suggestedStart, active.timezone),
        timezone: active.timezone, startedAt: suggestedStart, endedAt: new Date(end).toISOString(),
        description: active.description || '', billable: isBillable(active) } : null;
    return { kind: 'queued_start_recovery', id: operationId,
      remote: remote ? { id: remote.id, taskTitle: taskTitleOf(remote),
        taskUrl: taskUrlOf(remote), startedAt: remote.startedAt } : null,
      canComplete: Boolean(preview), preview, canDiscard: !dependent && !sameTimer(remote, active),
      reason: dependent ? 'A later pending change depends on this Start and must be resolved first.'
        : unrelatedLocal ? 'A different unsaved timer is active in this browser.'
          : remote && !sameTimer(remote, active) && remoteStarted > started
            ? 'Another timer is running on GitHub. Save the earlier work as completed time with an explicit End.'
            : remote ? 'The GitHub timer cannot be replaced by this queued Start.' : '' };
  }

  async confirmSavedQueuedStart(operationId, savedSha) {
    const inspection = await this.inspectQueuedStartRecovery(operationId);
    if (!inspection?.verified || inspection.saved._sha !== savedSha
        || inspection.dependent || sameTimer(inspection.remote, inspection.active)) {
      throw new TrackerConflictError('The saved time could not be verified or has changed. The queued Start was kept. Recheck GitHub.');
    }
    const { state, queue, operation, active, remote, saved } = inspection;
    await this.assertRecoverySnapshotCurrent(inspection);
    await this.mutateState(latest => {
      assertRecoveryStateUnchanged(latest, state, 'The local queue changed during confirmation. The queued Start was kept.');
      return {
        pendingWrites: queue.filter(item => item !== operation),
        ...(latest.activeCache?.id === active.id ? { activeCache: remote } : {}),
        ...savedRecoveryCache(latest, saved),
      };
    });
    return { confirmed: true };
  }

  async saveQueuedStartAsCompletedTime(operationId, edits) {
    const inspection = await this.inspectQueuedStartRecovery(operationId);
    const context = this.queuedStartRecoveryContext(inspection);
    if (!context?.canComplete) {
      throw new TrackerConflictError(context?.alreadySaved
        ? 'This timer already has a record on GitHub. Close the editor and recheck the conflict to review the saved time.'
        : context?.reason || 'This queued Start is not eligible for completed-time recovery.');
    }
    const { state, queue, operation, active } = inspection;
    const initial = buildEntry({
      active, endedAt: new Date(context.preview.endedAt), now: this.clock(),
      description: active.description || '', billable: isBillable(active),
    });
    const { entry: corrected, now } = await this.correctedOverlapEntry(initial, edits);
    const remote = await this.readRemoteActive();
    if (Boolean(remote) !== Boolean(context.remote)
        || (remote && (sameTimer(remote, active) || remote.id !== context.remote.id
          || remote.startedAt !== context.remote.startedAt))) {
      throw new TrackerConflictError('The running timer on GitHub changed. Recheck before saving. Nothing was changed.');
    }
    if (remote && Date.parse(corrected.endedAt) > Date.parse(remote.startedAt)) {
      throw new TrackerConflictError('The edited time would overlap the running GitHub timer. Nothing was changed.');
    }
    // The inspection already loaded every monthly file and the task index.
    // Revalidate their SHAs instead of downloading the same history again.
    await this.assertRecoverySnapshotCurrent(inspection);
    assertNoCompletedOverlap(corrected, inspection.entries);
    const other = queue.filter(item => item !== operation).flatMap(item => completedWriteFootprint(item) ?? []);
    if (other.some(item => item.id === corrected.id || item.start < Date.parse(corrected.endedAt)
        && item.end > Date.parse(corrected.startedAt))) {
      throw new TrackerConflictError('Other queued work overlaps this completed interval. Nothing was changed.');
    }
    const addition = recoveredAddition(corrected, now, queue.length);
    await this.mutateState(latest => {
      assertRecoveryStateUnchanged(latest, state, 'The local queue changed. The queued Start was preserved.');
      const next = structuredClone(queue), index = next.findIndex(item => item.id === operationId);
      if (index < 0) throw new TrackerConflictError('The pending Start was changed. Nothing was discarded.');
      next.splice(index, 1, addition);
      const pendingEntry = { ...corrected, _path: monthlyRecordsPath(this.user, corrected.entryDate), _pending: true };
      return {
        pendingWrites: next,
        ...(latest.activeCache?.id === active.id ? { activeCache: remote } : {}),
        recentCache: [pendingEntry, ...(latest.recentCache ?? []).filter(item => item.id !== corrected.id)]
          .sort(newestFirst).slice(0, 50),
        dayRangeIntervals: rememberDayRangeIntervals(latest.dayRangeIntervals, [corrected]),
      };
    });
    const remaining = await this.syncPending({ canSync: async () =>
      (await this.store.getState()).pendingWrites.some(item => item.id === addition.id) });
    return { savedLocally: true, resolved: !remaining.some(item => item.id === addition.id) };
  }

  async resolvePendingConflict(id, action = '') {
    validateEntryId(id);
    const state = await this.store.getState();
    const operation = (state.pendingWrites ?? []).find(item => item.id === id);
    if (!operation || operation.status !== 'conflict') throw new Error('Only a pending conflict can be resolved');
    if (operation.operation === 'completeTimerAndStart'
        && ['clearActive', 'startNext'].includes(operation.stage)) {
      if (action && action !== 'recover_next_timer') {
        throw new TrackerConflictError('Select the next timer recovery action.');
      }
      const [savedMonth, taskIndex] = await Promise.all([
        this.readMonthly(operation.monthlyPath), this.readTaskIndex(),
      ]);
      const persisted = savedMonth.entries.find(entry => entry.id === operation.entry?.id);
      if (!persisted || !Object.values(taskIndex.index.tasks).some(task =>
        task.recordIds.includes(operation.entry.id))) {
        throw new TrackerConflictError('The previous completion is not confirmed on GitHub. Your switch remains queued.');
      }
      if (!this.sameEditedCompletion(persisted, operation.entry)) {
        throw new TrackerConflictError('The saved previous time differs from the queued completion. Review it before resuming the next timer.');
      }
      const nextStart = recoveredSwitchStart(operation);
      if (!nextStart || state.activeCache?.id === operation.entry.id
          || state.activeCache?._pending && state.activeCache.id !== nextStart.id) {
        throw new TrackerConflictError('The queued next timer changed locally. No pending work was discarded.');
      }
      await this.mutateState(latest => {
        if (!sameValue(latest.pendingWrites, state.pendingWrites)
            || !sameValue(latest.activeCache, state.activeCache)) {
          throw new TrackerConflictError('The task switch changed locally. No pending work was discarded.');
        }
        const next = structuredClone(state.pendingWrites);
        const at = next.findIndex(item => item.id === id && item.operation === 'completeTimerAndStart');
        if (at < 0 || next.some((item, index) => index !== at && item.operation === 'startTimer'
            && item.id === nextStart.id)) {
          throw new TrackerConflictError('The next timer already has a queued Start.');
        }
        next.splice(at, 1, nextStart);
        return { pendingWrites: next,
          recentCache: (latest.recentCache ?? []).map(entry => entry.id === persisted.id ? persisted : entry) };
      });
      const remaining = await this.syncPending({ canSync: async () =>
        (await this.store.getState()).pendingWrites.some(item => item.id === nextStart.id) });
      const pending = remaining.some(item => item.id === nextStart.id);
      return { resolved: !pending, nextTimerPending: pending };
    }
    if (['add_time_overlap_changed', 'queued_start_remote_active'].includes(operation.conflictReason)
        && operation.stage === 'startNext') {
      if (action === 'align_queued_start') {
        if (operation.operation !== 'startTimer' || !operation.requireNoOverlap || !operation.nextActive) {
          throw new TrackerConflictError('Only an unsaved Add time start can be aligned.');
        }
        const remoteActive = await this.readRemoteActive();
        if (remoteActive) throw new TrackerConflictError('A timer is already running on GitHub. Recheck its state before changing the queued start.');
        const now = this.clock();
        const { files, headSha } = await this.readAddTimeOverlapFiles(operation.nextActive.entryDate, now,
          localDateInTimezone(now, this.timezone));
        const startMs = new Date(operation.nextActive.startedAt).getTime(), nowMs = this.clock().getTime();
        const indexFile = await this.readTaskIndex();
        if (hasSavedCompletion(indexFile, files.flatMap(file => file.entries), operation.nextActive.id)) {
          throw new TrackerConflictError('This timer already has a saved completion on GitHub. Confirm saved time instead.');
        }
        const overlaps = files.flatMap(file => file.entries).filter(entry =>
          new Date(entry.startedAt).getTime() < nowMs && new Date(entry.endedAt).getTime() > startMs);
        if (overlaps.length !== 1 || new Date(overlaps[0].startedAt).getTime() > startMs
            || new Date(overlaps[0].endedAt).getTime() >= nowMs) {
          throw new TrackerConflictError('The queued start cannot safely follow one previous entry. Review Activity; the queued timer remains unchanged.');
        }
        const alignedStart = new Date(overlaps[0].endedAt).toISOString();
        if (localDateInTimezone(alignedStart, operation.nextActive.timezone) !== operation.nextActive.entryDate) {
          throw new TrackerConflictError('The queued start crosses a date boundary. Review Activity; the queued timer remains unchanged.');
        }
        await this.mutateState(latest => {
          const pendingWrites = [...(latest.pendingWrites ?? [])], index = pendingWrites.findIndex(item => item.id === id);
          const current = pendingWrites[index];
          if (index !== pendingWrites.length - 1 || current?.status !== 'conflict'
              || current.conflictReason !== 'add_time_overlap_changed' || current.stage !== 'startNext'
              || current.nextActive?.startedAt !== operation.nextActive.startedAt
              || latest.activeCache?.id !== current.nextActive.id
              || latest.activeCache?.startedAt !== current.nextActive.startedAt) {
            throw new TrackerConflictError('The queued timer changed before it could be aligned. Reload and review it.');
          }
          const nextActive = { ...current.nextActive, startedAt: alignedStart, createdAt: alignedStart,
            updatedAt: this.clock().toISOString() };
          validateActiveTimer(nextActive);
          pendingWrites[index] = { ...current, nextActive, alignmentRequiresEmptyRemote: true,
            overlapGuards: files.map(file => ({ path: file.path, sha: file.sha })),
            overlapHeadSha: headSha, status: 'pending', lastError: '', conflictReason: '', conflictWith: null };
          return { pendingWrites, activeCache: { ...latest.activeCache, ...nextActive, _pending: true } };
        });
        const remaining = await this.syncPending();
        return { resolved: !remaining.some(item => item.id === id) };
      }
      if (action === 'discard_queued_start') {
        const inspection = await this.inspectQueuedStartRecovery(id);
        if (!inspection) throw new TrackerConflictError('The queued Start changed. Nothing was discarded.');
        const { state: reviewedState, queue, operation: reviewed, active, remote } = inspection;
        if (sameTimer(remote, active)) {
          throw new TrackerConflictError('This timer is already running on GitHub. Recheck and retry to adopt it instead of discarding.', 'queued_start_already_running');
        }
        if (inspection.alreadySaved) {
          throw new TrackerConflictError('This timer already has a record on GitHub. Review the saved time instead.');
        }
        if (inspection.dependent) {
          throw new TrackerConflictError('Another queued change depends on this Start. Nothing was discarded.');
        }
        await this.assertRecoverySnapshotCurrent(inspection);
        await this.mutateState(latest => {
          assertRecoveryStateUnchanged(latest, reviewedState, 'The local queue changed before discard. Nothing was discarded.');
          return { pendingWrites: queue.filter(item => item !== reviewed),
            ...(sameTimer(latest.activeCache, active) ? { activeCache: remote } : {}) };
        });
        return { resolved: true, discarded: true };
      }
      if (operation.requireNoOverlap) {
        const index = await this.readTaskIndex();
        if (Object.values(index.index.tasks).some(task => task.recordIds.includes(operation.nextActive.id))) {
          throw new TrackerConflictError('This timer already has a saved completion on GitHub. Confirm saved time instead.');
        }
      }
      const remoteActive = await this.readRemoteActive();
      if (remoteActive && operation.alignmentRequiresEmptyRemote
          && (!sameTimer(remoteActive, operation.nextActive)
            || remoteActive.startedAt !== operation.nextActive.startedAt)) {
        throw new TrackerConflictError('Another timer is running on GitHub. The aligned local start remains queued.', 'add_time_overlap_changed');
      }
      if (remoteActive && sameTimer(remoteActive, operation.nextActive)) {
        await this.persistQueueOperation(operation, { remove: true, patch: { activeCache: remoteActive } });
        return { resolved: true, alreadyRunning: true };
      }
      const { files, headSha } = operation.requireNoOverlap
        ? await this.readAddTimeOverlapFiles(operation.nextActive.entryDate, this.clock(),
          localDateInTimezone(this.clock(), this.timezone))
        : { files: await Promise.all(operation.overlapGuards.map(guard => this.readMonthly(guard.path))), headSha: null };
      const startMs = new Date(operation.nextActive.startedAt).getTime(), nowMs = this.clock().getTime();
      if (files.some(file => file.entries.some(entry => new Date(entry.startedAt).getTime() < nowMs
          && new Date(entry.endedAt).getTime() > startMs))) {
        throw new TrackerConflictError('Added time would overlap existing time. Review Activity or discard the queued start.', 'add_time_overlap_changed');
      }
      await this.mutateState(latest => {
        const pendingWrites = [...(latest.pendingWrites ?? [])], index = pendingWrites.findIndex(item => item.id === id);
        if (index < 0 || pendingWrites[index].status !== 'conflict') throw new Error('The pending conflict changed before it was resolved.');
        pendingWrites[index] = { ...pendingWrites[index], overlapGuards: files.map(file => ({ path: file.path, sha: file.sha })),
          overlapHeadSha: headSha,
          status: 'pending', lastError: '', conflictReason: '' };
        return { pendingWrites };
      });
      const remaining = await this.syncPending();
      return { resolved: !remaining.some(item => item.id === id) };
    }
    if (['addTime', 'bulkAddTimes'].includes(operation.operation)) {
      if (action === 'discard_queued_addition') {
        const entries = operation.operation === 'addTime' ? [operation.entry] : operation.entries ?? [];
        const ids = new Set(entries.map(entry => entry.id));
        const at = state.pendingWrites.findIndex(item => item.id === id);
        const later = state.pendingWrites.slice(at + 1);
        if (later.some(item => [...ids].some(entryId => operationEditsEntry(item, entryId)
            || (item.operation === 'deleteEntry' && item.request?.original?.id === entryId)))) {
          throw new TrackerConflictError('Discard later edits or deletes of this added time before discarding the addition.');
        }
        // A lost HTTP acknowledgement does not mean GitHub failed to commit.
        // Refuse destructive local discard until both GitHub stores confirm that
        // none of these identities was persisted.
        const taskIndex = await this.readTaskIndex();
        if (Object.values(taskIndex.index.tasks).some(task => task.recordIds.some(savedId => ids.has(savedId)))) {
          throw new TrackerConflictError('Some added time is already on GitHub. Reload Activity before discarding.');
        }
        const paths = [...new Set(entries.map(entry => monthlyRecordsPath(this.user, entry.entryDate)))];
        const files = await Promise.all(paths.map(path => this.readMonthly(path)));
        if (files.some(file => file.entries.some(entry => ids.has(entry.id)))) {
          throw new TrackerConflictError('Some added time is already on GitHub. Reload Activity before discarding.');
        }
        await this.mutateState(latest => {
          const pendingWrites = [...(latest.pendingWrites ?? [])], index = pendingWrites.findIndex(item => item.id === id);
          if (index < 0 || pendingWrites[index].status !== 'conflict') throw new Error('The pending conflict changed before it was resolved.');
          pendingWrites.splice(index, 1);
          return { pendingWrites, recentCache: (latest.recentCache ?? []).filter(entry => !ids.has(entry.id)),
            dayRangeIntervals: updateDayRangeIntervals(latest.dayRangeIntervals, [], ids) };
        });
        return { resolved: true, discarded: true };
      }
      await this.mutateState(latest => {
        const pendingWrites = [...(latest.pendingWrites ?? [])], index = pendingWrites.findIndex(item => item.id === id);
        if (index < 0 || pendingWrites[index].status !== 'conflict') throw new Error('The pending conflict changed before it was resolved.');
        pendingWrites[index] = { ...pendingWrites[index], status: 'pending', conflictReason: '', lastError: '' };
        return { pendingWrites };
      });
      const remaining = await this.syncPending();
      return { resolved: !remaining.some(item => item.id === id) };
    }
    if (['editEntry', 'editEntries', 'deleteEntry'].includes(operation.operation)) {
      if (action === 'discard_queued_edit') {
        if (operation.operation === 'deleteEntry') {
          // Cancelling a queued deletion cannot restore a record already removed
          // on GitHub. Verify both stores before removing the local request.
          const [monthly, index] = await Promise.all([
            this.readMonthly(operation.request.path), this.readTaskIndex(),
          ]);
          const recordId = operation.request.original?.id;
          if (!recordId || !monthly.entries.some(entry => entry.id === recordId)
              || !Object.values(index.index.tasks).some(task => task.recordIds.includes(recordId))) {
            throw new TrackerConflictError('This deletion may already have been saved on GitHub. It cannot be cancelled safely.');
          }
        }
        await this.mutateState(latest => {
          const pendingWrites = [...(latest.pendingWrites ?? [])], index = pendingWrites.findIndex(item => item.id === id);
          if (index < 0 || pendingWrites[index].status !== 'conflict') throw new Error('The pending conflict changed before it was resolved.');
          const discarded = pendingWrites[index];
          pendingWrites.splice(index, 1);
          const originals = discarded.operation === 'editEntries'
            ? discarded.request?.entries?.map(request => request.original) ?? []
            : [discarded.request?.original].filter(Boolean);
          const known = new Map((latest.dayRangeIntervals ?? []).map(entry => [entry.id, entry]));
          const restored = originals.filter(entry => known.has(entry.id));
          const updated = updateDayRangeIntervals(latest.dayRangeIntervals, restored);
          const history = discarded.operation === 'deleteEntry' && discarded.wasInDayRangeIndex
            ? rememberDayRangeIntervals(updated, originals) : updated;
          return { pendingWrites, dayRangeIntervals: history };
        });
        return { resolved: true, discarded: true };
      }
      if (operation.strictOriginal) {
        const source = await this.readMonthly(operation.request.path);
        if (source.sha !== operation.request.originalSha
            && !(await this.alreadyAppliedEntryEdits([operation.request]))) {
          throw new TrackerConflictError('This overlap resolution cannot rebase over changed GitHub data. Review the saved edit before retrying.');
        }
        await this.mutateState(latest => {
          const pendingWrites = [...(latest.pendingWrites ?? [])], index = pendingWrites.findIndex(item => item.id === id);
          if (index < 0 || pendingWrites[index].status !== 'conflict') throw new Error('The pending conflict changed before it was resolved.');
          pendingWrites[index] = { ...pendingWrites[index], status: 'pending', conflictReason: '', lastError: '' };
          return { pendingWrites };
        });
        const remaining = await this.syncPending();
        return { resolved: !remaining.some(item => item.id === id) };
      }
      await this.rebaseQueuedEntryEdit(operation);
      await this.mutateState(latest => {
        const pendingWrites = [...(latest.pendingWrites ?? [])], index = pendingWrites.findIndex(item => item.id === id);
        if (index < 0 || pendingWrites[index].status !== 'conflict') throw new Error('The pending conflict changed before it was resolved.');
        const current = pendingWrites[index];
        current.request = operation.request;
        current.status = 'pending'; current.lastError = ''; current.conflictReason = '';
        return { pendingWrites };
      });
      const remaining = await this.syncPending();
      return { resolved: !remaining.some(item => item.id === id) };
    }
    if (operation.stage === 'clearActive' || operation.stage === 'verifyActive') {
      const active = await this.readRemoteActive();
      const changed = Boolean(active && !sameTimer(active, operation.activeSnapshot));
      if (operation.stage === 'verifyActive' && (!active || changed)) {
        const file = await this.readMonthly(operation.monthlyPath);
        const matches = file.entries.filter(entry => sameTimer(entry, operation.entry));
        if (matches.length > 1) throw new TrackerConflictError('Multiple completed entries match the timer that disappeared during verification. Reload before continuing.');
        if (matches.length === 1) {
          await this.mutateState(latest => {
            const pendingWrites = [...(latest.pendingWrites ?? [])], index = pendingWrites.findIndex(item => item.id === id);
            if (index < 0 || pendingWrites[index].status !== 'conflict') throw new Error('The pending conflict changed before it was resolved.');
            pendingWrites[index] = { ...pendingWrites[index], entry: matches[0], stage: 'clearActive', status: 'pending', lastError: '', conflictReason: '' };
            return { pendingWrites, ...(index === pendingWrites.length - 1 ? { activeCache: active } : {}) };
          });
          const remaining = await this.syncPending();
          return { resolved: !remaining.some(item => item.id === id) };
        }
      }
      const canAcknowledge = !active || changed;
      if (canAcknowledge) {
        if (operation.stage === 'verifyActive' && action !== 'discard_unsaved_completion') {
          throw new Error('An explicit discard action is required because this completion was not saved.');
        }
        await this.mutateState(latest => {
          const pendingWrites = [...(latest.pendingWrites ?? [])], index = pendingWrites.findIndex(item => item.id === id);
          if (index < 0 || pendingWrites[index].status !== 'conflict') throw new Error('The pending conflict changed before it was resolved.');
          const current = pendingWrites[index], retained = (latest.recentCache ?? []).filter(item => !(item._pending && sameTimer(item, current.activeSnapshot)));
          const recentCache = (current.stage === 'clearActive'
            ? [current.entry, ...retained.filter(item => !sameCompletion(item, current))]
            : retained).sort(newestFirst).slice(0, 50);
          pendingWrites.splice(index, 1);
          return { pendingWrites, recentCache, ...(index === pendingWrites.length ? { activeCache: active } : {}) };
        });
        return { resolved: true };
      }
    }
    await this.mutateState(latest => {
      const pendingWrites = [...(latest.pendingWrites ?? [])], index = pendingWrites.findIndex(item => item.id === id);
      if (index < 0 || pendingWrites[index].status !== 'conflict') throw new Error('The pending conflict changed before it was resolved.');
      pendingWrites[index] = { ...pendingWrites[index], status: 'pending', lastError: '' };
      return { pendingWrites };
    });
    const remaining = await this.syncPending();
    return { resolved: !remaining.some(item => item.id === id) };
  }

  async backfillIssueTitles(files, knownTitles = new Map()) {
    const untitled = files.flatMap(file => file.entries).filter(entry => !taskTitleOf(entry))
      .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime());
    if (!untitled.length) return files;
    const titles = new Map();
    for (const entry of untitled) {
      const url = taskUrlOf(entry), known = normalizePlainTitle(knownTitles.get(url));
      if (known) titles.set(url, known);
    }
    const unresolved = [...new Map(untitled.flatMap(entry => {
      const url = taskUrlOf(entry), issue = entry.issue ?? parseGitHubTaskUrl(url);
      return !titles.has(url) && issue ? [[url, issue]] : [];
    })).values()].slice(0, 100);
    if (unresolved.length && typeof this.github.getTaskMetadata === 'function') {
      try {
        const metadata = await this.github.getTaskMetadata(unresolved, { batchSize: 50, maxRequests: 2 });
        for (const [url, details] of metadata) {
          const title = normalizePlainTitle(details?.title);
          if (title) titles.set(url, title);
        }
      } catch (error) {
        if (!['authentication', 'permission', 'not_found', 'rate_limit'].includes(error?.code)) throw error;
      }
    }
    if (!titles.size) return files;
    const touched = files.filter(file => file.entries.some(entry => !taskTitleOf(entry) && titles.has(taskUrlOf(entry)))).map(file => ({
      ...file,
      entries: file.entries.map(entry => !taskTitleOf(entry) && titles.has(taskUrlOf(entry))
        ? { ...entry, taskTitle: titles.get(taskUrlOf(entry)), issueTitle: titles.get(taskUrlOf(entry)) } : entry),
    }));
    if (!touched.length) return files;
    try {
      const changed = files.flatMap(file => file.entries.filter(entry => !taskTitleOf(entry) && titles.has(taskUrlOf(entry))));
      const changedIds = new Set(changed.map(entry => entry.id));
      const updated = touched.flatMap(file => file.entries.filter(entry => changedIds.has(entry.id)));
      const changes = touched.map(file => ({ path: file.path, sha: file.sha, text: serializeMonthlyRecords(file.entries) }));
      const { blobShas } = await this.updateCompletedRecords(changes, `time: add missing titles ${this.user}`, {
        remove: changed, add: updated,
      });
      const saved = new Map(touched.map(file => [file.path, {
        ...file,
        sha: blobShas[file.path],
        entries: parseMonthlyRecords(serializeMonthlyRecords(file.entries), { user: this.user, month: file.month, path: file.path, sha: blobShas[file.path] }),
      }]));
      return files.map(file => saved.get(file.path) ?? file);
    } catch (error) {
      if (isConflict(error)) throw new TrackerConflictError('A monthly time file changed while missing task titles were being saved. Reload.');
      throw error;
    }
  }

  async backfillActiveIssueTitle(active, knownTitles = new Map()) {
    if (!active || taskTitleOf(active) || !knownTitles.has(taskUrlOf(active))) return active;
    const state = await this.store.getState();
    if ((state.pendingWrites ?? []).some(operation => sameTimer(operation.activeSnapshot, active))) return active;
    const taskTitle = normalizePlainTitle(knownTitles.get(taskUrlOf(active)));
    if (!taskTitle) return active;
    const path = activeRecordPath(this.user);
    try {
      const file = await this.github.getText(path), remote = parseActiveRecord(file.text, { user: this.user, path, sha: file.sha });
      if (!sameTimer(remote, active)) throw new TrackerConflictError('The active timer changed while its missing task title was being saved. Reload.');
      if (taskTitleOf(remote)) return remote;
      const titled = { ...remote, taskTitle, issueTitle: taskTitle };
      const result = await this.github.putText(path, serializeActiveRecord(titled), `timer: add missing title ${this.user}`, file.sha);
      const saved = parseActiveRecord(serializeActiveRecord(titled), { user: this.user, path, sha: result.sha });
      await this.store.patchState({ activeCache: saved });
      return saved;
    } catch (error) {
      if (isConflict(error)) throw new TrackerConflictError('The active timer changed while its missing task title was being saved. Reload.');
      throw error;
    }
  }

  async cachedMenuData(limit = 50, now = this.clock()) {
    const state = await this.store.getState();
    const recent = (state.recentCache ?? []).slice(0, limit);
    const summary = summaryProjection(state, now);
    return {
      configured: true,
      recent,
      summaries: [],
      reportDate: localReportDate(now),
      active: state.activeCache,
      pendingWrites: state.pendingWrites ?? [],
      pendingCount: state.pendingWrites?.length ?? 0,
      ...summary,
    };
  }

  async loadMenuData(limit = 50, { knownTitles = new Map() } = {}) {
    const now = this.clock(), dateFor = offset => localReportDate(now, offset);
    const today = dateFor(0), mondayOffset = (now.getDay() + 6) % 7;
    const thisWeekStart = dateFor(-mondayOffset), lastWeekStart = dateFor(-mondayOffset - 7), lastWeekEnd = dateFor(-mondayOffset - 1);
    const thisMonthStart = `${today.slice(0, 7)}-01`;
    const summaryRanges = [
      { key: 'today', label: 'Today', startDate: today, endDate: today, displayMs: 2000 },
      { key: 'this-week', label: 'This week', startDate: thisWeekStart, endDate: today, displayMs: 1000 },
      { key: 'last-week', label: 'Last week', startDate: lastWeekStart, endDate: lastWeekEnd, displayMs: 1000 },
      { key: 'this-month', label: 'This month', startDate: thisMonthStart, endDate: today, displayMs: 1000 },
    ];
    const dates = Array.from({ length: this.recentDays }, (_, offset) => dateFor(-offset));
    const dateSet = new Set(dates), earliest = [lastWeekStart, thisMonthStart, dates.at(-1)].sort()[0];
    const months = [];
    for (let cursor = new Date(`${earliest.slice(0, 7)}-01T12:00:00`), end = new Date(`${today.slice(0, 7)}-01T12:00:00`); cursor <= end; cursor.setMonth(cursor.getMonth() + 1)) {
      months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
    }
    const initial = await this.store.getState();
    // Keep the local projection available if the GitHub read fails, while
    // retaining remote reads for complete summary totals and queue rebasing.
    let missingReachability = null;
    let files;
    try {
      files = await Promise.all(months.map(async month => {
      const path = monthlyRecordsPath(this.user, `${month}-01`);
      try {
        const file = await this.github.getText(path);
        return { path, month, sha: file.sha, entries: parseMonthlyRecords(file.text, { user: this.user, month, path, sha: file.sha }) };
      } catch (error) {
        if (!isNotFound(error)) throw error;
        missingReachability ||= this.confirmFileMissing(error);
        await missingReachability;
        return { path, month, sha: null, entries: [] };
      }
      }));
    } catch (error) {
      if (initial.pendingWrites?.length || initial.recentCache?.length) return this.cachedMenuData(limit, now);
      throw error;
    }
    files = await this.backfillIssueTitles(files, knownTitles);
    const remoteEntries = files.flatMap(file => file.entries).filter(entry => startDate(entry) >= earliest && startDate(entry) <= today);
    const initialState = await this.store.getState();
    // The remote request was started against an older local generation. Do not
    // overwrite local edits that were accepted or completed while it ran.
    if (JSON.stringify([initial.activeCache, initial.recentCache, initial.pendingWrites, initial.summaryCache])
        !== JSON.stringify([initialState.activeCache, initialState.recentCache, initialState.pendingWrites, initialState.summaryCache])) {
      return this.cachedMenuData(limit, now);
    }
    await this.backfillActiveIssueTitle(initialState.activeCache, knownTitles);
    const summaryCache = {
      reportDate: today,
      weekEntries: remoteEntries.filter(entry => startDate(entry) >= thisWeekStart),
      computedAt: now.getTime(),
      ...(initialState.summaryCache?.silentPull ? { silentPull: initialState.summaryCache.silentPull } : {}),
    };
    // Apply the queue inside the storage transaction so a concurrent acceptance cannot be overwritten.
    let staleResponse = false;
    await this.mutateState(state => {
      if (JSON.stringify([state.activeCache, state.recentCache, state.pendingWrites, state.summaryCache])
          !== JSON.stringify([initialState.activeCache, initialState.recentCache, initialState.pendingWrites, initialState.summaryCache])) {
        staleResponse = true;
        return null;
      }
      return {
        recentCache: overlayPendingEntries(remoteEntries, state.pendingWrites ?? [])
          .filter(entry => dateSet.has(startDate(entry))).sort(newestFirst).slice(0, limit),
        summaryCache,
      };
    });
    if (staleResponse) {
      // A timer may have been accepted during this read. Retain its local
      // interval and queue, but populate missing totals from the completed
      // records we already fetched, overlaying the newer queued mutation.
      await this.mutateState(state => state.summaryCache ? null : { summaryCache });
      return this.cachedMenuData(limit, now);
    }
    const state = await this.store.getState(), pendingWrites = state.pendingWrites ?? [], activeCache = state.activeCache;
    const allEntries = overlayPendingEntries([...remoteEntries, ...(state.recentCache ?? [])], pendingWrites);
    const recent = state.recentCache ?? [];
    const summaries = summaryRanges.map(range => ({ ...range, seconds: allEntries
      .filter(entry => startDate(entry) >= range.startDate && startDate(entry) <= range.endDate)
      .reduce((sum, entry) => sum + Math.max(0, Number(entry.durationSeconds) || 0), 0) }));
    const recovery = recoveryProjection({ active: activeCache, recent: allEntries, pendingWrites });
    const active = activeCache ? {
      id: activeCache.id, taskUrl: taskUrlOf(activeCache), taskTitle: taskTitleOf(activeCache), ...(activeCache.issue ? { issue: activeCache.issue } : {}), startedAt: activeCache.startedAt,
      description: activeCache.description || '', issueTitle: taskTitleOf(activeCache),
      entryDate: activeCache.entryDate, timezone: activeCache.timezone,
    } : null;
    return {
      recent, summaries, todaySeconds: summaries[0].seconds, reportDate: today, active,
      ...recovery,
      ...summaryProjection(state, this.clock()),
    };
  }

  async loadRecent(limit = 50) { return (await this.loadMenuData(limit)).recent; }

  // This is deliberately separate from loadMenuData(): the one-minute background
  // pull must never set UI loading state or perform remote writes.
  async pullRemoteSilently({ signal, maxBytes = 8 * 1024 * 1024 } = {}) {
    const initial = await this.store.getState();
    // A pending local mutation is authoritative. Recheck GitHub after it is
    // committed or explicitly resolved, rather than overwriting its projection.
    if (initial.pendingWrites?.length) return false;

    const now = this.clock(), today = localReportDate(now);
    const mondayOffset = (now.getDay() + 6) % 7;
    const lastWeekStart = localReportDate(now, -mondayOffset - 7);
    const thisWeekStart = localReportDate(now, -mondayOffset);
    const earliest = [lastWeekStart, `${today.slice(0, 7)}-01`, localReportDate(now, 1 - this.recentDays)].sort()[0];
    const days = new Set(Array.from({ length: this.recentDays }, (_, offset) => localReportDate(now, -offset)));
    const activePath = activeRecordPath(this.user);
    const repoKey = this.github.repositoryKey;
    const previous = initial.summaryCache?.silentPull;
    const etag = previous?.key === repoKey && previous.day === today ? previous.etag : '';
    const snapshot = await this.github.listTextFilesSnapshot('times/', { etag, signal, includeActive: activePath });
    if (snapshot.notModified) return false;

    const available = new Map((snapshot.files ?? []).map(file => [file.path, file]));
    const monthlyPaths = monthsInRange(earliest, today).map(month => monthlyRecordsPath(this.user, `${month}-01`));
    const needed = [...monthlyPaths, activePath].map(path => available.get(path)).filter(Boolean);
    if (needed.some(file => !Number.isSafeInteger(file.size) || file.size > maxBytes)
        || needed.reduce((sum, file) => sum + file.size, 0) > maxBytes) return false;

    // Immutable Git blobs keep every file in this read pinned to one branch
    // snapshot, even if another browser pushes in the middle of the pull.
    const fetched = await Promise.all(needed.map(file => this.github.getBlobText(file.path, file.sha, { signal })));
    if (fetched.reduce((sum, file) => sum + new TextEncoder().encode(file.text).byteLength, 0) > maxBytes) return false;
    const contents = new Map(fetched.map(file => [file.path, file]));
    const remoteEntries = monthlyPaths.flatMap(path => {
      const file = contents.get(path);
      if (!file) return [];
      return parseMonthlyRecords(file.text, { user: this.user, month: monthFromPath(path, this.user), path, sha: file.sha });
    });
    const activeFile = contents.get(activePath);
    const remoteActive = activeFile
      ? parseActiveRecord(activeFile.text, { user: this.user, path: activePath, sha: activeFile.sha })
      : null;
    if (remoteActive) validateActiveTimer(remoteActive);

    // An IndexedDB transaction serializes this comparison with local accepts
    // and queue completions. If anything changed during network I/O, defer
    // the pull rather than applying an older snapshot over newer local work.
    const trackingKey = state => JSON.stringify([
      state.activeCache, state.recentCache, state.summaryCache, state.pendingWrites,
    ]);
    const expected = trackingKey(initial);
    let applied = false;
    await this.mutateState(state => {
      if (state.pendingWrites?.length || trackingKey(state) !== expected) return null;
      applied = true;
      return {
        activeCache: remoteActive,
        recentCache: remoteEntries.filter(entry => days.has(startDate(entry))).sort(newestFirst).slice(0, 50),
        summaryCache: {
          reportDate: today,
          weekEntries: remoteEntries.filter(entry => startDate(entry) >= thisWeekStart),
          computedAt: now.getTime(),
          silentPull: { key: repoKey, day: today, etag: snapshot.etag || '' },
        },
      };
    });
    return applied;
  }

  async historicalQueueEntries(requests) {
    const state = await this.store.getState();
    const isLocallyAdded = request => (state.pendingWrites ?? []).some(operation => {
      const accepted = operation.operation === 'addTime' ? [operation.entry]
        : operation.operation === 'bulkAddTimes' ? operation.entries ?? [] : [];
      return accepted.some(entry => entry?.id === request.original?.id
        && monthlyRecordsPath(this.user, entry.entryDate) === request.path);
    });
    const missing = requests.filter(request => !(state.recentCache ?? []).some(entry =>
      entry._path === request.path && entry.id === request.original?.id) && !isLocallyAdded(request));
    const files = new Map();
    for (const request of missing) {
      validateEntryId(request.original?.id);
      monthFromPath(request.path, this.user);
      const key = `${request.path}\u0000${request.originalSha || ''}`;
      if (!files.has(key)) files.set(key,
        await this.reports?.cachedMonthly(request.path, request.originalSha) ?? await this.readMonthly(request.path));
    }
    return new Map(missing.map(request => {
      const file = files.get(`${request.path}\u0000${request.originalSha || ''}`);
      const position = locateEntry(file.entries, request.index, request.original);
      return [`${request.path}\u0000${request.original.id}`, position < 0 ? null : file.entries[position]];
    }));
  }

  queuedEntry(state, request, historical) {
    const cached = (state.recentCache ?? []).find(entry => entry.id === request.original?.id && entry._path === request.path);
    if (cached) {
      const hasEarlierEdit = (state.pendingWrites ?? []).some(operation => operationEditsEntry(operation, cached.id));
      if (!hasEarlierEdit && cached._path !== monthlyRecordsPath(this.user, cached.entryDate)) {
        throw new TrackerConflictError('This entry points to a different monthly file. Reload Activity before editing.', 'queued_entry_path_mismatch');
      }
      return cached;
    }
    const hasLocalAddition = (state.pendingWrites ?? []).some(operation => {
      const added = operation.operation === 'addTime' ? [operation.entry]
        : operation.operation === 'bulkAddTimes' ? operation.entries ?? [] : [];
      return added.some(entry => entry?.id === request.original?.id
        && monthlyRecordsPath(this.user, entry.entryDate) === request.path);
    });
    if (hasLocalAddition) {
      return overlayPendingEntries([], state.pendingWrites ?? []).find(entry =>
        entry.id === request.original?.id && entry._path === request.path) ?? null;
    }
    const key = `${request.path}\u0000${request.original?.id}`;
    const remote = historical.get(key);
    if (!remote) return null;
    const relevant = (state.pendingWrites ?? []).filter(operation => {
      const type = operation.operation ?? operation.stage;
      if (type === 'editEntry' || type === 'deleteEntry') return operation.request?.path === request.path && operation.request?.original?.id === remote.id;
      return type === 'editEntries' && operation.request?.entries?.some(item => item.path === request.path && item.original?.id === remote.id);
    });
    if (relevant.some(operation => (operation.operation ?? operation.stage) === 'deleteEntry')) return null;
    return overlayPendingEntries([remote], relevant).find(entry => entry.id === remote.id && entry._path === request.path) ?? null;
  }

  async queueEntryEdit({ path, originalSha, index, original, edits }) {
    const queuedAt = this.clock();
    const historical = await this.historicalQueueEntries([{ path, originalSha, index, original }]);
    const before = await this.store.getState();
    const candidate = this.queuedEntry(before, { path, original }, historical);
    if (!candidate) throw new TrackerConflictError('This time entry is no longer available locally. Reload before editing.');
    const requestedTask = edits?.taskUrl ?? edits?.issue;
    if (requestedTask !== undefined) {
      const identity = normalizeStoredTaskIdentity(requestedTask);
      if (!/^https?:\/\//.test(identity) && identity !== candidate.taskUrl) await this.assertKnownImportedTask(identity);
    }
    const proposed = applyEntryEdits(candidate, edits, editClock(this.clock, candidate));
    const changedTime = proposed.startedAt !== candidate.startedAt || proposed.endedAt !== candidate.endedAt;
    const remoteActive = changedTime ? await this.readRemoteActive() : null;
    const overlapFiles = changedTime ? await this.readEditOverlapFiles([proposed], { path, sha: candidate._sha }) : null;
    if (overlapFiles && candidate._sha && overlapFiles.files.find(file => file.path === path)?.sha !== candidate._sha) {
      throw new TrackerConflictError('This monthly time file changed after you opened it. Reload before saving.');
    }
    return this.mutateState(state => {
      const cached = this.queuedEntry(state, { path, original }, historical);
      if (!cached) throw new TrackerConflictError('This time entry is no longer available locally. Reload before editing.');
      const updated = applyEntryEdits(cached, edits, editClock(this.clock, cached));
      if (updated.startedAt !== cached.startedAt || updated.endedAt !== cached.endedAt) {
        assertNoActiveOverlap([updated], state.activeCache);
        assertNoActiveOverlap([updated], remoteActive);
        if (!overlapFiles || updated.startedAt !== proposed.startedAt || updated.endedAt !== proposed.endedAt) {
          throw new TrackerConflictError('The time entry changed while checking its destination. Reload and try again.');
        }
        assertNoCompletedOverlap(updated, overlayPendingEntries([
          ...(state.recentCache ?? []), ...overlapFiles.files.flatMap(file => file.entries),
        ], state.pendingWrites ?? []));
      }
      const pendingWrites = [...(state.pendingWrites ?? [])];
      const existing = trailingSupersedable(pendingWrites, operation => operation.operation === 'editEntry'
        && operation.request?.path === path && operation.request?.original?.id === original.id);
      const request = existing?.request ?? { path, originalSha: cached._sha, index: cached._index, original: stripInternal(cached), edits: {} };
      request.edits = { ...request.edits, ...edits };
      const operation = existing ?? {
        operation: 'editEntry', id: createUlid(queuedAt.getTime() + pendingWrites.length), status: 'pending', retryCount: 0,
        stage: 'editEntry', request, queuedAt: queuedAt.toISOString(), lastError: '',
      };
      operation.lastLocalEditAt = queuedAt.toISOString();
      if (existing) Object.assign(existing, operation); else pendingWrites.push(operation);
      const recentCache = (state.recentCache ?? []).map(entry => entry.id === original.id && entry._path === path
        ? { ...updated, _path: entry._path, _sha: entry._sha, _index: entry._index, _pending: true } : entry);
      return { pendingWrites, recentCache,
        dayRangeIntervals: updateDayRangeIntervals(state.dayRangeIntervals, [updated]) };
    }).then(state => ({
      operationId: trailingSupersedable(state.pendingWrites ?? [], operation => operation.operation === 'editEntry'
        && operation.request?.path === path && operation.request?.original?.id === original.id)?.id,
      pending: true,
    }));
  }

  async queueEntryDelete({ path, originalSha, index, original }) {
    const queuedAt = this.clock();
    const historical = await this.historicalQueueEntries([{ path, originalSha, index, original }]);
    return this.mutateState(state => {
      const cached = this.queuedEntry(state, { path, original }, historical);
      if (!cached) throw new TrackerConflictError('This time entry is no longer available locally. Reload before deleting.');
      const pendingWrites = [...(state.pendingWrites ?? [])];
      const operation = {
        operation: 'deleteEntry', id: createUlid(queuedAt.getTime() + pendingWrites.length), status: 'pending', retryCount: 0,
        stage: 'deleteEntry', wasInDayRangeIndex: (state.dayRangeIntervals ?? []).some(entry => entry.id === cached.id),
        request: { path, originalSha: cached._sha, index: cached._index, original: stripInternal(cached) },
        queuedAt: queuedAt.toISOString(), lastError: '',
      };
      pendingWrites.push(operation);
      const recentCache = (state.recentCache ?? []).filter(entry => !(entry.id === cached.id && entry._path === path));
      return { pendingWrites, recentCache,
        dayRangeIntervals: updateDayRangeIntervals(state.dayRangeIntervals, [], [cached.id]) };
    }).then(state => {
      const operation = state.pendingWrites.at(-1);
      return { operationId: operation?.operation === 'deleteEntry' ? operation.id : null, pending: true };
    });
  }

  async queueEntriesEdit({ entries }) {
    const queuedAt = this.clock();
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 50) throw new Error('One to fifty linked time entries are required');
    const historical = await this.historicalQueueEntries(entries);
    const before = await this.store.getState();
    const candidates = entries.map(request => this.queuedEntry(before, request, historical));
    if (candidates.some(item => !item)) throw new TrackerConflictError('A linked time entry is no longer available locally. Reload before editing.');
    for (const [index, request] of entries.entries()) {
      const requested = request.edits?.taskUrl ?? request.edits?.issue;
      if (requested === undefined || requested === candidates[index].taskUrl) continue;
      const identity = normalizeStoredTaskIdentity(requested);
      if (!/^https?:\/\//.test(identity)) await this.assertKnownImportedTask(identity);
    }
    const proposed = entries.map((request, index) => applyEntryEdits(candidates[index], request.edits, editClock(this.clock, candidates[index])));
    const changed = proposed.filter((item, index) => item.startedAt !== candidates[index].startedAt || item.endedAt !== candidates[index].endedAt);
    const remoteActive = changed.length ? await this.readRemoteActive() : null;
    const overlapFiles = changed.length ? await this.readEditOverlapFiles(changed,
      entries.map((request, index) => ({ path: request.path, sha: candidates[index]._sha }))) : null;
    if (overlapFiles && entries.some((request, index) => candidates[index]._sha
      && overlapFiles.files.find(file => file.path === request.path)?.sha !== candidates[index]._sha)) {
      throw new TrackerConflictError('A monthly time file changed after the panel loaded. Reload before saving.');
    }
    return this.mutateState(state => {
      const cachedByIdentity = new Map(entries.map(request => [
        `${request?.path}\u0000${request?.original?.id}`, this.queuedEntry(state, request, historical),
      ]));
      const requestEntries = entries.map(request => {
        const cached = cachedByIdentity.get(`${request?.path}\u0000${request?.original?.id}`);
        if (!cached) throw new TrackerConflictError('A linked time entry is no longer available locally. Reload before editing.');
        return { ...request, originalSha: cached._sha, index: cached._index, original: stripInternal(cached) };
      });
      const identities = new Set(requestEntries.map(request => `${request.path}\u0000${request.original.id}`));
      if (identities.size !== requestEntries.length) throw new Error('Linked time entries must be distinct');
      const updatedByIdentity = new Map(requestEntries.map(request => {
        const cached = cachedByIdentity.get(`${request.path}\u0000${request.original.id}`);
        return [`${request.path}\u0000${request.original.id}`, applyEntryEdits(cached, request.edits, editClock(this.clock, cached))];
      }));
      const changedTimes = requestEntries.flatMap(request => {
        const key = `${request.path}\u0000${request.original.id}`, cached = cachedByIdentity.get(key), updated = updatedByIdentity.get(key);
        return updated.startedAt !== cached.startedAt || updated.endedAt !== cached.endedAt ? [updated] : [];
      });
      assertNoActiveOverlap(changedTimes, state.activeCache);
      assertNoActiveOverlap(changedTimes, remoteActive);
      if (changedTimes.length) {
        if (!overlapFiles || changedTimes.length !== changed.length || changedTimes.some((item, index) =>
          item.id !== changed[index].id || item.startedAt !== changed[index].startedAt || item.endedAt !== changed[index].endedAt)) {
          throw new TrackerConflictError('A linked time entry changed while checking its destination. Reload and try again.');
        }
        const updated = [...updatedByIdentity.values()];
        const ids = new Set(updated.map(item => item.id));
        const others = overlayPendingEntries([...(state.recentCache ?? []), ...overlapFiles.files.flatMap(file => file.entries)],
          state.pendingWrites ?? []).filter(item => !ids.has(item.id));
        for (const item of changedTimes) assertNoCompletedOverlap(item, [...others, ...updated.filter(other => other.id !== item.id)]);
      }
      const pendingWrites = [...(state.pendingWrites ?? [])];
      const existing = pendingWrites.at(-1)?.operation === 'editEntries' && !pendingWrites.at(-1).syncInFlight
      ? pendingWrites.at(-1) : null;
      const request = existing?.request ?? { entries: [] };
      const existingByIdentity = new Map(request.entries.map(item => [`${item.path}\u0000${item.original.id}`, item]));
      for (const item of requestEntries) {
        const identity = `${item.path}\u0000${item.original.id}`, prior = existingByIdentity.get(identity);
        if (prior) prior.edits = { ...prior.edits, ...item.edits };
        else { request.entries.push(item); existingByIdentity.set(identity, item); }
      }
      const operation = existing ?? {
        operation: 'editEntries', id: createUlid(queuedAt.getTime() + pendingWrites.length), status: 'pending', retryCount: 0,
        stage: 'editEntries', request, queuedAt: queuedAt.toISOString(), lastError: '',
      };
      operation.lastLocalEditAt = queuedAt.toISOString();
      if (!existing) pendingWrites.push(operation);
      const recentCache = (state.recentCache ?? []).map(entry => {
        const updated = updatedByIdentity.get(`${entry._path}\u0000${entry.id}`);
        return updated ? { ...updated, _path: entry._path, _sha: entry._sha, _index: entry._index, _pending: true } : entry;
      });
      return { pendingWrites, recentCache,
        dayRangeIntervals: updateDayRangeIntervals(state.dayRangeIntervals, [...updatedByIdentity.values()]) };
    }).then(state => ({ operationId: state.pendingWrites.at(-1)?.operation === 'editEntries' ? state.pendingWrites.at(-1).id : null, pending: true }));
  }

  async queueActiveStartEdit({ original, startedAt, description, billable }) {
    const queuedAt = this.clock();
    const snapshot = await this.store.getState();
    const current = snapshot.activeCache;
    if (!current || current.id !== original?.id || current.startedAt !== original?.startedAt) {
      throw new TrackerConflictError('The active timer changed before its edit was queued. Reload before trying again.');
    }
    const proposed = applyActiveEdits(current, { startedAt, description, billable }, queuedAt);
    const changedStart = proposed.startedAt !== current.startedAt;
    const localProjection = state => [state.recentCache, state.summaryCache, state.dayRangeIntervals, state.pendingWrites];
    let verified = null;
    if (changedStart) {
      // Pending changes are authoritative. Reject a real locally queued overlap
      // immediately; a free local interval needs no GitHub request to enqueue.
      assertNoRunningCompletedOverlap(proposed, overlayPendingEntries([], snapshot.pendingWrites ?? []), queuedAt);
      if (runningCompletedOverlap(proposed, knownLocalIntervals(snapshot), queuedAt)) {
        // A cached record may have been shortened or deleted already. Only
        // re-read on an apparent cached conflict, and project pending changes
        // onto that fresh history instead of concatenating stale versions.
        try {
          verified = await this.readEditOverlapFiles([{ ...proposed, endedAt: queuedAt.toISOString() }]);
        } catch (error) {
          if (!isRetryableReadFailure(error)) throw error;
          assertNoRunningCompletedOverlap(proposed, knownLocalIntervals(snapshot), queuedAt);
        }
      }
    }
    return this.mutateState(state => {
      const active = state.activeCache;
      if (!active || active.id !== original?.id || active.startedAt !== original?.startedAt) throw new TrackerConflictError('The active timer changed before its edit was queued. Reload before trying again.');
      const edits = {
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(billable !== undefined ? { billable } : {}),
      };
      const updated = applyActiveEdits(active, edits, queuedAt);
      const pendingWrites = [...(state.pendingWrites ?? [])];
      if (changedStart) {
        const known = verified && sameValue(localProjection(state), localProjection(snapshot))
          ? overlayPendingEntries(verified.files.flatMap(file => file.entries), pendingWrites)
          : knownLocalIntervals(state);
        assertNoRunningCompletedOverlap(updated, known, queuedAt);
      }
      const existing = trailingSupersedable(pendingWrites, operation => operation.operation === 'editActiveStart'
        && operation.original?.id === active.id);
      const operation = existing ?? {
        operation: 'editActiveStart', id: createUlid(queuedAt.getTime() + pendingWrites.length), status: 'pending', retryCount: 0,
        stage: 'editActiveStart', original: { id: active.id, startedAt: active.startedAt }, startedAt: updated.startedAt, description: updated.description, billable: isBillable(updated), queuedAt: queuedAt.toISOString(), lastError: '',
      };
      operation.startedAt = updated.startedAt;
      operation.description = updated.description;
      operation.billable = isBillable(updated);
      operation.lastLocalEditAt = queuedAt.toISOString();
      if (!existing) pendingWrites.push(operation);
      return { pendingWrites, activeCache: { ...updated, _path: active._path, _sha: active._sha, _pending: true } };
    }).then(state => ({
      operationId: trailingSupersedable(state.pendingWrites ?? [], operation => operation.operation === 'editActiveStart'
        && operation.original?.id === original.id)?.id,
      pending: true,
    }));
  }

  async editEntry({ path, originalSha, index, original, edits }, { updateCache = true } = {}) {
    const source = await this.readMonthly(path);
    if (source.sha !== originalSha) throw new TrackerConflictError('This monthly time file changed after you opened it. Reload before saving.');
    const position = locateEntry(source.entries, index, original);
    if (position < 0) throw new TrackerConflictError('This time entry changed after you opened it. Reload before saving.');
    const requestedTask = edits.taskUrl ?? edits.issue;
    const taskUrl = requestedTask === undefined ? null : normalizeStoredTaskIdentity(requestedTask);
    const indexFile = taskUrl && !/^https?:\/\//.test(taskUrl) && taskUrl !== source.entries[position].taskUrl
      ? await this.assertKnownImportedTask(taskUrl, null, 'edit_invalid_identity') : null;
    const normalized = { ...edits, ...(taskUrl ? { taskUrl } : {}) };
    const updated = applyEntryEdits(source.entries[position], normalized, editClock(this.clock, source.entries[position]));
    const timeChanged = updated.startedAt !== source.entries[position].startedAt || updated.endedAt !== source.entries[position].endedAt;
    const active = timeChanged ? await this.readRemoteActive() : null;
    if (timeChanged) assertNoActiveOverlap([updated], active);
    const guards = timeChanged ? [{ path: activeRecordPath(this.user), sha: active?._sha ?? null }] : [];
    updated.entryDate = startDate(updated);
    const destinationPath = monthlyRecordsPath(this.user, updated.entryDate);
    let overlap = null;
    if (timeChanged) {
      overlap = await this.readEditOverlapFiles([updated]);
      assertNoCompletedOverlap(updated, overlap.files.flatMap(file => file.entries));
      for (const file of overlap.files) {
        if (file.path === path && file.sha !== source.sha) {
          throw new TrackerConflictError('Time data changed while checking the destination. Reload and try again.');
        }
        if (file.path !== path && file.path !== destinationPath) guards.push({ path: file.path, sha: file.sha });
      }
    }
    try {
      if (destinationPath === path) {
        const entries = source.entries.with(position, updated);
        const { blobShas } = await this.updateCompletedRecords([
          { path: source.path, sha: source.sha, text: serializeMonthlyRecords(entries) },
        ], `time: edit ${this.user} ${source.month}`, {
          remove: [source.entries[position]], add: [updated], guards, expectedHeadSha: overlap?.headSha ?? null, indexFile,
        });
        const saved = parseMonthlyRecords(serializeMonthlyRecords(entries), { user: this.user, month: source.month, path, sha: blobShas[path] });
        if (updateCache) {
          const state = await this.store.getState();
          await this.store.patchState({ recentCache: replaceCachedFiles(state.recentCache, saved),
            dayRangeIntervals: updateDayRangeIntervals(state.dayRangeIntervals, [updated]) });
        }
        return saved[position];
      }
      const destination = await this.readMonthly(destinationPath);
      const checkedDestination = overlap?.files.find(file => file.path === destinationPath);
      if (checkedDestination && destination.sha !== checkedDestination.sha) {
        throw new TrackerConflictError('Time data changed while checking the destination. Reload and try again.');
      }
      const sourceEntries = source.entries.filter((_, current) => current !== position), destinationEntries = [...destination.entries, updated];
      const changes = [
        { path: source.path, sha: source.sha, text: serializeMonthlyRecords(sourceEntries) || null },
        { path: destination.path, sha: destination.sha, text: serializeMonthlyRecords(destinationEntries) },
      ];
      const result = await this.updateCompletedRecords(changes, `time: move edited entry ${this.user}`, {
        remove: [source.entries[position]], add: [updated], guards, expectedHeadSha: overlap?.headSha ?? null, indexFile,
      });
      const savedSource = parseMonthlyRecords(serializeMonthlyRecords(sourceEntries), { user: this.user, month: source.month, path: source.path, sha: result.blobShas[source.path] ?? null });
      const savedDestination = parseMonthlyRecords(serializeMonthlyRecords(destinationEntries), { user: this.user, month: destination.month, path: destination.path, sha: result.blobShas[destination.path] });
      const replacements = [...savedSource, ...savedDestination];
      if (updateCache) {
        const state = await this.store.getState();
        await this.store.patchState({ recentCache: replaceCachedFiles(state.recentCache, replacements, [source.path, destination.path]),
          dayRangeIntervals: updateDayRangeIntervals(state.dayRangeIntervals, [updated]) });
      }
      return savedDestination.at(-1);
    } catch (error) { if (isConflict(error)) throw new TrackerConflictError('A monthly time file changed while you were saving. Reload.'); throw error; }
  }


  async editActiveStart({ original, startedAt, description, billable }, { updateCache = true } = {}) {
    const active = await this.readRemoteActive();
    if (!active) throw new TrackerConflictError('The running timer is no longer active. Reload before saving.');
    // GitHub may have accepted this exact change before the service worker
    // stopped, without IndexedDB recording the successful acknowledgement.
    // Adopt it instead of repeatedly conflicting or writing a duplicate commit.
    if (matchesOriginal(active, original)
        && (startedAt === undefined || active.startedAt === startedAt)
        && (description === undefined || active.description === description)
        && (billable === undefined || isBillable(active) === billable)) {
      if (updateCache) await this.store.patchState({ activeCache: active });
      return active;
    }
    if (!matchesOriginal(active, original) || active.startedAt !== original?.startedAt) {
      throw new TrackerConflictError('The running timer changed after the timeline loaded. Reload before saving.');
    }
    const now = this.clock();
    const updated = applyActiveEdits(active, { startedAt, description, billable }, now);
    const path = activeRecordPath(this.user);
    const overlap = updated.startedAt !== active.startedAt
      ? await this.readEditOverlapFiles([{ ...updated, endedAt: now.toISOString() }]) : null;
    if (overlap) assertNoRunningCompletedOverlap(updated, overlap.files.flatMap(file => file.entries), now);
    try {
      const result = overlap
        ? await this.github.updateTextsAtomic([{ path, sha: active._sha, text: serializeActiveRecord(updated) }],
          `timer: edit start ${this.user}`, { guards: overlap.files.map(file => ({ path: file.path, sha: file.sha })), expectedHeadSha: overlap.headSha })
        : await this.github.putText(path, serializeActiveRecord(updated), `timer: edit start ${this.user}`, active._sha);
      const cached = { ...updated, _path: path, _sha: overlap ? result.blobShas[path] : result.sha };
      if (updateCache) await this.store.patchState({ activeCache: cached });
      return cached;
    } catch (error) {
      if (isConflict(error)) throw new TrackerConflictError('The running timer changed while you were saving. Reload before saving.');
      throw error;
    }
  }

  async editEntries({ entries: requests }, { updateCache = true } = {}) {
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > 50) throw new Error('One to fifty linked time entries are required');
    const files = new Map();
    for (const request of requests) {
      if (!request?.path) throw new Error('Each linked time entry requires a monthly path');
      if (!files.has(request.path)) files.set(request.path, await this.readMonthly(request.path));
      const file = files.get(request.path);
      if (file.sha !== request.originalSha) throw new TrackerConflictError('A monthly time file changed after the panel loaded. Reload before saving.');
      request.position = locateEntry(file.entries, request.index, request.original);
      if (request.position < 0) throw new TrackerConflictError('A linked time entry changed inside its monthly file. Reload before saving.');
      request.originalEntry = file.entries[request.position];
    }
    const identities = new Set(requests.map(request => `${request.path}\u0000${request.position}`));
    if (identities.size !== requests.length) throw new Error('Linked time entries must be distinct');
    const updated = [];
    let indexFile = null;
    for (const request of requests) {
      const requestedTask = request.edits?.taskUrl ?? request.edits?.issue;
      const taskUrl = requestedTask === undefined ? null : normalizeStoredTaskIdentity(requestedTask);
      if (taskUrl && !/^https?:\/\//.test(taskUrl) && taskUrl !== request.originalEntry.taskUrl) {
        indexFile = await this.assertKnownImportedTask(taskUrl, indexFile, 'edit_invalid_identity');
      }
      const edits = { ...request.edits, ...(taskUrl ? { taskUrl } : {}) };
      const entry = applyEntryEdits(request.originalEntry, edits, editClock(this.clock, request.originalEntry));
      entry.entryDate = startDate(entry);
      updated.push(entry);
    }
    const changedTimes = updated.filter((entry, index) => entry.startedAt !== requests[index].originalEntry.startedAt
      || entry.endedAt !== requests[index].originalEntry.endedAt);
    const active = changedTimes.length ? await this.readRemoteActive() : null;
    assertNoActiveOverlap(changedTimes, active);
    const guards = changedTimes.length ? [{ path: activeRecordPath(this.user), sha: active?._sha ?? null }] : [];
    const overlap = changedTimes.length ? await this.readEditOverlapFiles(changedTimes) : null;
    const targetPaths = updated.map(entry => monthlyRecordsPath(this.user, entry.entryDate));
    for (const targetPath of targetPaths) if (!files.has(targetPath)) files.set(targetPath, await this.readMonthly(targetPath));
    if (overlap) {
      const ids = new Set(updated.map(entry => entry.id));
      const others = overlap.files.flatMap(file => file.entries).filter(entry => !ids.has(entry.id));
      for (const entry of changedTimes) assertNoCompletedOverlap(entry, [...others, ...updated.filter(other => other.id !== entry.id)]);
      for (const file of overlap.files) {
        if (files.has(file.path)) {
          if (files.get(file.path).sha !== file.sha) {
            throw new TrackerConflictError('Time data changed while checking the destination. Reload and try again.');
          }
        } else guards.push({ path: file.path, sha: file.sha });
      }
    }
    for (const request of requests) {
      const source = files.get(request.path);
      source.entries = source.entries.filter(entry => entry !== request.originalEntry);
    }
    updated.forEach((entry, index) => files.get(targetPaths[index]).entries.push(entry));
    const touchedPaths = [...new Set([...requests.map(request => request.path), ...targetPaths])];
    const touched = touchedPaths.map(path => files.get(path));
    for (const file of touched) file.entries.sort((left, right) => new Date(left.startedAt) - new Date(right.startedAt));
    const resultLocations = updated.map((entry, index) => ({ path: targetPaths[index], index: files.get(targetPaths[index]).entries.indexOf(entry) }));
    try {
      const changes = touched.map(file => ({ path: file.path, sha: file.sha, text: serializeMonthlyRecords(file.entries) || null }));
      const { blobShas } = await this.updateCompletedRecords(changes, `time: edit linked entries ${this.user}`, {
        remove: requests.map(request => request.originalEntry), add: updated, guards, expectedHeadSha: overlap?.headSha ?? null, indexFile,
      });
      const savedByPath = new Map(touched.map(file => [file.path, parseMonthlyRecords(serializeMonthlyRecords(file.entries), {
        user: this.user, month: file.month, path: file.path, sha: blobShas[file.path] ?? null,
      })]));
      const replacements = [...savedByPath.values()].flat();
      if (updateCache) {
        const state = await this.store.getState();
        await this.store.patchState({ recentCache: replaceCachedFiles(state.recentCache, replacements, touchedPaths),
          dayRangeIntervals: updateDayRangeIntervals(state.dayRangeIntervals, updated) });
      }
      return resultLocations.map(location => savedByPath.get(location.path)[location.index]);
    } catch (error) {
      if (isConflict(error)) throw new TrackerConflictError('A monthly time file changed while linked time edits were being saved. Reload.');
      throw error;
    }
  }

  async mergeTasks({ pairs, startDate, endDate }) {
    if (!Array.isArray(pairs) || !pairs.length || pairs.length > 100) throw new Error('Choose one to one hundred task merges');
    const replacements = new Map();
    for (const pair of pairs) {
      const sourceUrl = normalizeStoredTaskIdentity(pair?.sourceTaskUrl), targetUrl = this.validateTaskUrl(pair?.targetTaskUrl);
      if (sourceUrl === targetUrl) throw new Error('Choose two different tasks to merge');
      if (replacements.has(sourceUrl)) throw new Error('Each task can be replaced only once');
      replacements.set(sourceUrl, { taskUrl: targetUrl, taskTitle: String(pair?.targetTaskTitle || '').trim().slice(0, 300) });
    }
    const state = await this.store.getState();
    if ((state.pendingWrites ?? []).length) throw new Error('Sync pending changes before merging tasks.');
    entryDateParts(startDate); entryDateParts(endDate);
    if (startDate > endDate) throw new Error('Task merge end date must not precede start date');
    const activePath = activeRecordPath(this.user);
    const snapshot = await this.github.listTextFilesSnapshot('times/', { includeActive: activePath, includePaths: [TASK_INDEX_PATH] });
    const files = new Map();
    const monthly = (snapshot.files ?? []).flatMap(file => {
      try {
        const month = monthFromPath(file.path, this.user);
        return month >= startDate.slice(0, 7) && month <= endDate.slice(0, 7) ? [{ ...file, month }] : [];
      } catch { return []; }
    });
    for (let offset = 0; offset < monthly.length; offset += 6) {
      const loaded = await Promise.all(monthly.slice(offset, offset + 6).map(async file => {
        const cached = await this.reports?.cachedMonthly(file.path, file.sha);
        if (cached) return { ...cached, month: file.month };
        const blob = await this.github.getBlobText(file.path, file.sha);
        return { ...file, entries: parseMonthlyRecords(blob.text, { user: this.user, month: file.month, path: file.path, sha: file.sha }) };
      }));
      for (const file of loaded) files.set(file.path, file);
    }
    const removed = [], added = [], touched = [];
    for (const file of files.values()) {
      let changed = false;
      file.entries = file.entries.map(entry => {
        const replacement = replacements.get(taskUrlOf(entry));
        if (entry.entryDate < startDate || entry.entryDate > endDate || !replacement) return entry;
        const updated = withTaskIdentityHistory(applyEntryEdits(entry, replacement, editClock(this.clock, entry)), entry);
        removed.push(entry); added.push(updated); changed = true; return updated;
      });
      if (changed) touched.push(file);
    }
    const activeFile = snapshot.files.find(file => file.path === activePath);
    const active = activeFile ? parseActiveRecord((await this.github.getBlobText(activePath, activeFile.sha)).text, {
      user: this.user, path: activePath, sha: activeFile.sha,
    }) : null;
    const activeReplacement = active ? replacements.get(taskUrlOf(active)) : null;
    const mergeActive = Boolean(active && active.entryDate >= startDate && active.entryDate <= endDate && activeReplacement);
    const updatedActive = mergeActive
      ? withTaskIdentityHistory(applyActiveEdits(active, activeReplacement, this.clock()), active) : active;
    if (!touched.length && !mergeActive) return { mergedEntries: 0, mergedActive: false };
    const changes = touched.map(file => ({ path: file.path, sha: file.sha, text: serializeMonthlyRecords(file.entries) }));
    if (mergeActive) changes.push({ path: activePath, sha: active._sha, text: serializeActiveRecord(updatedActive) });
    try {
      const index = snapshot.files.find(file => file.path === TASK_INDEX_PATH);
      if (!index) throw new Error('The mandatory Clockoli task index is missing.');
      const expectedHeadSha = snapshot.headSha || null;
      const result = removed.length
        ? await this.updateCompletedRecords(changes, `time: merge tasks ${this.user}`, {
          remove: removed, add: added, expectedHeadSha,
          indexFile: { path: TASK_INDEX_PATH, sha: index.sha, index: parseTaskIndex(
            (await this.github.getBlobText(TASK_INDEX_PATH, index.sha)).text, { user: this.user }) },
        })
        : await this.github.updateTextsAtomic(changes, `timer: merge active task ${this.user}`, {
          guards: [{ path: TASK_INDEX_PATH, sha: index.sha }], expectedHeadSha,
        });
      const replacements = touched.flatMap(file => parseMonthlyRecords(serializeMonthlyRecords(file.entries), {
        user: this.user, month: file.month, path: file.path, sha: result.blobShas[file.path],
      }));
      const patch = {};
      if (touched.length) patch.recentCache = replaceCachedFiles(state.recentCache, replacements, touched.map(file => file.path));
      if (mergeActive) patch.activeCache = { ...updatedActive, _path: activePath, _sha: result.blobShas[activePath] };
      await this.store.patchState(patch);
      return { mergedEntries: removed.length, mergedActive: mergeActive };
    } catch (error) {
      if (isConflict(error)) throw new TrackerConflictError('Time data changed while tasks were being merged. Reload and try again.');
      throw error;
    }
  }

  async readEditOverlapFiles(entries, source = null) {
    const snapshot = await this.github.listTextFilesSnapshot('times/');
    const cachedSources = new Map((Array.isArray(source) ? source : source ? [source] : [])
      .map(item => [item.path, item.sha]));
    // Another record may use a timezone up to a day ahead of this entry's UTC end.
    const latestMonth = entries.map(entry => new Date(new Date(entry.endedAt).getTime() + 86_400_000)
      .toISOString().slice(0, 7)).sort().at(-1);
    const paths = new Set(snapshot.files.map(file => file.path).filter(path =>
      /^times\/\d{4}-(?:0[1-9]|1[0-2])\//.test(path)
      && path.endsWith(`/${this.user}.jsonl`) && path.slice(6, 13) <= latestMonth));
    for (const entry of entries) paths.add(monthlyRecordsPath(this.user, entry.entryDate));
    for (const path of cachedSources.keys()) paths.add(path);
    const shas = new Map(snapshot.files.map(file => [file.path, file.sha]));
    const files = [], selectedPaths = [...paths];
    for (let offset = 0; offset < selectedPaths.length; offset += 4) {
      files.push(...await Promise.all(selectedPaths.slice(offset, offset + 4).map(async path => {
        const sha = shas.get(path);
        if (sha && (!cachedSources.has(path) || sha === cachedSources.get(path))) {
          const cached = await this.reports?.cachedMonthly(path, sha);
          if (cached) return cached;
        }
        return this.readMonthly(path);
      })));
    }
    return { files, headSha: snapshot.headSha || null };
  }

  async readAddTimeOverlapFiles(day, now, endDay = null, through = now) {
    const previousDay = new Date(`${day}T12:00:00.000Z`);
    previousDay.setUTCDate(previousDay.getUTCDate() - 1);
    // A completed entry is partitioned by its own recorded timezone, which
    // can be up to fourteen hours ahead of the device checking the overlap.
    const aheadDay = new Date(through.getTime() + 14 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // Historical additions may overlap a timer that started many days earlier.
    // Do not enumerate repository history for today's Add time.
    const snapshot = day === localDateInTimezone(now, this.timezone)
      ? null : await this.github.listTextFilesSnapshot('times/');
    const throughMonth = aheadDay.slice(0, 7);
    const olderPaths = (snapshot?.files ?? []).map(file => file.path).filter(path =>
      /^times\/\d{4}-(?:0[1-9]|1[0-2])\//.test(path)
      && path.endsWith(`/${this.user}.jsonl`) && path.slice(6, 13) <= throughMonth);
    const paths = [...new Set([day, previousDay.toISOString().slice(0, 10), aheadDay, ...(endDay ? [endDay] : [])]
      .map(date => monthlyRecordsPath(this.user, date)).concat(olderPaths))];
    return { files: await Promise.all(paths.map(path => this.readMonthly(path))), headSha: snapshot?.headSha || null };
  }

  async queueAddTime({ taskUrl, taskTitle = '', startedAt, endedAt = null, description = '', billable }) {
    const canonical = normalizeStoredTaskIdentity(taskUrl);
    const now = this.clock(), start = startedAt == null ? now : new Date(startedAt);
    const end = endedAt == null ? null : new Date(endedAt);
    const startMs = start.getTime(), endMs = end?.getTime();
    if (!Number.isFinite(startMs) || startMs > now.getTime()) throw new Error('Start time must be valid and not in the future.');
    if (end && (!Number.isFinite(endMs) || endMs <= startMs || endMs > now.getTime())) throw new Error('End time must be after Start and not in the future.');
    if ((endMs ?? now.getTime()) - startMs > 24 * 60 * 60 * 1000) throw new Error('One Add time entry cannot exceed 24 hours.');
    if (typeof taskTitle !== 'string' || taskTitle.length > 500 || typeof description !== 'string' || description.length > 2000) {
      throw new Error('Task title or description is too long.');
    }
    if (!end) {
      const state = await this.store.getState();
      if (state.activeCache) throw new Error(`A timer is already tracking ${taskLabel(state.activeCache)}`);
      const active = await this.queueStart(canonical, taskTitle, description, { startedAt: start, requireNoOverlap: true, billable });
      return { active, pending: true };
    }
    let acceptedEntry;
    await this.mutateState(state => {
      if (state.activeCache && endMs > new Date(state.activeCache.startedAt).getTime()) {
        throw new Error('Added time would overlap the running timer.');
      }
      const known = knownLocalIntervals(state);
      if (known.some(entry => new Date(entry.startedAt).getTime() < endMs
          && new Date(entry.endedAt).getTime() > startMs)) {
        throw new Error('Added time would overlap existing time.');
      }
      const usedIds = new Set(known.map(item => item.id));
      const record = this.buildActive({ id: this.uniqueRecordId(startMs, usedIds), taskUrl: canonical,
        taskTitle, startedAt: start, description, billable });
      const entry = buildEntry({ active: record, endedAt: end, now, description });
      const path = monthlyRecordsPath(this.user, entry.entryDate);
      acceptedEntry = { ...entry, _path: path, _sha: null, _index: -1, _pending: true };
      const pendingWrites = [...(state.pendingWrites ?? []), {
        operation: 'addTime', id: createUlid(now.getTime() + (state.pendingWrites?.length ?? 0)),
        status: 'pending', stage: 'addTime', entry: stripInternal(entry),
        queuedAt: now.toISOString(), lastError: '',
      }];
      return {
        pendingWrites,
        recentCache: [acceptedEntry, ...(state.recentCache ?? []).filter(item => item.id !== entry.id)]
          .sort(newestFirst).slice(0, 50),
      };
    });
    return { entry: acceptedEntry, pending: true };
  }

  async addTime({ taskUrl, taskTitle = '', startedAt, endedAt = null, description = '', billable }, {
    background = false, fixedId = null, acceptedEntry = null, updateCache = true,
  } = {}) {
    if (background) return this.queueAddTime({ taskUrl, taskTitle, startedAt, endedAt, description, billable });
    const canonical = normalizeStoredTaskIdentity(taskUrl);
    const now = this.clock(), start = startedAt == null ? now : new Date(startedAt);
    const startMs = start.getTime(), end = endedAt == null ? null : new Date(endedAt), endMs = end?.getTime();
    if (!Number.isFinite(startMs) || startMs > now.getTime()) throw new Error('Start time must be valid and not in the future.');
    if (end && (!Number.isFinite(endMs) || endMs <= startMs || endMs > now.getTime())) throw new Error('End time must be after Start and not in the future.');
    // Previously accepted work must still synchronize after a restart or a long offline period.
    if (!fixedId && (endMs ?? now.getTime()) - startMs > 24 * 60 * 60 * 1000) throw new Error('One Add time entry cannot exceed 24 hours.');
    const accepted = acceptedEntry ? validateEntry(stripInternal(acceptedEntry)) : null;
    if (accepted && (accepted.id !== fixedId || accepted.user !== this.user
        || accepted.taskUrl !== canonical || accepted.startedAt !== start.toISOString()
        || accepted.endedAt !== end?.toISOString() || accepted.description !== description
        || (billable !== undefined && isBillable(accepted) !== billable)
        || accepted.entryDate !== localDateInTimezone(start, accepted.timezone))) {
      throw new Error('Queued Add time entry does not match its locally accepted record.');
    }
    const originalDay = accepted?.entryDate ?? localDateInTimezone(start, this.timezone);
    if (typeof taskTitle !== 'string' || taskTitle.length > 500 || typeof description !== 'string' || description.length > 2000) {
      throw new Error('Task title or description is too long.');
    }
    const state = await this.store.getState();
    if (state.activeCache && !end) throw new Error(`A timer is already tracking ${taskLabel(state.activeCache)}`);
    if (state.pendingWrites?.length && !fixedId) throw new Error('Pending time writes must sync before adding time.');
    const indexFile = /^https?:\/\//.test(canonical) ? null : await this.assertKnownImportedTask(canonical);
    const active = fixedId ? await this.readRemoteActive() : await this.refreshActive();
    if (active && (!end || endMs > new Date(active.startedAt).getTime())) throw new Error('Added time would overlap the running timer.');
    const { files, headSha } = await this.readAddTimeOverlapFiles(originalDay, now,
      localDateInTimezone(end ?? now, accepted?.timezone ?? this.timezone), end ?? now);
    if (files.some(file => file.entries.some(entry => entry.id !== fixedId
        && new Date(entry.startedAt).getTime() < (endMs ?? now.getTime())
        && new Date(entry.endedAt).getTime() > startMs))) {
      if (fixedId) throw new TrackerConflictError('Added time overlaps existing time on GitHub. Review Activity.', 'add_time_overlap');
      throw new Error('Added time would overlap existing time.');
    }
    if (!end) return { active: await this.queueStart(canonical, taskTitle, description, {
      startedAt: start, overlapGuards: files.map(file => ({ path: file.path, sha: file.sha })), billable,
      overlapHeadSha: headSha, requireNoOverlap: true,
    }) };
    const entry = accepted ?? buildEntry({
      active: this.buildActive({
        id: fixedId || this.uniqueRecordId(startMs, new Set(files.flatMap(file => file.entries.map(entry => entry.id)))),
        taskUrl: canonical, taskTitle, startedAt: start, description, billable,
      }),
      endedAt: end, now, description,
    });
    const path = monthlyRecordsPath(this.user, entry.entryDate);
    const file = files.find(item => item.path === path) ?? await this.readMonthly(path);
    const previouslySaved = fixedId ? file.entries.find(item => item.id === fixedId) : null;
    if (previouslySaved) {
      if (previouslySaved.startedAt !== entry.startedAt || previouslySaved.endedAt !== entry.endedAt
          || previouslySaved.taskUrl !== entry.taskUrl || previouslySaved.description !== entry.description
          || isBillable(previouslySaved) !== isBillable(entry)) {
        throw new TrackerConflictError('Previously saved Add time has changed on GitHub.', 'add_time_changed');
      }
      return { entry: previouslySaved, pending: false };
    }
    const entries = [...file.entries, entry].sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
    const text = serializeMonthlyRecords(entries);
    parseMonthlyRecords(text, { user: this.user, month: file.month, path });
    try {
      const { blobShas } = await this.updateCompletedRecords([{ path, sha: file.sha, text }], `time: add ${this.user}`, {
        add: [entry], guards: [
          ...files.filter(item => item.path !== path).map(item => ({ path: item.path, sha: item.sha })),
          { path: activeRecordPath(this.user), sha: active?._sha ?? null },
        ], expectedHeadSha: headSha, ...(indexFile ? { indexFile } : {}),
      });
      const saved = parseMonthlyRecords(text, { user: this.user, month: file.month, path, sha: blobShas[path] });
      if (updateCache) await this.store.patchState({ recentCache: replaceCachedFiles(state.recentCache, saved, [path]) });
      return { entry: fixedId ? saved.find(item => item.id === fixedId) : entry };
    } catch (error) {
      if (isConflict(error)) throw new TrackerConflictError('Time changed while adding this entry. Reload and try again.');
      throw error;
    }
  }

  planBulkRows(requested, files, activeTimer, fixedIds = null, acceptedEntries = null, { replanAccepted = false } = {}) {
    const activeStartMs = activeTimer ? new Date(activeTimer.startedAt).getTime() : Infinity;
    const added = [], usedIds = new Set([...files.values()].flatMap(file => file.entries.map(record => record.id)));
    for (const [offset, item] of requested.entries()) {
      const dayStartMs = new Date(localMidnight(item.date)).getTime();
      const dayEndMs = new Date(nextLocalMidnight(item.date)).getTime();
      const fixedStart = item.startTime === '09:00';
      const accepted = fixedStart && fixedIds ? acceptedEntries?.[offset] : null;
      const preferredStartMs = fixedStart ? new Date(`${item.date}T09:00:00`).getTime() : dayStartMs;
      const durationMs = item.durationSeconds * 1000;
      // A 24-hour Multiple days entry is the one permitted exception that
      // spans into the following day; it keeps its original 09:00 anchor.
      const limitMs = fixedStart && durationMs === 86_400_000 ? preferredStartMs + durationMs : dayEndMs;
      const existing = [...files.values()].flatMap(file => file.entries).filter(entry => {
        const start = new Date(entry.startedAt).getTime(), end = new Date(entry.endedAt).getTime();
        return end > start && start < limitMs && end > dayStartMs;
      }).sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
      for (let index = 1; index < existing.length; index++) {
        if (new Date(existing[index].startedAt) < new Date(existing[index - 1].endedAt)) {
          throw new Error(`Line ${item.line}: existing time on ${item.date} already overlaps. No entries were added.`);
        }
      }
      const occupied = existing.map(entry => ({
        start: new Date(entry.startedAt).getTime(), end: new Date(entry.endedAt).getTime(),
      }));
      if (activeStartMs < limitMs) occupied.push({ start: activeStartMs, end: Infinity });
      occupied.sort((a, b) => a.start - b.start);
      const overlaps = (start, end, interval) => durationMs > 0
        && interval.start < end && interval.end > start;
      const firstFree = (from, until) => {
        let cursor = from;
        if (durationMs === 0) return cursor <= until ? cursor : null;
        for (const interval of occupied) {
          if (interval.end <= cursor) continue;
          if (cursor + durationMs <= interval.start) break;
          cursor = Math.max(cursor, interval.end);
          if (cursor + durationMs > until) return null;
        }
        return cursor + durationMs <= until ? cursor : null;
      };
      let startedMs = accepted ? new Date(accepted.startedAt).getTime() : null;
      if (accepted && occupied.some(interval => overlaps(startedMs, startedMs + durationMs, interval))) {
        if (!replanAccepted || accepted.timezone !== this.timezone) {
          throw new TrackerConflictError(
            activeStartMs < startedMs + durationMs
              ? `Selected day ${item.date} overlaps the running timer on GitHub. Queued days remain for review.`
              : `Selected day ${item.date} overlaps an existing time entry on GitHub. Queued days remain for review.`,
            'bulk_add_validation',
          );
        }
        // Multiple days specifies a calendar day and duration, not an exact
        // clock time. At sync, find a safe free slot from the complete GitHub
        // history if the locally chosen interval is no longer available.
        startedMs = null;
      }
      if (startedMs === null && fixedStart && durationMs === 86_400_000) {
        startedMs = firstFree(preferredStartMs, limitMs);
      } else if (startedMs === null && fixedStart) {
        startedMs = firstFree(preferredStartMs, dayEndMs);
        if (startedMs === null) startedMs = firstFree(dayStartMs, dayEndMs);
      } else if (startedMs === null) {
        // Bulk time adding uses this same planner: append when possible,
        // otherwise fill a contiguous earlier gap.
        const latestEnd = existing.reduce((latest, entry) =>
          Math.max(latest, new Date(entry.endedAt).getTime()), dayStartMs);
        startedMs = firstFree(latestEnd, dayEndMs);
        if (startedMs === null) startedMs = firstFree(dayStartMs, dayEndMs);
      }
      if (startedMs === null) {
        const hours = item.durationSeconds / 3600;
        const running = activeStartMs < dayEndMs;
        throw new TrackerConflictError(running
          ? fixedStart
            ? `Selected day ${item.date} cannot fit ${hours} hours without overlapping the running timer. No days were added.`
            : `Line ${item.line}: ${hours} hours would overlap the running timer on ${item.date}. No entries were added.`
          : fixedStart
            ? `Selected day ${item.date} has no free ${hours}-hour interval. No days were added.`
            : `Line ${item.line}: ${hours} hours do not fit in a free interval on ${item.date}. No entries were added.`,
        'bulk_add_validation');
      }
      const endedMs = startedMs + durationMs;
      const id = fixedIds?.[offset] || this.uniqueRecordId(startedMs, usedIds);
      if (fixedIds && (usedIds.has(id) || !id)) {
        throw new TrackerConflictError('A bulk time entry ID already exists. Review Activity before retrying.', 'bulk_add_id_conflict');
      }
      usedIds.add(id);
      const active = this.buildActive({ id, taskUrl: item.taskUrl, taskTitle: item.taskTitle || '',
        startedAt: localTimestamp(new Date(startedMs)), entryDate: item.date, description: item.description, billable: item.billable,
        ...(accepted ? { timezone: accepted.timezone } : {}) });
      const entry = buildEntry({ active, endedAt: localTimestamp(new Date(endedMs)),
        now: localTimestamp(new Date(endedMs)), description: item.description });
      entry.entryDate = item.date;
      const path = monthlyRecordsPath(this.user, item.date), file = files.get(path);
      file.entries.push(entry);
      file.entries.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
      added.push(entry);
    }
    return added;
  }

  async addDayRange({ taskUrl, taskTitle = '', description = '', dates, durationSeconds, billable }) {
    const canonical = normalizeStoredTaskIdentity(taskUrl);
    const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
      && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
    if (!Array.isArray(dates) || !dates.length || dates.length > 500
        || dates.some((date, index) => !validDate(date) || index > 0 && date <= dates[index - 1])
        || (Date.parse(`${dates.at(-1)}T00:00:00.000Z`) - Date.parse(`${dates[0]}T00:00:00.000Z`)) / 86400000 >= 500
        || dates.at(-1) > localDateInTimezone(this.clock(), this.timezone)
        || !Number.isSafeInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 86400
        || typeof taskTitle !== 'string' || taskTitle.length > 500
        || typeof description !== 'string' || description.length > 2000) throw new Error('Invalid selected days or hours per day.');
    const requested = dates.map((date, index) => ({
      line: index + 1, date,
      taskUrl: canonical, taskTitle, description, durationSeconds, startTime: '09:00', billable,
    }));
    return this.queueBulkAddTimes('', requested, { noFuture: true });
  }

  async queueBulkAddTimes(text, requested = parseBulkTimeText(text), { noFuture = false } = {}) {
    const queuedAt = this.clock();
    let accepted;
    await this.mutateState(state => {
      const known = knownLocalIntervals(state);
      const files = new Map();
      for (const record of known) {
        const path = monthlyRecordsPath(this.user, record.entryDate);
        if (!files.has(path)) files.set(path, { path, month: record.entryDate.slice(0, 7), entries: [] });
        if (!files.get(path).entries.some(entry => entry.id === record.id)) files.get(path).entries.push(record);
      }
      for (const item of requested) {
        const path = monthlyRecordsPath(this.user, item.date);
        if (!files.has(path)) files.set(path, { path, month: item.date.slice(0, 7), entries: [] });
      }
      const planned = this.planBulkRows(requested, files, state.activeCache);
      if (noFuture && planned.some(entry => new Date(entry.endedAt) > queuedAt)) {
        throw new Error('Day range would add time in the future. No entries were added.');
      }
      accepted = planned.map(entry => ({
        ...entry, _path: monthlyRecordsPath(this.user, entry.entryDate), _sha: null, _index: -1, _pending: true,
      }));
      const pendingWrites = [...(state.pendingWrites ?? []), {
        operation: 'bulkAddTimes', id: createUlid(queuedAt.getTime() + (state.pendingWrites?.length ?? 0)),
        status: 'pending', stage: 'bulkAddTimes', requested: structuredClone(requested),
        entries: planned.map(stripInternal), queuedAt: queuedAt.toISOString(), lastError: '',
      }];
      const newIds = new Set(accepted.map(entry => entry.id));
      return {
        pendingWrites,
        recentCache: [...accepted, ...(state.recentCache ?? []).filter(entry => !newIds.has(entry.id))]
          .sort(newestFirst).slice(0, 50),
        ...(noFuture ? { dayRangeIntervals: rememberDayRangeIntervals(state.dayRangeIntervals, planned) } : {}),
      };
    });
    return { added: requested.length, pending: true, entries: accepted };
  }

  async bulkAddTimes(text, { background = false, requested = null, billable = true, ids = null, acceptedEntries = null,
    updateCache = true, includeEntries = false, onRelocated = null } = {}) {
    if (background) return this.queueBulkAddTimes(text, requested ?? parseBulkTimeText(text, { billable }));
    requested ||= parseBulkTimeText(text, { billable });
    if (ids && requested.some((item, index) => item.startTime === '09:00'
        && (acceptedEntries?.[index]?.id !== ids[index] || acceptedEntries[index].entryDate !== item.date
          || acceptedEntries[index].taskUrl !== item.taskUrl
          || acceptedEntries[index].durationSeconds !== item.durationSeconds
          || !Number.isFinite(Date.parse(acceptedEntries[index].startedAt))))) {
      throw new TrackerConflictError('Queued multiple-day time changed locally. Review Activity before retrying.', 'bulk_add_changed');
    }
    const importedTask = requested.find(item => !/^https?:\/\//i.test(item.taskUrl));
    const indexFile = importedTask ? await this.assertKnownImportedTask(importedTask.taskUrl) : null;
    const activeTimer = ids ? await this.readRemoteActive() : await this.refreshActive();
    const touchedMonths = new Set(requested.map(item => item.date.slice(0, 7)));
    const validationMonths = new Set(touchedMonths);
    for (const item of requested) if (item.startTime === '09:00' && item.durationSeconds > 0) {
      const nextDay = new Date(`${item.date}T00:00:00.000Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      if (nextDay.toISOString().slice(0, 7) !== item.date.slice(0, 7)) validationMonths.add(nextDay.toISOString().slice(0, 7));
    }
    const lastCheckedMonth = [...validationMonths].sort().at(-1);
    const snapshot = await this.github.listTextFilesSnapshot('times/');
    for (const file of snapshot.files ?? []) {
      try {
        const month = monthFromPath(file.path, this.user);
        if (month <= lastCheckedMonth) validationMonths.add(month);
      } catch { /* Another user's or unrelated text file. */ }
    }
    const files = new Map();
    for (const month of [...validationMonths].sort()) {
      const path = monthlyRecordsPath(this.user, `${month}-01`);
      files.set(path, await this.readMonthly(path));
    }
    if (ids) {
      const found = ids.map(id => [...files.values()].flatMap(file => file.entries).find(entry => entry.id === id));
      if (found.every(Boolean)) {
        if (found.some((entry, index) => entry.taskUrl !== requested[index].taskUrl
            || entry.description !== requested[index].description || entry.durationSeconds !== requested[index].durationSeconds
            || (requested[index].billable !== undefined && isBillable(entry) !== requested[index].billable)
            || (requested[index].taskTitle !== undefined && entry.taskTitle !== requested[index].taskTitle)
            || (requested[index].startTime === '09:00' && (entry.entryDate !== acceptedEntries[index].entryDate
              || entry.startedAt !== acceptedEntries[index].startedAt || entry.endedAt !== acceptedEntries[index].endedAt
              || entry.timezone !== acceptedEntries[index].timezone)))) {
          throw new TrackerConflictError('Previously saved bulk time has changed on GitHub.', 'bulk_add_changed');
        }
        return { added: found.length, ...(includeEntries ? { savedEntries: found } : {}) };
      }
      if (found.some(Boolean)) throw new TrackerConflictError('Bulk time is only partially present on GitHub. No automatic rewrite was attempted.', 'bulk_add_partial');
    }
    const added = this.planBulkRows(requested, files, activeTimer, ids, acceptedEntries,
      { replanAccepted: Boolean(ids && onRelocated) });
    if (ids && onRelocated && added.some((entry, index) =>
      entry.startedAt !== acceptedEntries[index].startedAt || entry.endedAt !== acceptedEntries[index].endedAt)) {
      // Persist the revised accepted instants before the guarded GitHub write.
      // This is essential for replay if GitHub commits but its response is lost.
      await onRelocated(added);
    }
    const touched = [...touchedMonths].sort().map(month => files.get(monthlyRecordsPath(this.user, `${month}-01`)));
    const staged = touched.map(file => {
      const text = serializeMonthlyRecords(file.entries);
      const entries = parseMonthlyRecords(text, { user: this.user, month: file.month, path: file.path });
      return { file, text, entries };
    });
    try {
      const touchedPaths = new Set(touched.map(file => file.path));
      const changes = staged.map(({ file, text }) => ({ path: file.path, sha: file.sha, text }));
      const guards = [...files.values()].filter(file => !touchedPaths.has(file.path)).map(file => ({ path: file.path, sha: file.sha }));
      guards.push({ path: activeRecordPath(this.user), sha: activeTimer?._sha ?? null });
      const { blobShas } = await this.updateCompletedRecords(changes, `time: bulk add ${added.length} entries ${this.user}`, {
        add: added, guards, expectedHeadSha: snapshot.headSha || null, ...(indexFile ? { indexFile } : {}),
      });
      const saved = staged.flatMap(({ file, entries }) => entries.map(entry => ({ ...entry, _sha: blobShas[file.path] })));
      if (updateCache) {
        const state = await this.store.getState();
        await this.store.patchState({ recentCache: replaceCachedFiles(state.recentCache, saved, touched.map(file => file.path)) });
      }
      return { added: added.length, ...(includeEntries ? { savedEntries: saved.filter(entry => added.some(item => item.id === entry.id)) } : {}) };
    } catch (error) {
      if (isConflict(error)) throw new TrackerConflictError('A monthly time file changed during bulk import. No entries were added; reload and try again.');
      throw error;
    }
  }

  async deleteEntry({ path, originalSha, index, original }, { updateCache = true } = {}) {
    const file = await this.readMonthly(path);
    if (file.sha !== originalSha) throw new TrackerConflictError('This monthly time file changed after the panel loaded. Reload before deleting.');
    const located = locateEntry(file.entries, index, original);
    if (located < 0) throw new TrackerConflictError('This time entry changed after the panel loaded. Reload before deleting.');
    const entries = file.entries.filter((_, position) => position !== located);
    try {
      const { blobShas } = await this.updateCompletedRecords([
        { path: file.path, sha: file.sha, text: serializeMonthlyRecords(entries) || null },
      ], `time: delete ${this.user} ${file.month}`, { remove: [file.entries[located]] });
      const saved = parseMonthlyRecords(serializeMonthlyRecords(entries), { user: this.user, month: file.month, path, sha: blobShas[path] ?? null });
      if (updateCache) {
        const state = await this.store.getState();
        await this.store.patchState({ recentCache: replaceCachedDeletedFile(state.recentCache, saved, path),
          dayRangeIntervals: updateDayRangeIntervals(state.dayRangeIntervals, [], [file.entries[located].id]) });
      }
      return { deleted: true, entries: saved };
    } catch (error) { if (isConflict(error)) throw new TrackerConflictError('This monthly time file changed while deleting. Reload.'); throw error; }
  }

  async moveBoundary({ upper, lower }) {
    if (!upper || !lower) throw new Error('Two adjacent entries are required');
    const requests = [
      { ...upper, edits: { endedAt: upper.endedAt } },
      { ...lower, edits: { startedAt: lower.startedAt } },
    ];
    const files = new Map();
    for (const request of requests) {
      if (!files.has(request.path)) files.set(request.path, await this.readMonthly(request.path));
      const file = files.get(request.path);
      if (file.sha !== request.originalSha) throw new TrackerConflictError('A monthly time file changed after the panel loaded. Reload before moving the boundary.');
      request.position = locateEntry(file.entries, request.index, request.original);
      if (request.position < 0) throw new TrackerConflictError('An adjacent entry changed inside its monthly file. Reload before moving the boundary.');
    }
    if (requests[0].path === requests[1].path && requests[0].position === requests[1].position) throw new Error('Adjacent entries must be distinct');
    const originals = requests.map(request => files.get(request.path).entries[request.position]);
    const updated = requests.map((request, i) => applyEntryEdits(originals[i], request.edits, editClock(this.clock, originals[i])));
    updated[1].entryDate = startDate(updated[1]);
    const upperDelta = new Date(updated[0].endedAt).getTime() - new Date(originals[0].endedAt).getTime();
    const lowerDelta = new Date(updated[1].startedAt).getTime() - new Date(originals[1].startedAt).getTime();
    if (upperDelta !== lowerDelta) throw new Error('Both sides of an adjacent boundary must move by the same amount');
    const targetPaths = [requests[0].path, monthlyRecordsPath(this.user, updated[1].entryDate)];
    for (const targetPath of targetPaths) if (!files.has(targetPath)) files.set(targetPath, await this.readMonthly(targetPath));
    for (let i = 0; i < requests.length; i += 1) {
      const request = requests[i], targetPath = targetPaths[i], source = files.get(request.path);
      if (targetPath === request.path) source.entries[request.position] = updated[i];
      else { source.entries.splice(request.position, 1); files.get(targetPath).entries.push(updated[i]); }
    }
    const touched = [...new Set([...requests.map(request => request.path), ...targetPaths])].map(path => files.get(path));
    const resultLocations = updated.map((entry, index) => ({ path: targetPaths[index], index: files.get(targetPaths[index]).entries.indexOf(entry) }));
    try {
      const changes = touched.map(file => ({ path: file.path, sha: file.sha, text: serializeMonthlyRecords(file.entries) || null }));
      const { blobShas } = await this.updateCompletedRecords(changes, `time: move boundary ${this.user}`, {
        remove: originals, add: updated,
      });
      const savedByPath = new Map(touched.map(file => [file.path, parseMonthlyRecords(serializeMonthlyRecords(file.entries), { user: this.user, month: file.month, path: file.path, sha: blobShas[file.path] ?? null })]));
      const replacements = [...savedByPath.values()].flat();
      const state = await this.store.getState(); await this.store.patchState({
        recentCache: replaceCachedFiles(state.recentCache, replacements, touched.map(file => file.path)),
        dayRangeIntervals: updateDayRangeIntervals(state.dayRangeIntervals, updated),
      });
      return resultLocations.map(location => savedByPath.get(location.path)[location.index]);
    } catch (error) {
      if (isConflict(error)) throw new TrackerConflictError('A monthly time file changed while the boundary was being saved. Reload.');
      throw error;
    }
  }

}
