/**
 * Local persistence via IndexedDB: stores the project JSON and the imported
 * media blobs so a page reload restores the full editing session without
 * re-importing files.
 *
 * Two object stores:
 *   - 'kv':    key/value; the project lives under key 'project'.
 *   - 'media': imported File/Blob keyed by sourceId.
 *
 * Zero dependencies — a thin promise wrapper over the native IndexedDB API.
 */
import type { Project } from '../timeline/types';

const DB_NAME = 'video-editor-web';
const DB_VERSION = 1;
const KV_STORE = 'kv';
const MEDIA_STORE = 'media';
const PROJECT_KEY = 'project';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
      if (!db.objectStoreNames.contains(MEDIA_STORE)) db.createObjectStore(MEDIA_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = fn(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

// ---- Project ----

export async function saveProject(project: Project): Promise<void> {
  await tx(KV_STORE, 'readwrite', (s) => s.put(project, PROJECT_KEY));
}

export async function loadProject(): Promise<Project | null> {
  try {
    const data = await tx<Project | undefined>(KV_STORE, 'readonly', (s) => s.get(PROJECT_KEY));
    return data ?? null;
  } catch {
    return null;
  }
}

// ---- Media blobs ----

export async function saveMediaBlob(sourceId: string, file: File | Blob): Promise<void> {
  await tx(MEDIA_STORE, 'readwrite', (s) => s.put(file, sourceId));
}

export async function loadMediaBlob(sourceId: string): Promise<File | Blob | null> {
  try {
    const data = await tx<File | Blob | undefined>(MEDIA_STORE, 'readonly', (s) => s.get(sourceId));
    return data ?? null;
  } catch {
    return null;
  }
}

/** Remove media blobs that are no longer referenced by any project source. */
export async function pruneMedia(keepSourceIds: string[]): Promise<void> {
  const keep = new Set(keepSourceIds);
  const keys = await tx<IDBValidKey[]>(MEDIA_STORE, 'readonly', (s) => s.getAllKeys());
  await Promise.all(
    keys
      .filter((k) => typeof k === 'string' && !keep.has(k))
      .map((k) => tx(MEDIA_STORE, 'readwrite', (s) => s.delete(k))),
  );
}

// ---- Reset ----

export async function clearAll(): Promise<void> {
  await tx(KV_STORE, 'readwrite', (s) => s.clear());
  await tx(MEDIA_STORE, 'readwrite', (s) => s.clear());
}
