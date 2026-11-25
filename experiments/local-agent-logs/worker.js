import { read, write } from './database.js';
import { scanJsonlFile } from './incremental.js';

const ALARM = 'read-only-local-log-scan';
const PROVIDERS = ['codex', 'claude'];
const MAX_ENTRIES = 20000;
const MAX_FILES = 5000;
const MAX_BYTES_PER_RUN = 64 * 1024 * 1024;
const MAX_BYTES_PER_FILE = 16 * 1024 * 1024;
let running = null;

async function keyFor(provider, relativeName) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${provider}:${relativeName}`));
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function* jsonlFiles(directory, path = '', depth = 0, budget = { entries: 0, files: 0 }) {
  if (depth > 5) return;
  for await (const [name, handle] of directory.entries()) {
    if (++budget.entries > MAX_ENTRIES) throw new Error('entry_limit');
    if (handle.kind === 'directory') {
      yield* jsonlFiles(handle, `${path}${name}/`, depth + 1, budget);
    } else if (handle.kind === 'file' && name.endsWith('.jsonl')) {
      if (++budget.files > MAX_FILES) throw new Error('file_limit');
      yield { handle, path: `${path}${name}` };
    }
  }
}

async function scanProvider(provider) {
  const status = { permission: 'not_selected', filesVisited: 0, filesAdvanced: 0, newLines: 0,
    bytesRead: 0, errorCount: 0, errorCode: null };
  const handle = await read('handles', provider);
  if (!handle) return status;
  try { status.permission = await handle.queryPermission({ mode: 'read' }); }
  catch (error) { status.permission = 'error'; status.errorCode = error.name; return status; }
  if (status.permission !== 'granted') return status; // Never prompt from background.
  try {
    for await (const entry of jsonlFiles(handle)) {
      status.filesVisited++;
      if (status.bytesRead >= MAX_BYTES_PER_RUN || status.filesAdvanced >= 128) {
        status.backlog = true;
        break;
      }
      const key = await keyFor(provider, entry.path);
      try {
        const file = await entry.handle.getFile();
        const previous = await read('cursors', key);
        if (previous && file.size === previous.offset && file.lastModified === previous.lastModified) continue;
        const result = await scanJsonlFile(file, previous, provider, {
          chunkBytes: MAX_BYTES_PER_FILE,
          maxBytes: Math.min(MAX_BYTES_PER_FILE, MAX_BYTES_PER_RUN - status.bytesRead),
        });
        if (result.bytesRead || result.restarted || !previous) {
          await write('cursors', key, result.cursor);
          status.filesAdvanced++;
          status.newLines += result.newLines;
          status.bytesRead += result.bytesRead;
        }
      } catch (error) {
        status.errorCount++;
        status.errorCode = error.name === 'NotAllowedError' ? 'permission_denied' :
          error.name === 'NotFoundError' ? 'file_disappeared' :
          error.message === 'JSONL line exceeds read chunk' ? 'line_too_large' : 'invalid_or_unreadable_file';
      }
    }
  } catch (error) {
    status.errorCount++;
    status.errorCode = error.message === 'entry_limit' || error.message === 'file_limit' ? error.message : 'directory_read_failed';
  }
  return status;
}

async function scan(trigger) {
  if (running) return running;
  running = (async () => {
    const previous = await read('status', 'latest');
    const status = { trigger, startedAt: new Date().toISOString(), runNumber: (previous?.runNumber || 0) + 1, providers: {} };
    for (const provider of PROVIDERS) status.providers[provider] = await scanProvider(provider);
    status.finishedAt = new Date().toISOString();
    await write('status', 'latest', status);
    return status;
  })();
  try { return await running; }
  finally { running = null; }
}

async function ensureAlarm() {
  if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => { void ensureAlarm().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void ensureAlarm().then(() => scan('startup')).catch(() => {}); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) void scan('alarm').catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const allowed = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('probe.html');
  if (!allowed || !['status', 'scan'].includes(message?.type)) return false;
  (async () => message.type === 'scan' ? scan('manual') : await read('status', 'latest') || null)()
    .then(status => sendResponse({ ok: true, status }))
    .catch(error => sendResponse({ ok: false, error: error.name || 'Error' }));
  return true;
});

// During a browser/CDP probe, this call also restores an alarm if Chrome dropped it.
void ensureAlarm().catch(() => {});
