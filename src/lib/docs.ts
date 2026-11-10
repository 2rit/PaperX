// Reactive document store backed by IndexedDB
import { useSyncExternalStore } from 'react';
import { db } from './db';
import type { Doc, Page } from './types';
import { uid } from './util';

let docs: Doc[] = [];
let loaded = false;
const subs = new Set<() => void>();
const emit = () => {
  docs = [...docs];
  subs.forEach((f) => f());
};

export async function loadDocs() {
  try {
    docs = await db.allDocs();
  } catch (e) {
    console.warn('IndexedDB unavailable', e);
    docs = [];
  }
  loaded = true;
  emit();
  gcBlobs();
}

export function useDocs() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => docs,
  );
}
export const isLoaded = () => loaded;
export const getDoc = (id: string) => docs.find((d) => d.id === id);
export const getDocs = () => docs;

export async function saveDoc(d: Doc) {
  const copy: Doc = { ...d, pages: d.pages.map((p) => ({ ...p })) };
  await db.putDoc(copy);
  const i = docs.findIndex((x) => x.id === d.id);
  if (i >= 0) docs[i] = copy;
  else docs.push(copy);
  emit();
  return copy;
}

export function pageKeys(p: Page) {
  return [p.srcKey, p.outKey, p.thumbKey].filter(Boolean) as string[];
}

export async function deleteDocs(ids: string[]) {
  const removed = docs.filter((d) => ids.includes(d.id));
  docs = docs.filter((d) => !ids.includes(d.id));
  emit();
  for (const d of removed) await db.delDoc(d.id);
  return removed; // blobs are kept until gc so undo can restore
}

export async function restoreDocs(list: Doc[]) {
  for (const d of list) await saveDoc(d);
}

export async function duplicateDoc(id: string) {
  const d = getDoc(id);
  if (!d) return;
  const now = Date.now();
  const pages: Page[] = [];
  for (const p of d.pages) {
    const np: Page = { ...p, id: uid() };
    for (const k of ['srcKey', 'outKey', 'thumbKey'] as const) {
      const key = p[k];
      if (!key) continue;
      const b = await db.getBlob(key);
      if (b) {
        const nk = uid();
        await db.putBlob(nk, b);
        (np as any)[k] = nk;
      }
    }
    pages.push(np);
  }
  return saveDoc({ id: uid(), name: d.name + ' (สำเนา)', createdAt: now, updatedAt: now, pages });
}

export async function renameDoc(id: string, name: string) {
  const d = getDoc(id);
  if (!d || !name.trim()) return;
  await saveDoc({ ...d, name: name.trim(), updatedAt: Date.now() });
}

/** Remove blobs that are not referenced by any document. */
export async function gcBlobs() {
  try {
    const used = new Set<string>();
    docs.forEach((d) => d.pages.forEach((p) => pageKeys(p).forEach((k) => used.add(k))));
    const keys = (await db.allBlobKeys()) as string[];
    const dead = keys.filter((k) => !used.has(k) && !pendingKeys.has(k));
    if (dead.length) await db.delBlobs(dead);
  } catch {}
}

// keys created by an editor session but not yet saved into a doc
export const pendingKeys = new Set<string>();

// object URL cache for blob keys
const urlCache = new Map<string, Promise<string | null>>();
export function blobUrl(key?: string): Promise<string | null> {
  if (!key) return Promise.resolve(null);
  let p = urlCache.get(key);
  if (!p) {
    p = db.getBlob(key).then((b) => (b ? URL.createObjectURL(b) : null));
    urlCache.set(key, p);
  }
  return p;
}
export async function putBlob(b: Blob) {
  const k = uid();
  pendingKeys.add(k);
  await db.putBlob(k, b);
  return k;
}
export const getBlob = (k: string) => db.getBlob(k);

export async function clearAllData() {
  await db.clearAll();
  docs = [];
  emit();
}
