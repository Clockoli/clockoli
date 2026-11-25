const DB = 'clockoli-file-url-probe-v1';
const statusElement = document.querySelector('#status');

async function openDatabase() {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('probe');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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

function check(rootValue, sampleValue, suffix) {
  const root = new URL(rootValue);
  const sample = new URL(sampleValue);
  if (root.protocol !== 'file:' || sample.protocol !== 'file:' || root.host || sample.host ||
      root.search || sample.search || root.hash || sample.hash || !root.pathname.endsWith(suffix) ||
      !sample.pathname.endsWith('.jsonl') || !sample.href.startsWith(root.href)) throw new Error('Invalid local root or sample URL');
  return { root: root.href, sample: sample.href };
}

function show(value) { statusElement.textContent = JSON.stringify(value, null, 2); }
async function worker(type) {
  const response = await chrome.runtime.sendMessage({ type });
  if (!response?.ok) throw new Error(response?.error || 'worker unavailable');
  show(response.status);
}

document.querySelector('#save').addEventListener('click', async () => {
  try {
    const codex = check(document.querySelector('#codex-root').value, document.querySelector('#codex-sample').value, '/sessions/');
    const claude = check(document.querySelector('#claude-root').value, document.querySelector('#claude-sample').value, '/projects/');
    await put('config', { codex, claude });
    show({ saved: true, pathsOmitted: true });
  } catch (error) { show({ error: error.message }); }
});
document.querySelector('#scan').addEventListener('click', () => worker('scan').catch(error => show({ error: error.message })));
document.querySelector('#refresh').addEventListener('click', () => worker('status').catch(error => show({ error: error.message })));
await worker('status').catch(error => show({ error: error.message }));
