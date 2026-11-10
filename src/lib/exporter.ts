import { ensureSource, renderBlob } from './engine';
import { getBlob } from './docs';
import type { Doc } from './types';
import { safeFileName } from './util';

export interface ExportOpts {
  format: 'pdf' | 'jpg' | 'png';
  paper: 'a4' | 'original';
  quality: 'high' | 'standard';
}
export interface ExportFile { blob: Blob; name: string }

async function pageImage(doc: Doc, i: number, type: string, q: number, maxSide: number) {
  const p = doc.pages[i];
  // full-quality render straight from source so export never depends on stale caches
  await ensureSource(p.srcKey, () => getBlob(p.srcKey));
  const r = await renderBlob(p.srcKey, p, 'full', type, q);
  if (Math.max(r.w, r.h) <= maxSide) return r;
  const bmp = await createImageBitmap(r.blob);
  const k = maxSide / Math.max(r.w, r.h);
  const c = document.createElement('canvas');
  c.width = Math.round(r.w * k);
  c.height = Math.round(r.h * k);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), type, q));
  const out = { blob, w: c.width, h: c.height };
  c.width = c.height = 0;
  return out;
}

export async function exportDoc(doc: Doc, o: ExportOpts, onProgress?: (d: number, n: number) => void): Promise<ExportFile[]> {
  const base = safeFileName(doc.name);
  const high = o.quality === 'high';
  const n = doc.pages.length;
  if (o.format === 'pdf') {
    const { jsPDF } = await import('jspdf');
    let pdf: InstanceType<typeof jsPDF> | null = null;
    for (let i = 0; i < n; i++) {
      onProgress?.(i, n);
      const img = await pageImage(doc, i, 'image/jpeg', high ? 0.9 : 0.72, high ? 2600 : 1700);
      const bytes = new Uint8Array(await img.blob.arrayBuffer());
      const landscape = img.w > img.h;
      let pw: number, ph: number;
      if (o.paper === 'a4') { pw = landscape ? 297 : 210; ph = landscape ? 210 : 297; }
      else { const dpi = high ? 220 : 150; pw = (img.w / dpi) * 25.4; ph = (img.h / dpi) * 25.4; }
      const orientation = pw > ph ? 'l' : 'p';
      if (!pdf) pdf = new jsPDF({ unit: 'mm', format: [pw, ph], orientation, compress: true });
      else pdf.addPage([pw, ph], orientation);
      // fit image (A4: fill when aspect is close, otherwise contain on white)
      const ia = img.w / img.h, pa = pw / ph;
      let dw = pw, dh = ph;
      if (o.paper === 'a4' && Math.abs(ia - pa) / pa > 0.04) {
        if (ia > pa) dh = pw / ia; else dw = ph * ia;
      }
      pdf.addImage(bytes, 'JPEG', (pw - dw) / 2, (ph - dh) / 2, dw, dh, undefined, 'FAST');
    }
    onProgress?.(n, n);
    pdf!.setProperties({ title: doc.name, creator: 'PAPERX Smart Document Scanner' });
    return [{ blob: pdf!.output('blob'), name: base + '.pdf' }];
  }
  const type = o.format === 'png' ? 'image/png' : 'image/jpeg';
  const files: ExportFile[] = [];
  for (let i = 0; i < n; i++) {
    onProgress?.(i, n);
    let img = await pageImage(doc, i, type, high ? 0.92 : 0.75, high ? 2600 : 1700);
    if (o.paper === 'a4') img = await padToA4(img, type, high ? 0.92 : 0.75);
    files.push({ blob: img.blob, name: n > 1 ? `${base}_${i + 1}.${o.format}` : `${base}.${o.format}` });
  }
  onProgress?.(n, n);
  return files;
}

async function padToA4(img: { blob: Blob; w: number; h: number }, type: string, q: number) {
  const landscape = img.w > img.h;
  const ratio = landscape ? 297 / 210 : 210 / 297;
  const ia = img.w / img.h;
  if (Math.abs(ia - ratio) / ratio < 0.04) return img;
  let W = img.w, H = img.h;
  if (ia > ratio) H = Math.round(W / ratio); else W = Math.round(H * ratio);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  const bmp = await createImageBitmap(img.blob);
  ctx.drawImage(bmp, (W - img.w) / 2, (H - img.h) / 2);
  bmp.close();
  const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), type, q));
  c.width = c.height = 0;
  return { blob, w: W, h: H };
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function canShareFiles(files?: File[]) {
  try {
    if (!navigator.share || !navigator.canShare) return false;
    const probe = files ?? [new File([new Blob(['x'], { type: 'application/pdf' })], 'a.pdf', { type: 'application/pdf' })];
    return navigator.canShare({ files: probe });
  } catch {
    return false;
  }
}

export async function shareFiles(files: ExportFile[], title: string) {
  const fs = files.map((f) => new File([f.blob], f.name, { type: f.blob.type }));
  await navigator.share({ files: fs, title });
}
