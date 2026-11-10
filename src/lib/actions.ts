import { setBusy } from './busy';
import { getDoc, pendingKeys, saveDoc } from './docs';
import { haptic } from './haptics';
import { ACCEPT, importFiles, renderPage } from './pages';
import { navigate } from './router';
import { toast } from './toast';
import type { Doc, Page } from './types';
import { defaultDocName, uid } from './util';

/** Open the native file picker. Must be called synchronously from a user gesture (iOS). */
export function pickFiles(opts: { capture?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = opts.capture ? 'image/*' : ACCEPT;
    input.multiple = !opts.capture;
    if (opts.capture) input.setAttribute('capture', 'environment');
    input.style.position = 'fixed';
    input.style.left = '-1000px';
    input.setAttribute('data-testid', 'file-input');
    document.body.appendChild(input);
    let done = false;
    const finish = (f: File[]) => { if (done) return; done = true; input.remove(); resolve(f); };
    input.addEventListener('change', () => finish(Array.from(input.files || [])));
    input.addEventListener('cancel', () => finish([]));
    input.click();
  });
}

export async function finalizePages(pages: Page[], label = 'กำลังประมวลผล'): Promise<Page[]> {
  const out: Page[] = [];
  for (let i = 0; i < pages.length; i++) {
    setBusy({ label: `${label} ${i + 1}/${pages.length}`, progress: (i + 0.5) / pages.length });
    out.push(await renderPage(pages[i]));
  }
  return out;
}

export async function createDocFromPages(pages: Page[], name?: string): Promise<Doc> {
  const now = Date.now();
  const doc: Doc = { id: uid(), name: name || defaultDocName(now), createdAt: now, updatedAt: now, pages };
  await saveDoc(doc);
  pages.forEach((p) => [p.srcKey, p.outKey, p.thumbKey].forEach((k) => k && pendingKeys.delete(k)));
  return doc;
}

/** Import files → new document → open editor. */
export async function importToNewDoc(files: File[]) {
  if (!files.length) return;
  try {
    setBusy({ label: 'กำลังนำเข้า…', progress: 0 });
    const { pages, failed } = await importFiles(files, (d, n, label) => setBusy({ label, progress: (d / Math.max(1, n)) * 0.5 }));
    if (failed.length) toast(`เปิดไฟล์ไม่ได้: ${failed.join(', ')}`, { kind: 'error', ms: 5000 });
    if (!pages.length) return;
    const ready = await finalizePages(pages, 'กำลังปรับภาพ');
    const name = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') : undefined;
    const doc = await createDocFromPages(ready, name);
    haptic('success');
    toast(`นำเข้าแล้ว ${ready.length} หน้า`, { kind: 'success' });
    navigate(`editor/${doc.id}`);
  } catch (e: any) {
    console.error(e);
    toast('นำเข้าไม่สำเร็จ: ' + (e?.message || e), { kind: 'error' });
  } finally {
    setBusy(null);
  }
}

/** Append files to an existing document. */
export async function importIntoDoc(docId: string, files: File[]) {
  const doc = getDoc(docId);
  if (!doc || !files.length) return null;
  try {
    setBusy({ label: 'กำลังเพิ่มหน้า…', progress: 0 });
    const { pages, failed } = await importFiles(files);
    if (failed.length) toast(`เปิดไฟล์ไม่ได้: ${failed.join(', ')}`, { kind: 'error' });
    const ready = await finalizePages(pages, 'กำลังปรับภาพ');
    ready.forEach((p) => [p.srcKey, p.outKey, p.thumbKey].forEach((k) => k && pendingKeys.delete(k)));
    const updated = await saveDoc({ ...doc, pages: [...doc.pages, ...ready], updatedAt: Date.now() });
    toast(`เพิ่มแล้ว ${ready.length} หน้า`, { kind: 'success' });
    return updated;
  } finally {
    setBusy(null);
  }
}
