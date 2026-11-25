const DB = 'clockoli-file-url-probe-v1';
const ALARM = 'file-url-read-only-scan';
const SAMPLE_BYTES = 4096;
const DIRECTORY_BYTES = 1024 * 1024;
let active;

async function openDatabase() {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('probe');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function get(key) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('probe', 'readonly').objectStore('probe').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

async function put(key, value) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('probe', 'readwrite');
      transaction.objectStore('probe').put(value, key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

function safeURL(value, expectedSuffix) {
  const url = new URL(value);
  if (url.protocol !== 'file:' || url.host || url.search || url.hash ||
      !url.pathname.endsWith(expectedSuffix) || url.pathname.includes('%00')) throw new Error('invalid_local_url');
  return url.href;
}

async function limitedText(response, maximum) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maximum) {
      const next = await reader.read();
      if (next.done) break;
      const part = next.value.slice(0, maximum - total);
      chunks.push(part);
      total += part.length;
      if (next.value.length > part.length) break;
    }
  } finally { await reader.cancel().catch(() => {}); }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

async function probeFile(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    const text = response.ok ? await limitedText(response, SAMPLE_BYTES) : '';
    return { ok: response.ok, status: response.status, bytesSampled: new TextEncoder().encode(text).length,
      completeLine: text.includes('\n') };
  } catch (error) { return { ok: false, error: error.name || 'Error' }; }
}

async function probeDirectory(root) {
  const result = { indexReadable: false, directoriesVisited: 0, entriesVisited: 0,
    jsonlFiles: 0, errors: 0, errorCode: null, backlog: false };
  const pending = [{ url: root, depth: 0 }];
  while (pending.length) {
    if (result.directoriesVisited >= 1000 || result.entriesVisited >= 20000) {
      result.backlog = true;
      break;
    }
    const { url, depth } = pending.shift();
    try {
      const response = await fetch(url, { cache: 'no-store' });
      // Chromium's file:// directory index is an HTML body with status 0, not a 200 response.
      const html = await limitedText(response, DIRECTORY_BYTES);
      if (!html.includes('function addRow(') || !html.includes('start(')) throw new Error('no_directory_index');
      result.indexReadable = true;
      result.directoriesVisited++;
      const rows = html.matchAll(/addRow\(("(?:\\.|[^"\\])*"),("(?:\\.|[^"\\])*"),([01]),/g);
      for (const row of rows) {
        if (++result.entriesVisited > 20000) { result.backlog = true; break; }
        let child;
        try {
          const relative = JSON.parse(row[2]);
          child = new URL(row[3] === '1' && !relative.endsWith('/') ? `${relative}/` : relative, url);
        } catch { continue; }
        if (child.protocol !== 'file:' || !child.href.startsWith(root) || child.href === url) continue;
        if (row[3] === '1' && child.pathname.endsWith('/')) {
          if (depth < 5) pending.push({ url: child.href, depth: depth + 1 });
          else result.backlog = true;
        } else if (row[3] === '0' && child.pathname.endsWith('.jsonl')) {
          result.jsonlFiles++;
        }
      }
    } catch (error) {
      result.errors++;
      result.errorCode = error.message === 'no_directory_index' ? 'no_directory_index' : error.name || 'Error';
    }
  }
  return result;
}

async function fileAccessEnabled() {
  if (!chrome.extension?.isAllowedFileSchemeAccess) return 'unavailable';
  return await new Promise(resolve => chrome.extension.isAllowedFileSchemeAccess(resolve));
}

async function scan(trigger) {
  if (active) return active;
  active = (async () => {
    const config = await get('config');
    const previous = await get('status');
    const status = { trigger, runNumber: (previous?.runNumber || 0) + 1, fileAccessEnabled: await fileAccessEnabled(),
      providers: {} };
    for (const [provider, suffix] of [['codex', '/sessions/'], ['claude', '/projects/']]) {
      if (!config?.[provider]) { status.providers[provider] = { configured: false }; continue; }
      try {
        const root = safeURL(config[provider].root, suffix);
        const sample = safeURL(config[provider].sample, '.jsonl');
        if (!sample.startsWith(root)) throw new Error('sample_outside_root');
        status.providers[provider] = { configured: true, listing: await probeDirectory(root), sample: await probeFile(sample) };
      } catch (error) { status.providers[provider] = { configured: true, error: error.message === 'sample_outside_root' ?
        'sample_outside_root' : 'invalid_local_url' }; }
    }
    await put('status', status);
    return status;
  })();
  try { return await active; } finally { active = null; }
}

async function ensureAlarm() {
  if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => { void ensureAlarm().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void ensureAlarm().then(() => scan('startup')).catch(() => {}); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void scan('alarm').catch(() => {}); });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('probe.html') ||
      !['status', 'scan'].includes(message?.type)) return false;
  (async () => message.type === 'scan' ? await scan('manual') : await get('status') || null)()
    .then(status => respond({ ok: true, status }))
    .catch(error => respond({ ok: false, error: error.name || 'Error' }));
  return true;
});
void ensureAlarm().catch(() => {});
