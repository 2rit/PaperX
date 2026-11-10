// Minimal IndexedDB layer: one database, two object stores (docs metadata, blobs).
import type { Doc } from './types';

const DB_NAME = 'paperx';
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((res, rej) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const req = fn(s);
        t.oncomplete = () => res(req ? (req as IDBRequest<T>).result : (undefined as T));
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      }),
  );
}

export const db = {
  allDocs: () => tx<Doc[]>('docs', 'readonly', (s) => s.getAll()),
  putDoc: (d: Doc) => tx('docs', 'readwrite', (s) => s.put(d)),
  delDoc: (id: string) => tx('docs', 'readwrite', (s) => s.delete(id)),
  // Blobs are stored as { type, buf } (ArrayBuffer): some WebKit builds / private modes refuse Blob values in IndexedDB.
  getBlob: async (k: string): Promise<Blob | undefined> => {
    const v: any = await tx<any>('blobs', 'readonly', (s) => s.get(k));
    if (!v) return undefined;
    if (v instanceof Blob) return v;
    return new Blob([v.buf], { type: v.type || '' });
  },
  putBlob: async (k: string, b: Blob) => {
    const buf = await b.arrayBuffer();
    return tx('blobs', 'readwrite', (s) => s.put({ type: b.type, buf }, k));
  },
  delBlobs: (keys: string[]) =>
    tx('blobs', 'readwrite', (s) => {
      keys.forEach((k) => s.delete(k));
    }),
  allBlobKeys: () => tx<IDBValidKey[]>('blobs', 'readonly', (s) => s.getAllKeys()),
  clearAll: async () => {
    await tx('docs', 'readwrite', (s) => s.clear());
    await tx('blobs', 'readwrite', (s) => s.clear());
  },
};
