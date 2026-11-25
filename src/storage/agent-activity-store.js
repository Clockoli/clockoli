// Agent observations live in a separate extension-origin database, never ChromeStore's backup map.
const NAME = 'clockoli-agent-activity-v1';
const PROVIDERS = new Set(['codex', 'claude']);
let databasePromise = null;

function providerKey(provider) {
  if (!PROVIDERS.has(provider)) throw new TypeError('Unknown agent provider');
  return provider;
}
function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Agent storage read failed'));
  });
}
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('Agent storage transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('Agent storage transaction failed'));
  });
}
export async function openAgentDb() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(NAME, 1);
      request.onupgradeneeded = () => {
        for (const store of ['roots', 'files', 'projections', 'meta']) {
          if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); databasePromise = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error('Agent storage open failed'));
    }).catch(error => { databasePromise = null; throw error; });
  }
  return databasePromise;
}
async function read(store, key) {
  const db = await openAgentDb();
  const tx = db.transaction(store, 'readonly');
  const done = transactionDone(tx);
  const value = await requestResult(tx.objectStore(store).get(key));
  await done;
  return value;
}
function prefixRange(provider) { return IDBKeyRange.bound(`${provider}:`, `${provider}:\uffff`); }
function eraseProvider(tx, provider) {
  for (const name of ['files', 'projections']) tx.objectStore(name).delete(prefixRange(provider));
  tx.objectStore('meta').delete(`state:${provider}`);
  tx.objectStore('meta').delete(`status:${provider}`);
  tx.objectStore('meta').delete(`lease:${provider}`);
}
export async function getAgentRootState(provider) { return await read('roots', providerKey(provider)) || null; }
export async function getAgentRoot(provider) { return (await getAgentRootState(provider))?.handle || null; }
export async function setAgentRoot(provider, handle) {
  providerKey(provider);
  if (handle?.kind !== 'directory') throw new TypeError('A directory must be selected');
  const db = await openAgentDb();
  const tx = db.transaction(['roots', 'files', 'projections', 'meta'], 'readwrite');
  const done = transactionDone(tx);
  eraseProvider(tx, provider);
  tx.objectStore('roots').put({ handle, paused: false, rootId: crypto.randomUUID() }, provider);
  await done;
}
export async function setAgentPaused(provider, paused) {
  providerKey(provider);
  if (typeof paused !== 'boolean') throw new TypeError('Invalid pause state');
  const db = await openAgentDb();
  const tx = db.transaction('roots', 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore('roots');
  const root = await requestResult(store.get(provider));
  if (!root) { tx.abort(); try { await done; } catch { /* intentional */ } throw new Error('Agent root is not connected'); }
  store.put({ ...root, paused }, provider);
  await done;
}
export async function forgetAgentRoot(provider) {
  providerKey(provider);
  const db = await openAgentDb();
  const tx = db.transaction(['roots', 'files', 'projections', 'meta'], 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore('roots').delete(provider);
  eraseProvider(tx, provider);
  await done;
}
export async function resetAgentActivity() {
  const db = await openAgentDb();
  const tx = db.transaction(['roots', 'files', 'projections', 'meta'], 'readwrite');
  const done = transactionDone(tx);
  for (const name of ['roots', 'files', 'projections', 'meta']) tx.objectStore(name).clear();
  await done;
}
export async function getAgentSecret() {
  const db = await openAgentDb();
  const tx = db.transaction('meta', 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore('meta');
  let secret = await requestResult(store.get('secret'));
  if (!secret) { secret = crypto.getRandomValues(new Uint8Array(32)); store.put(secret, 'secret'); }
  await done;
  return secret;
}
export async function getAgentState(provider) { return await read('meta', `state:${providerKey(provider)}`) || { activeGeneration: 0, desiredGeneration: 1 }; }
export async function getAgentHealth(provider) { return await read('meta', `status:${providerKey(provider)}`) || null; }
export async function setAgentHealth(provider, rootId, health) {
  providerKey(provider);
  const db = await openAgentDb();
  const tx = db.transaction(['roots', 'meta'], 'readwrite');
  const done = transactionDone(tx);
  const root = await requestResult(tx.objectStore('roots').get(provider));
  if (root?.rootId === rootId) tx.objectStore('meta').put(health, `status:${provider}`);
  await done;
}
export async function listAgentFiles(provider, generation) {
  providerKey(provider);
  const db = await openAgentDb();
  const tx = db.transaction('files', 'readonly');
  const done = transactionDone(tx);
  const values = await requestResult(tx.objectStore('files').getAll(prefixRange(`${provider}:${generation}`)));
  await done;
  return values;
}
export async function getAgentProjection(provider, generation) {
  return await read('projections', `${providerKey(provider)}:${generation}`) || null;
}
export async function commitAgentBatch({ provider, rootId, generation, files, projection, expectedProjectionRevision, activate = false }) {
  providerKey(provider);
  if (!Number.isSafeInteger(generation) || generation < 1 || !Array.isArray(files)) throw new TypeError('Invalid agent batch');
  const db = await openAgentDb();
  const tx = db.transaction(['roots', 'files', 'projections', 'meta'], 'readwrite');
  const done = transactionDone(tx);
  const fileStore = tx.objectStore('files'), projectionStore = tx.objectStore('projections'), stateStore = tx.objectStore('meta');
  const projectionKey = `${provider}:${generation}`;
  try {
    const root = await requestResult(tx.objectStore('roots').get(provider));
    if (!root || root.rootId !== rootId || root.paused) throw new Error('agent_root_changed');
    const currentProjection = await requestResult(projectionStore.get(projectionKey));
    if ((currentProjection?.revision || 0) !== expectedProjectionRevision) throw new Error('agent_revision_conflict');
    const currentFiles = await Promise.all(files.map(file => requestResult(fileStore.get(`${provider}:${generation}:${file.fileKey}`))));
    if (files.some((file, index) => (currentFiles[index]?.revision || 0) !== file.expectedRevision)) throw new Error('agent_revision_conflict');
    const state = await requestResult(stateStore.get(`state:${provider}`)) || { activeGeneration: 0, desiredGeneration: 1 };
    if (state.desiredGeneration !== generation) throw new Error('agent_generation_conflict');
    for (const file of files) {
      const key = `${provider}:${generation}:${file.fileKey}`;
      if (file.remove) { fileStore.delete(key); continue; }
      fileStore.put({ provider, generation, fileKey: file.fileKey, cursor: file.cursor,
        events: file.events, unknownEvents: file.unknownEvents || 0,
        sourceMissing: Boolean(file.sourceMissing), evidenceGeneration: file.evidenceGeneration ?? generation,
        revision: file.expectedRevision + 1 }, key);
    }
    projectionStore.put({ provider, generation, revision: expectedProjectionRevision + 1,
      turns: projection.turns, sessions: projection.sessions,
      projectionVersion: projection.projectionVersion ?? 0,
      archivedFiles: projection.archivedFiles || 0,
      archivedIncompleteFiles: projection.archivedIncompleteFiles || 0,
      archivedOlderParserFiles: projection.archivedOlderParserFiles || 0,
      unknownEvents: projection.unknownEvents || 0 }, projectionKey);
    if (activate) stateStore.put({ ...state, activeGeneration: generation }, `state:${provider}`);
    await done;
  } catch (error) {
    try { tx.abort(); } catch { /* transaction may already be closed */ }
    try { await done; } catch { /* preserve original conflict/error */ }
    throw error;
  }
}
export async function beginAgentReindex(provider, targetGeneration) {
  providerKey(provider);
  const db = await openAgentDb();
  const tx = db.transaction('meta', 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore('meta');
  const state = await requestResult(store.get(`state:${provider}`)) || { activeGeneration: 0, desiredGeneration: 1 };
  if (targetGeneration <= state.activeGeneration || !Number.isSafeInteger(targetGeneration)) {
    tx.abort(); try { await done; } catch { /* intentional */ }
    throw new Error('Invalid parser generation');
  }
  store.put({ ...state, desiredGeneration: targetGeneration }, `state:${provider}`);
  await done;
}
export async function pruneAgentGenerations(provider, keepGeneration, rootId) {
  providerKey(provider);
  const db = await openAgentDb();
  const tx = db.transaction(['roots', 'files', 'projections', 'meta'], 'readwrite');
  const done = transactionDone(tx);
  try {
    const root = await requestResult(tx.objectStore('roots').get(provider));
    const state = await requestResult(tx.objectStore('meta').get(`state:${provider}`));
    if (root?.rootId !== rootId || state?.activeGeneration !== keepGeneration) {
      throw new Error('agent_generation_conflict');
    }
    for (const name of ['files', 'projections']) {
      const store = tx.objectStore(name);
      const keys = await requestResult(store.getAllKeys(prefixRange(provider)));
      for (const key of keys) {
        if (Number(key.slice(provider.length + 1).split(':')[0]) !== keepGeneration) store.delete(key);
      }
    }
    await done;
  } catch (error) {
    try { tx.abort(); } catch { /* transaction may already be closed */ }
    try { await done; } catch { /* preserve cause */ }
    throw error;
  }
}
export async function acquireAgentLease(provider, rootId, lifetimeMs = 120_000) {
  providerKey(provider);
  const db = await openAgentDb();
  const tx = db.transaction(['roots', 'meta'], 'readwrite');
  const done = transactionDone(tx);
  const root = await requestResult(tx.objectStore('roots').get(provider));
  const store = tx.objectStore('meta');
  const previous = await requestResult(store.get(`lease:${provider}`));
  const now = Date.now();
  let token = null;
  if (root?.rootId === rootId && !root.paused && !(previous?.expiresAt > now)) {
    token = crypto.randomUUID();
    store.put({ token, rootId, expiresAt: now + lifetimeMs }, `lease:${provider}`);
  }
  await done;
  return token;
}
export async function releaseAgentLease(provider, token) {
  providerKey(provider);
  const db = await openAgentDb();
  const tx = db.transaction('meta', 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore('meta');
  const previous = await requestResult(store.get(`lease:${provider}`));
  if (previous?.token === token) store.delete(`lease:${provider}`);
  await done;
}
