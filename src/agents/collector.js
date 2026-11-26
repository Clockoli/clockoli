import { scanAgentJsonl } from './jsonl-reader.js';
import { parseAgentRow, projectAgentTurns } from './parsers.js';
import { extractCodexMatchingRow, matchingEvidenceByTurn, matchingTasks, explainAgentMatch, MATCH_RULE_VERSION } from './task-matching.js';
import { markStaleOpenAgentTurns, summarizeAgentTurns, summarizeAgentWorkflow } from './metrics.js';
import {
  acquireAgentLease, beginAgentReindex, commitAgentBatch, forgetAgentRoot,
  getAgentHealth, getAgentProjection, getAgentRootState, getAgentSecret, getAgentState,
  listAgentFiles, pruneAgentGenerations, releaseAgentLease, setAgentHealth, setAgentPaused,
} from '../storage/agent-activity-store.js';

export const AGENT_ALARM = 'agent-activity-collector';
export const AGENT_PARSER_VERSION = 1;
// Projection-only changes can be rebuilt from sanitized evidence without re-reading JSONL.
const AGENT_PROJECTION_VERSION = 1;
const PROVIDERS = ['codex', 'claude'];
const MAX_ENTRIES = 20_000, MAX_FILES = 5_000, MAX_DEPTH = 6;
const MAX_RUN_BYTES = 64 * 1024 * 1024, MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILES_PER_RUN = 128, NATIVE_TIMEOUT_MS = 20_000, COOLDOWN_MS = 5 * 60_000;
const pendingNative = new Map();
let running = null;
let runningProviders = null;

