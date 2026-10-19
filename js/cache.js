// Two-level cache for slow, rate-limited network data (rail lines, routing
// responses): an in-memory Map for this page, backed by IndexedDB so results
// survive reloads and later visits. Entries expire after `ttl` ms. If
// IndexedDB is unavailable (private browsing, blocked storage) it silently
// degrades to memory only.

const DB_NAME = 'time-warp-cache';
const STORE = 'kv';
const VERSION_PREFIX = 'v1:'; // bump to invalidate everything after format changes
const MEMORY_LIMIT = 400;

const memory = new Map();
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => {
        const db = req.result;
        pruneExpired(db);
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function pruneExpired(db) {
  try {
    const now = Date.now();
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      if (!cur.value || cur.value.expires < now) cur.delete();
      cur.continue();
    };
  } catch {
    /* best effort */
  }
}

async function dbGet(key) {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

async function dbPut(key, entry) {
  const db = await openDb();
  if (!db) return;
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(entry, key);
  } catch {
    /* quota or clone errors: memory cache still works */
  }
}

function remember(key, entry) {
  if (memory.size >= MEMORY_LIMIT) memory.delete(memory.keys().next().value);
  memory.set(key, entry);
}

// Return the cached value for `key`, or run `produce()` and cache its result.
// `produce` returning null/undefined is not cached (treated as a failure).
export async function cached(key, ttl, produce) {
  const k = VERSION_PREFIX + key;
  const now = Date.now();
  const mem = memory.get(k);
  if (mem && mem.expires > now) return mem.value;
  const stored = await dbGet(k);
  if (stored && stored.expires > now) {
    remember(k, stored);
    return stored.value;
  }
  const value = await produce();
  if (value != null) {
    const entry = { value, expires: now + ttl };
    remember(k, entry);
    dbPut(k, entry);
  }
  return value;
}

export const DAY = 24 * 60 * 60 * 1000;
