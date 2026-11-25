// This database belongs only to the experimental extension origin, never Clockoli's production store.
const DATABASE = 'clockoli-local-log-probe-v1';

function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

export async function openProbeDb() {
  const request = indexedDB.open(DATABASE, 1);
  request.onupgradeneeded = () => {
    for (const name of ['handles', 'cursors', 'status']) {
      if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
    }
  };
  return result(request);
}

export async function read(store, key) {
  const db = await openProbeDb();
  try { return await result(db.transaction(store, 'readonly').objectStore(store).get(key)); }
  finally { db.close(); }
}

export async function write(store, key, value) {
  const db = await openProbeDb();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(store, 'readwrite');
      transaction.objectStore(store).put(value, key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB write failed'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB write aborted'));
    });
  } finally { db.close(); }
}
