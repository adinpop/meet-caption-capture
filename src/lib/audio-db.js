// IndexedDB wrapper for raw audio chunks waiting to be transcribed.
// Used from the offscreen doc (writes blobs) and the service worker (reads,
// deletes on successful transcription, marks failed on error).

const DB_NAME = 'captionCapture';
const DB_VERSION = 1;
const STORE = 'audioChunks';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('bySession', 'sessionId', { unique: false });
        store.createIndex('byStatus', 'status', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode) {
  return openDb().then((db) => db.transaction(STORE, mode).objectStore(STORE));
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function chunkId(sessionId, chunkIndex) {
  return `${sessionId}:${String(chunkIndex).padStart(6, '0')}`;
}

export async function putChunk({ sessionId, chunkIndex, platform, meetingId, blob, offsetMs }) {
  const store = await tx('readwrite');
  const rec = {
    id: chunkId(sessionId, chunkIndex),
    sessionId,
    chunkIndex,
    platform,
    meetingId,
    blob,
    offsetMs: offsetMs || 0,
    status: 'pending',
    attempts: 0,
    createdAt: Date.now(),
    lastError: null,
  };
  await wrap(store.put(rec));
  return rec.id;
}

export async function getChunk(id) {
  const store = await tx('readonly');
  return wrap(store.get(id));
}

export async function deleteChunk(id) {
  const store = await tx('readwrite');
  return wrap(store.delete(id));
}

export async function markFailed(id, errorMessage) {
  const store = await tx('readwrite');
  const rec = await wrap(store.get(id));
  if (!rec) return null;
  rec.status = 'failed';
  rec.attempts = (rec.attempts || 0) + 1;
  rec.lastError = String(errorMessage || 'unknown');
  await wrap(store.put(rec));
  return rec;
}

export async function markPending(id) {
  const store = await tx('readwrite');
  const rec = await wrap(store.get(id));
  if (!rec) return null;
  rec.status = 'pending';
  await wrap(store.put(rec));
  return rec;
}

export async function listBySession(sessionId) {
  const store = await tx('readonly');
  const idx = store.index('bySession');
  return wrap(idx.getAll(sessionId));
}

export async function listByStatus(status) {
  const store = await tx('readonly');
  const idx = store.index('byStatus');
  return wrap(idx.getAll(status));
}

export async function deleteBySession(sessionId) {
  const rows = await listBySession(sessionId);
  const store = await tx('readwrite');
  for (const r of rows) await wrap(store.delete(r.id));
  return rows.length;
}

export async function countBySession(sessionId) {
  const rows = await listBySession(sessionId);
  return rows.length;
}
