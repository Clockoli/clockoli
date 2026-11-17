// Full browser-state backups are encrypted in the privileged service worker.
// Neither the plaintext IndexedDB snapshot nor GitHub credentials reach extension pages.
export const FULL_BACKUP_FORMAT = 'clockoli-full-local-backup';
const VERSION = 1;
const ITERATIONS = 310_000;
const MAX_BACKUP_LENGTH = 64 * 1024 * 1024;

function assertPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || payload.version !== VERSION || !Array.isArray(payload.entries)
      || typeof payload.githubLogin !== 'string'
      || (payload.githubLogin && !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(payload.githubLogin))
      || !payload.localStorage || typeof payload.localStorage !== 'object'
      || Array.isArray(payload.localStorage)) throw new Error('Invalid full backup data.');
  const seen = new Set();
  for (const entry of payload.entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
        || !entry[0] || seen.has(entry[0]) || JSON.stringify(entry[1]) === undefined) {
      throw new Error('Invalid full backup storage entries.');
    }
    seen.add(entry[0]);
  }
  if (Object.entries(payload.localStorage).some(([key, value]) =>
    !key || typeof value !== 'string')) throw new Error('Invalid full backup browser preferences.');
  return payload;
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Enter a backup password of at least 8 characters.');
  }
}

function toBase64(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32_768)));
  }
  return btoa(chunks.join(''));
}

function fromBase64(value) {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0
      || !/^[a-z\d+\/]+={0,2}$/i.test(value)) throw new Error('Invalid full backup encryption data.');
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function backupKey(password, salt, cryptoImpl) {
  const material = await cryptoImpl.subtle.importKey('raw', new TextEncoder().encode(password),
    'PBKDF2', false, ['deriveKey']);
  return cryptoImpl.subtle.deriveKey({
    name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS,
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptFullBackup(payload, password, cryptoImpl = globalThis.crypto) {
  assertPassword(password);
  assertPayload(payload);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  if (plaintext.length > MAX_BACKUP_LENGTH / 2) throw new Error('Local data is too large for a single backup file.');
  const salt = cryptoImpl.getRandomValues(new Uint8Array(16));
  const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
  const key = await backupKey(password, salt, cryptoImpl);
  const encrypted = new Uint8Array(await cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  return JSON.stringify({
    format: FULL_BACKUP_FORMAT, version: VERSION, createdAt: new Date().toISOString(),
    encryption: { cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations: ITERATIONS,
      salt: toBase64(salt), iv: toBase64(iv) },
    ciphertext: toBase64(encrypted),
  }, null, 2) + '\n';
}

export async function decryptFullBackup(text, password, cryptoImpl = globalThis.crypto) {
  assertPassword(password);
  if (typeof text !== 'string' || text.length > MAX_BACKUP_LENGTH) throw new Error('Full backup file is too large.');
  let backup;
  try { backup = JSON.parse(text); }
  catch { throw new Error('The selected file is not a valid full backup.'); }
  if (backup?.format !== FULL_BACKUP_FORMAT || backup.version !== VERSION) {
    throw new Error('Unsupported full backup format or version.');
  }
  if (backup.encryption?.cipher !== 'AES-256-GCM'
      || backup.encryption?.kdf !== 'PBKDF2-SHA256'
      || backup.encryption?.iterations !== ITERATIONS) throw new Error('Unsupported full backup encryption.');
  const salt = fromBase64(backup.encryption.salt);
  const iv = fromBase64(backup.encryption.iv);
  if (salt.length !== 16 || iv.length !== 12) throw new Error('Invalid full backup encryption data.');
  const ciphertext = fromBase64(backup.ciphertext);
  if (ciphertext.length < 16) throw new Error('Invalid full backup encryption data.');
  const key = await backupKey(password, salt, cryptoImpl);
  let decrypted;
  try { decrypted = await cryptoImpl.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext); }
  catch { throw new Error('Incorrect backup password or damaged backup file.'); }
  try { return assertPayload(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decrypted))); }
  catch { throw new Error('Invalid full backup data.'); }
}