function safeCode(error) {
  if (error?.message === 'fsa_timeout') return 'fsa_timeout';
  if (error?.name === 'NotAllowedError') return 'permission_denied';
  if (error?.name === 'NotFoundError') return 'file_disappeared';
  if (error?.message === 'entry_limit' || error?.message === 'file_limit') return error.message;
  if (error?.message === 'agent_revision_conflict' || error?.message === 'agent_root_changed') return error.message;
  return 'source_unavailable';
}
function boundedNative(provider, operation) {
  if (pendingNative.has(provider)) return Promise.reject(new Error('fsa_timeout'));
  const pending = Promise.resolve().then(operation);
  pendingNative.set(provider, pending);
  void pending.finally(() => { if (pendingNative.get(provider) === pending) pendingNative.delete(provider); }).catch(() => {});
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fsa_timeout')), NATIVE_TIMEOUT_MS);
    pending.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
async function* walk(directory, prefix = '', depth = 0, budget = { entries: 0, files: 0 }) {
  if (depth > MAX_DEPTH) throw new Error('entry_limit');
  for await (const [name, handle] of directory.entries()) {
    if (++budget.entries > MAX_ENTRIES) throw new Error('entry_limit');
    if (handle.kind === 'directory') yield* walk(handle, `${prefix}${name}/`, depth + 1, budget);
    else if (handle.kind === 'file' && name.endsWith('.jsonl')) {
      if (++budget.files > MAX_FILES) throw new Error('file_limit');
      yield { handle, relativePath: `${prefix}${name}` };
    }
  }
}
async function keyer(provider) {
  const raw = await getAgentSecret();
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const encoder = new TextEncoder();
  const cache = new Map();
  async function hash(scope, value) {
    if (typeof value !== 'string' || !value) return null;
    const source = `${provider}:${scope}:${value}`;
    if (cache.has(source)) return cache.get(source);
    const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(source)));
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    cache.set(source, hex);
    return hex;
  }
  async function fingerprint(bytes) {
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
    return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  return { hash, fingerprint };
}
async function opaqueEvent(provider, event, fileKey, previousSession, hash) {
  if (event.type === 'session_meta') {
    const sessionId = await hash('session', event.sessionId);
    return { event: null, sessionId: sessionId || previousSession };
  }
  if (event.type === 'turn_context') return { event: null, sessionId: previousSession };
  const sessionId = provider === 'codex' ? previousSession || fileKey
    : await hash('session', event.sessionId) || fileKey;
  const safe = { type: event.type, timestamp: event.timestamp, fileKey, sessionId };
  for (const [name, scope] of [['turnId', 'turn'], ['uuid', 'uuid'], ['parentUuid', 'uuid'], ['agentId', 'agent']]) {
    if (event[name]) safe[name] = await hash(scope, event[name]);
  }
  if (Number.isSafeInteger(event.durationMs) && event.durationMs >= 0) safe.durationMs = event.durationMs;
  return { event: safe, sessionId: previousSession };
}
function healthFor(root, previous, trigger) {
  return { connected: true, paused: Boolean(root.paused), permission: previous?.permission || 'unknown',
    filesVisited: 0, filesAdvanced: 0, bytesRead: 0, scannedBytes: 0, blockedFiles: 0,
    errorCode: null, errorCount: 0, backlog: false, pendingBytes: 0,
    runNumber: (previous?.runNumber || 0) + 1, trigger, startedAt: new Date().toISOString(),
    lastFileKey: previous?.lastFileKey || null, retryAt: null, complete: false };
}
async function scanProvider(provider, trigger) {
  const root = await getAgentRootState(provider);
  if (!root) return { connected: false, paused: false, permission: 'not_selected', complete: false };
  const previousHealth = await getAgentHealth(provider);
  if (root.paused) return { ...healthFor(root, previousHealth, trigger), permission: 'paused', paused: true };
  if (trigger === 'alarm' && (previousHealth?.permission === 'prompt' || previousHealth?.permission === 'denied'
      || previousHealth?.retryAt > Date.now())) return previousHealth;
  const status = healthFor(root, previousHealth, trigger);
  const lease = await acquireAgentLease(provider, root.rootId);
  if (!lease) return { ...status, errorCode: 'scan_busy', backlog: true };
  try {
    status.permission = await boundedNative(provider, () => root.handle.queryPermission({ mode: 'read' }));
    if (status.permission !== 'granted') { status.errorCode = 'access_required'; return status; }
    const { hash, fingerprint } = await keyer(provider);
    const state = await getAgentState(provider);
    if (state.activeGeneration > AGENT_PARSER_VERSION || state.desiredGeneration > AGENT_PARSER_VERSION) {
      status.errorCode = 'parser_version_unsupported'; return status;
    }
    if (state.activeGeneration < AGENT_PARSER_VERSION && state.desiredGeneration !== AGENT_PARSER_VERSION) {
      await beginAgentReindex(provider, AGENT_PARSER_VERSION);
    }
    const generation = AGENT_PARSER_VERSION;
    const saved = await listAgentFiles(provider, generation);
    const savedByKey = new Map(saved.map(file => [file.fileKey, file]));
    const entries = [];
    await boundedNative(provider, async () => {
      for await (const entry of walk(root.handle)) {
        const fileKey = await hash('path', entry.relativePath);
        entries.push({ fileKey, handle: entry.handle });
      }
    });
    entries.sort((a, b) => a.fileKey.localeCompare(b.fileKey));
    const firstAfter = entries.findIndex(entry => entry.fileKey > (previousHealth?.lastFileKey || ''));
    const ordered = firstAfter < 0 ? entries : [...entries.slice(firstAfter), ...entries.slice(0, firstAfter)];
    const changes = new Map();
    const seen = new Set(entries.map(entry => entry.fileKey));
    // A successful enumeration is the evidence of disappearance. Keep the
    // sanitized events, not the source bytes, so linked Claude turns survive.
    const previousGeneration = state.activeGeneration && state.activeGeneration !== generation
      ? await listAgentFiles(provider, state.activeGeneration) : [];
    const archiveCandidates = new Map(previousGeneration.map(file => [file.fileKey, file]));
    for (const file of saved) {
      const previous = archiveCandidates.get(file.fileKey);
      // If a source vanishes mid-reindex, prefer the last complete evidence
      // to an incomplete staging record. Never concatenate two generations.
      if (!previous || file.sourceMissing || file.cursor?.offset === file.cursor?.size
          || previous.cursor?.offset !== previous.cursor?.size) archiveCandidates.set(file.fileKey, file);
    }
    for (const old of archiveCandidates.values()) {
      if (seen.has(old.fileKey)) continue;
      const current = savedByKey.get(old.fileKey);
      if (current === old && old.sourceMissing) continue;
      changes.set(old.fileKey, { ...old, sourceMissing: true,
        evidenceGeneration: old.evidenceGeneration ?? old.generation,
        expectedRevision: current?.revision || 0 });
    }
    for (const entry of ordered) {
      status.filesVisited++;
      if (status.bytesRead >= MAX_RUN_BYTES || status.filesAdvanced >= MAX_FILES_PER_RUN) {
        status.backlog = true; break;
      }
      let file;
      try { file = await boundedNative(provider, () => entry.handle.getFile()); }
      catch (error) { status.errorCount++; status.errorCode = safeCode(error); status.backlog = true;
        if (status.errorCode === 'permission_denied') status.permission = 'denied';
        if (status.errorCode === 'fsa_timeout' || status.errorCode === 'permission_denied') break;
        continue; }
      status.scannedBytes += file.size;
      const old = savedByKey.get(entry.fileKey);
      const reusable = old && (old.evidenceGeneration ?? generation) === generation;
      if (reusable && !old.sourceMissing && old.cursor?.safeErrorCode && old.cursor.size === file.size
          && old.cursor.lastModified === file.lastModified) {
        status.blockedFiles++; continue;
      }
      const fullValidation = status.runNumber % 60 === 0;
      if (reusable && !old.sourceMissing && old.cursor?.size === file.size && old.cursor.lastModified === file.lastModified
          && (old.cursor.offset === file.size || old.cursor.pendingTail) && !fullValidation) {
        if (old.cursor.offset < file.size) { status.backlog = true; status.pendingBytes += file.size - old.cursor.offset; }
        continue;
      }
      const remaining = MAX_RUN_BYTES - status.bytesRead;
      if (remaining < MAX_FILE_BYTES && status.bytesRead > 0) { status.backlog = true; break; }
      try {
        const result = await boundedNative(provider, () => scanAgentJsonl(file, reusable ? old.cursor : null, {
          readBudget: Math.min(MAX_FILE_BYTES, remaining), maxLineBytes: MAX_FILE_BYTES,
          parseRow: row => {
            const event = parseAgentRow(provider, row);
            return event.type === 'unknown_event' ? { kind: 'unknown' } : event;
          }, fingerprint,
          deadlineAt: Date.now() + 17_000,
        }));
        const replaceEvidence = !reusable || result.restarted;
        let currentSession = replaceEvidence ? null : old?.cursor?.sessionId || null;
        const newEvents = [];
        for (const event of result.events) {
          const opaque = await opaqueEvent(provider, event, entry.fileKey, currentSession, hash);
          currentSession = opaque.sessionId;
          if (opaque.event) newEvents.push(opaque.event);
        }
        const cursor = { ...result.cursor, sessionId: currentSession,
          safeErrorCode: result.blockedCode,
          pendingTail: result.atEnd && result.cursor.offset < file.size && !result.blockedCode };
        changes.set(entry.fileKey, { fileKey: entry.fileKey, expectedRevision: old?.revision || 0,
          cursor, sourceMissing: false, evidenceGeneration: generation,
          events: [...replaceEvidence ? [] : old?.events || [], ...newEvents],
          unknownEvents: (replaceEvidence ? 0 : old?.unknownEvents || 0) + result.unknownEvents });
        status.bytesRead += result.bytesRead;
        status.filesAdvanced++;
        status.lastFileKey = entry.fileKey;
        if (result.blockedCode) { status.blockedFiles++; status.errorCode = result.blockedCode; status.errorCount++; }
        if (result.backlog) { status.backlog = true; status.pendingBytes += file.size - cursor.offset; }
      } catch (error) {
        status.errorCode = safeCode(error); status.errorCount++; status.backlog = true;
        if (status.errorCode === 'permission_denied') status.permission = 'denied';
        if (status.errorCode === 'fsa_timeout' || status.errorCode === 'permission_denied') break;
      }
    }
    const existingProjection = await getAgentProjection(provider, generation);
    const merged = new Map(savedByKey);
    for (const file of changes.values()) {
      if (file.remove) merged.delete(file.fileKey);
      else merged.set(file.fileKey, file);
    }
    // Reuse the persisted projection on unchanged scans. Rebuild once when
    // its interpretation changes, using existing sanitized event evidence.
    const rebuild = changes.size > 0 || existingProjection?.projectionVersion !== AGENT_PROJECTION_VERSION;
    let projection = existingProjection;
    if (rebuild) {
      const events = [...merged.values()].flatMap(file => file.events || []);
      projection = projectAgentTurns(provider, events);
      projection.unknownEvents += [...merged.values()].reduce((total, file) => total + (file.unknownEvents || 0), 0);
      projection.projectionVersion = AGENT_PROJECTION_VERSION;
      const archived = [...merged.values()].filter(file => file.sourceMissing);
      projection.archivedFiles = archived.length;
      projection.archivedIncompleteFiles = archived.filter(file => file.cursor?.offset !== file.cursor?.size || file.cursor?.safeErrorCode).length;
      projection.archivedOlderParserFiles = archived.filter(file => file.evidenceGeneration !== generation).length;
    }
    const complete = !status.backlog && status.blockedFiles === 0 && status.errorCount === 0
      && status.filesVisited === entries.length && [...merged.values()].every(file => file.sourceMissing || file.cursor?.offset === file.cursor?.size);
    // A missing source cannot be re-read. Activate the available projection,
    // but do not claim complete coverage of historical evidence that was partial.
    status.complete = complete && !projection.archivedIncompleteFiles && !projection.archivedOlderParserFiles;
    if (status.errorCount && status.errorCode !== 'agent_revision_conflict') {
      status.retryAt = Date.now() + COOLDOWN_MS;
    }
    if (rebuild || (complete && state.activeGeneration !== generation)) {
      await commitAgentBatch({ provider, rootId: root.rootId, generation, files: [...changes.values()],
        projection, expectedProjectionRevision: existingProjection?.revision || 0,
        activate: complete && state.activeGeneration !== generation });
    }
    if (complete && generation > 1) await pruneAgentGenerations(provider, generation, root.rootId);
    status.parserGeneration = generation;
    status.activeGeneration = complete ? generation : state.activeGeneration;
    status.discovered = projection.turns.length;
    status.unknownEvents = projection.unknownEvents;
    status.finishedAt = new Date().toISOString();
    return status;
  } catch (error) {
    status.errorCode = safeCode(error);
    status.errorCount++;
    status.backlog = true;
    if (status.errorCode === 'permission_denied') status.permission = 'denied';
    if (status.errorCode !== 'agent_revision_conflict') status.retryAt = Date.now() + COOLDOWN_MS;
    return status;
  } finally {
    await releaseAgentLease(provider, lease).catch(() => {});
    status.finishedAt ||= new Date().toISOString();
    await setAgentHealth(provider, root.rootId, status).catch(() => {});
  }
}
export async function ensureAgentAlarm() {
  const connected = await Promise.all(PROVIDERS.map(getAgentRootState));
  if (connected.some(root => root && !root.paused)) {
    if (!await chrome.alarms.get(AGENT_ALARM)) await chrome.alarms.create(AGENT_ALARM, { periodInMinutes: 1 });
  } else await chrome.alarms.clear(AGENT_ALARM);
}
export async function scanAgentActivity(trigger = 'manual', onlyProvider = null) {
  if (onlyProvider !== null && !PROVIDERS.includes(onlyProvider)) throw new TypeError('Unknown agent provider');
  if (running) {
    const includesProvider = onlyProvider === null ? runningProviders?.size === PROVIDERS.length
      : runningProviders?.has(onlyProvider);
    const current = await running;
    return includesProvider ? current : scanAgentActivity(trigger, onlyProvider);
  }
  runningProviders = new Set(onlyProvider ? [onlyProvider] : PROVIDERS);
  running = (async () => {
    const providers = {};
    for (const provider of runningProviders) providers[provider] = await scanProvider(provider, trigger);
    return { providers };
  })();
  try { return await running; }
  finally { running = null; runningProviders = null; }
}
export async function getAgentCollectorStatus(workflow = null) {
  const providers = {}, allTurns = [], scan = {};
  for (const provider of PROVIDERS) {
    const root = await getAgentRootState(provider);
    const health = await getAgentHealth(provider);
    const state = await getAgentState(provider);
    const visibleGeneration = state.activeGeneration || state.desiredGeneration;
    const projection = root ? await getAgentProjection(provider, visibleGeneration) : null;
    const safeHealth = { connected: Boolean(root), paused: Boolean(root?.paused),
      permission: root ? health?.permission || 'unknown' : 'not_selected',
      filesVisited: health?.filesVisited || 0, filesAdvanced: health?.filesAdvanced || 0,
      bytesRead: health?.bytesRead || 0, blockedFiles: health?.blockedFiles || 0,
      backlog: Boolean(health?.backlog), errorCode: health?.errorCode || null,
      runNumber: health?.runNumber || 0, scannedBytes: health?.scannedBytes || 0,
      parserGeneration: visibleGeneration, activeGeneration: state.activeGeneration,
      complete: Boolean(!root?.paused && health?.complete && state.activeGeneration === visibleGeneration),
      archivedFiles: projection?.archivedFiles || 0,
      archivedIncompleteFiles: projection?.archivedIncompleteFiles || 0,
      archivedOlderParserFiles: projection?.archivedOlderParserFiles || 0,
      pendingBytes: health?.pendingBytes || 0, retryAt: health?.retryAt || null,
      startedAt: health?.startedAt || null, finishedAt: health?.finishedAt || null };
    providers[provider] = safeHealth;
    scan[provider] = { complete: safeHealth.complete, blockedFiles: safeHealth.blockedFiles,
      unknownEvents: projection?.unknownEvents || 0, pendingBytes: safeHealth.pendingBytes,
      parserGeneration: visibleGeneration, scannedFiles: safeHealth.filesVisited,
      scannedBytes: safeHealth.scannedBytes, archivedFiles: safeHealth.archivedFiles,
      archivedIncompleteFiles: safeHealth.archivedIncompleteFiles, archivedOlderParserFiles: safeHealth.archivedOlderParserFiles };
    if (projection?.turns) allTurns.push(...projection.turns);
  }
  scan.all = {
    complete: PROVIDERS.every(provider => scan[provider].complete),
    blockedFiles: PROVIDERS.reduce((total, provider) => total + scan[provider].blockedFiles, 0),
    unknownEvents: PROVIDERS.reduce((total, provider) => total + scan[provider].unknownEvents, 0),
    pendingBytes: PROVIDERS.reduce((total, provider) => total + scan[provider].pendingBytes, 0),
    scannedFiles: PROVIDERS.reduce((total, provider) => total + scan[provider].scannedFiles, 0),
    scannedBytes: PROVIDERS.reduce((total, provider) => total + scan[provider].scannedBytes, 0),
    parserGeneration: AGENT_PARSER_VERSION,
    archivedFiles: PROVIDERS.reduce((total, provider) => total + scan[provider].archivedFiles, 0),
    archivedIncompleteFiles: PROVIDERS.reduce((total, provider) => total + scan[provider].archivedIncompleteFiles, 0),
    archivedOlderParserFiles: PROVIDERS.reduce((total, provider) => total + scan[provider].archivedOlderParserFiles, 0),
  };
  const turns = markStaleOpenAgentTurns(allTurns);
  if (workflow) return {
    providers: Object.fromEntries(PROVIDERS.map(provider => {
      const { connected, paused, permission, complete } = providers[provider];
      return [provider, { connected, paused, permission, complete }];
    })),
    workflow: summarizeAgentWorkflow(turns, workflow),
  };
  return { providers, coverage: summarizeAgentTurns(turns, scan) };
}
export async function controlAgentCollector(provider, action) {
  if (!PROVIDERS.includes(provider) || !['scan', 'pause', 'resume', 'forget'].includes(action)) {
    throw new TypeError('Invalid agent collector action');
  }
  if (action === 'forget') await forgetAgentRoot(provider);
  if (action === 'pause' || action === 'resume') await setAgentPaused(provider, action === 'pause');
  await ensureAgentAlarm();
  if (action === 'scan' || action === 'resume') await scanAgentActivity('manual', provider);
  return getAgentCollectorStatus();
}

