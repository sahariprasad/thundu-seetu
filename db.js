// db.js — this phone's own pile, kept in IndexedDB (Safari's built-in database).
// Two stores:
//   events — every slip event for every trip, keyed by event id (never changed once written)
//   meta   — small local-only settings: this device's id, the clock, "which member am I" per trip…

const DB_NAME = 'thundu-seetu';
const DB_VERSION = 1;
let dbPromise;

function open() {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const events = db.createObjectStore('events', { keyPath: 'id' });
      events.createIndex('g', 'g');
      db.createObjectStore('meta', { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function run(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage write was aborted'));
  }));
}

export const allEvents = () => run('events', 'readonly', (s) => s.getAll());

export const putEvents = (events) => run('events', 'readwrite', (s) => { for (const e of events) s.put(e); });

export function deleteTrip(g) {
  return run('events', 'readwrite', (s) => {
    s.index('g').openKeyCursor(IDBKeyRange.only(g)).onsuccess = (ev) => {
      const cur = ev.target.result;
      if (cur) { s.delete(cur.primaryKey); cur.continue(); }
    };
  });
}

export async function getMeta(k, fallback = null) {
  const row = await run('meta', 'readonly', (s) => s.get(k));
  return row ? row.v : fallback;
}

export const setMeta = (k, v) => run('meta', 'readwrite', (s) => s.put({ k, v }));
export const delMeta = (k) => run('meta', 'readwrite', (s) => s.delete(k));
