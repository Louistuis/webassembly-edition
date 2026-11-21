// The player's own files in the browser's storage (IndexedDB 'horizon-web',
// store 'files': key = absolute path, value = Uint8Array; kept empty folders
// are keys ending in '/'). boot.js restores them into std's file system before
// the game starts and keeps what the game writes; edition.js (the WASM Edition
// panel) adds and removes mods, packs and worlds here.

export const RESOURCES = '/horizon/.local/horizon-client/26.3/';

// What is kept between visits: the game's writable files, not its resources,
// cache or logs.
export const KEPT = (path) => path.startsWith('/horizon/') && !path.startsWith(RESOURCES)
  && !path.startsWith('/horizon/.horizon-cache/') && !path.startsWith('/horizon/logs/');

// Shared between boot.js and edition.js.
export const session = {
  started: false,       // the game has read its file list: changes now apply on restart
  blocked: new Set(),   // folders removed from the panel while the game runs ("path/"); the game's writes there are dropped
};
export const isBlocked = (path) => {
  for (const prefix of session.blocked) if (path === prefix.slice(0, -1) || path.startsWith(prefix)) return true;
  return false;
};

let opening = null;
export function openStore() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('horizon-web', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  opening.catch(() => { opening = null; });
  return opening;
}

export const tx = (db, mode, fn) => new Promise((resolve, reject) => {
  const t = db.transaction('files', mode);
  const out = fn(t.objectStore('files'));
  t.oncomplete = () => resolve(out?.result);
  t.onerror = () => reject(t.error);
  t.onabort = () => reject(t.error);
});

// Every key under `prefix` (all of them when empty), in one transaction.
const range = (prefix) => (prefix ? IDBKeyRange.bound(prefix, `${prefix}￿`) : undefined);

/// Keys and values together, read in one transaction so they always match.
export async function readAll(db, prefix = '') {
  const t = db.transaction('files', 'readonly');
  const s = t.objectStore('files');
  const keys = s.getAllKeys(range(prefix));
  const values = s.getAll(range(prefix));
  await new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = () => reject(t.error); });
  return { keys: keys.result, values: values.result };
}

/// [{ path, size }] under `prefix`, without holding every file's bytes at once.
export async function sizes(db, prefix) {
  const out = [];
  await new Promise((resolve, reject) => {
    const t = db.transaction('files', 'readonly');
    const req = t.objectStore('files').openCursor(range(prefix));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      out.push({ path: cursor.key, size: cursor.value?.byteLength ?? 0 });
      cursor.continue();
    };
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
  return out;
}

export const getFile = (db, path) => tx(db, 'readonly', (s) => s.get(path));
export const putFiles = (db, entries) => tx(db, 'readwrite', (s) => { for (const [path, bytes] of entries) s.put(bytes, path); });
/// Removes a file, or a folder and everything in it.
export const removeTree = (db, path) => tx(db, 'readwrite', (s) => {
  s.delete(path);
  s.delete(IDBKeyRange.bound(path.endsWith('/') ? path : `${path}/`, `${path.replace(/\/$/, '')}/￿`));
});
export const clearAll = (db) => tx(db, 'readwrite', (s) => s.clear());