// An explicit diagnostic, not another continuous collector. Re-read only files
// containing already observed turns for the selected day. No new persisted
// fields, reindex, raw prompt export, or automatic writes to time records.
export async function getAgentMatchingDiagnostics(records, dayStart, dayEnd, { partial = false, thresholdMinutes = 15 } = {}) {
  const tasks = matchingTasks(records, dayStart, dayEnd);
  const taskLimit = 100;
  if (tasks.length > taskLimit) throw new Error('Too many task candidates for a single day');
  const dayTurns = [], providers = {};
  for (const provider of PROVIDERS) {
    const root = await getAgentRootState(provider);
    const state = await getAgentState(provider);
    const health = await getAgentHealth(provider);
    const projection = root ? await getAgentProjection(provider, state.activeGeneration || state.desiredGeneration) : null;
    providers[provider] = { connected: Boolean(root), complete: Boolean(root && health?.complete && !root.paused),
      permission: health?.permission || 'unknown' };
    for (const turn of projection?.turns || []) {
      const date = Date.parse(turn.startedAt ?? turn.endedAt);
      if (date >= dayStart && date < dayEnd) dayTurns.push(turn);
    }
  }
  dayTurns.sort((a, b) => Date.parse(a.startedAt ?? a.endedAt) - Date.parse(b.startedAt ?? b.endedAt) || a.key.localeCompare(b.key));
  const selected = dayTurns.slice(0, 300);
  const evidence = new Map(), sourceStatus = new Map();
  const codexTurns = selected.filter(turn => turn.provider === 'codex');
  const wanted = new Set(codexTurns.map(turn => turn.sourceFileKey));
  let bytesRead = 0;
  const root = wanted.size ? await getAgentRootState('codex') : null;
  if (root && !root.paused) {
    try {
      const permission = await boundedNative('codex', () => root.handle.queryPermission({ mode: 'read' }));
      if (permission !== 'granted') throw new Error('permission_denied');
      const { hash, fingerprint } = await keyer('codex');
      const selectedFiles = [];
      await boundedNative('codex', async () => {
        for await (const entry of walk(root.handle)) {
          const fileKey = await hash('path', entry.relativePath);
          if (wanted.has(fileKey)) selectedFiles.push({ fileKey, handle: entry.handle });
        }
      });
      for (const entry of selectedFiles.sort((a, b) => a.fileKey.localeCompare(b.fileKey))) {
        try {
          const file = await boundedNative('codex', () => entry.handle.getFile());
          if (file.size > MAX_FILE_BYTES) { sourceStatus.set(entry.fileKey, 'source_file_too_large'); continue; }
          if (bytesRead + file.size > MAX_RUN_BYTES) { sourceStatus.set(entry.fileKey, 'diagnostic_byte_limit'); continue; }
          const scan = await boundedNative('codex', () => scanAgentJsonl(file, null, {
            readBudget: MAX_FILE_BYTES, maxLineBytes: MAX_FILE_BYTES, fingerprint,
            parseRow: extractCodexMatchingRow, deadlineAt: Date.now() + 17_000,
          }));
          bytesRead += scan.bytesRead;
          if (scan.blockedCode || scan.backlog) { sourceStatus.set(entry.fileKey, 'source_scan_incomplete'); continue; }
          for (const item of matchingEvidenceByTurn(scan.events)) {
            const sessionId = await hash('session', item.sessionId);
            const turnId = await hash('turn', item.turnId);
            evidence.set(JSON.stringify([entry.fileKey, sessionId, turnId]), item);
          }
          sourceStatus.set(entry.fileKey, 'read');
        } catch (error) {
          sourceStatus.set(entry.fileKey, safeCode(error));
          if (safeCode(error) === 'fsa_timeout') break;
        }
      }
    } catch (error) {
      for (const fileKey of wanted) sourceStatus.set(fileKey, error?.message === 'permission_denied' ? 'permission_denied' : safeCode(error));
    }
  }
  // A root may be forgotten/replaced while this read-only diagnostic runs.
  // Never return evidence gathered from a disconnected or superseded root.
  const currentRoot = root ? await getAgentRootState('codex') : null;
  if (root && (currentRoot?.rootId !== root.rootId || currentRoot.paused)) {
    evidence.clear();
    for (const fileKey of wanted) sourceStatus.set(fileKey, 'source_access_changed');
  }
  const byTask = new Map(tasks.map(task => [task.url, []]));
  const rows = selected.map(turn => {
    const sessionId = (() => { try { return JSON.parse(turn.sessionKey)[2]; } catch { return null; } })();
    const item = turn.provider === 'codex' ? evidence.get(JSON.stringify([turn.sourceFileKey, sessionId, turn.upstreamTurnId])) : null;
    const reason = turn.provider !== 'codex' ? 'provider_matching_not_supported'
      : sourceStatus.get(turn.sourceFileKey) === 'read' ? 'turn_evidence_missing'
      : sourceStatus.get(turn.sourceFileKey) || (root?.paused ? 'source_paused' : 'source_missing');
    const match = explainAgentMatch(turn, item ?? { error: reason }, tasks, { partial });
    if (match.matchedUrl) byTask.get(match.matchedUrl)?.push(turn);
    return { turnId: turn.upstreamTurnId, provider: turn.provider, startedAt: turn.startedAt, endedAt: turn.endedAt,
      elapsedMs: turn.elapsedMs, status: turn.status, ...match };
  });
  return { ruleVersion: MATCH_RULE_VERSION, providers, totalTurns: dayTurns.length, omittedTurns: dayTurns.length - selected.length,
    bytesRead, partial, tasks: tasks.map(task => ({
      ...task, summary: summarizeAgentWorkflow(byTask.get(task.url), { period: 'all', provider: 'all', thresholdMinutes }),
    })), rows };
}
