import { detectDocument, detectSpine, downscale, ensureSource, renderBlob } from './engine';
import { getBlob, putBlob } from './docs';
import { getSettings } from './settings';
import { FULL_QUAD, type Page, type PageParams, type Quad } from './types';
import { uid } from './util';

export function defaultParams(): Omit<PageParams, 'corners' | 'mids'> {
  const s = getSettings();
  return { rotation: 0, angle: 0, mode: s.defaultMode, brightness: 0, contrast: 0, saturation: 0, shadow: s.shadow, sharpen: s.sharpen, flatten: s.dewarp, book: null };
}

export const straightMids = (q: Quad): Quad => [0, 1, 2, 3].map((i) => {
  const a = q[i], b = q[(i + 1) % 4];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}) as Quad;

/** Create a page from an image blob (photo or camera frame). */
export async function pageFromBlob(
  blob: Blob,
  opts: { flat?: boolean; corners?: Quad; mids?: Quad | null } = {},
): Promise<Page> {
  const { blob: src, w, h, small } = await downscale(blob, 3000, 0.92);
  const s = getSettings();
  let corners: Quad = FULL_QUAD.map((p) => ({ ...p })) as Quad;
  let mids: Quad | null = null;
  if (opts.corners) {
    corners = opts.corners;
    mids = opts.mids ?? null;
  } else if (!opts.flat && s.autoCrop) {
    const d = await detectDocument(small);
    if (d.found && d.corners && (d.areaRatio ?? 0) > 0.12) {
      corners = d.corners;
      mids = s.dewarp && d.curved && d.mids ? d.mids : null;
    }
  }
  if (!s.perspective && !opts.flat) {
    // perspective correction disabled: use axis-aligned bounding box of the detected quad
    const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    corners = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    mids = null;
  }
  const srcKey = await putBlob(src);
  const base = defaultParams();
  const page: Page = {
    id: uid(), srcKey, srcW: w, srcH: h, corners, mids, ...base,
    mode: opts.flat ? 'original' : base.mode,
    shadow: opts.flat ? false : base.shadow,
    flatten: opts.flat ? false : base.flatten,
    rev: 0, dirty: true,
  };
  return page;
}

/** Book mode: turn one photographed two-page spread into a left and a right page (spine found automatically). */
export async function splitBook(p: Page): Promise<Page[]> {
  await ensureSource(p.srcKey, () => getBlob(p.srcKey));
  const { at } = await detectSpine(p.srcKey, { ...p, book: null });
  const flatten = p.flatten ?? getSettings().dewarp;
  return [
    { ...p, id: uid(), book: { side: 'L', at }, flatten, dirty: true, outKey: undefined, thumbKey: undefined },
    { ...p, id: uid(), book: { side: 'R', at }, flatten, dirty: true, outKey: undefined, thumbKey: undefined },
  ];
}

/** Render processed full-res output + thumbnail for a page. */
export async function renderPage(p: Page): Promise<Page> {
  await ensureSource(p.srcKey, () => getBlob(p.srcKey));
  const full = await renderBlob(p.srcKey, p, 'full', 'image/jpeg', 0.9);
  const thumb = await renderBlob(p.srcKey, p, 'thumb', 'image/jpeg', 0.82);
  const outKey = await putBlob(full.blob);
  const thumbKey = await putBlob(thumb.blob);
  return { ...p, outKey, thumbKey, outW: full.w, outH: full.h, rev: p.rev + 1, dirty: false };
}

export type Progress = (done: number, total: number, label: string) => void;

const isHeic = (f: File) => /image\/hei[cf]/i.test(f.type) || /\.(heic|heif)$/i.test(f.name);
const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

async function heicToJpeg(f: Blob): Promise<Blob> {
  const { default: heic2any } = await import('heic2any');
  const out = await heic2any({ blob: f, toType: 'image/jpeg', quality: 0.92 });
  return Array.isArray(out) ? out[0] : out;
}

async function pdfToBlobs(f: File, onPage: (i: number, n: number) => void): Promise<Blob[]> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default as string;
  // Vite emits a base-prefixed URL (`/PaperX/assets/...`). Resolve against the document
  // so a relative worker URL still lands under the Pages subpath.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(workerUrl, window.location.href).href;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
  const out: Blob[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    onPage(i, doc.numPages);
    const page = await doc.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = Math.min(3, 2200 / Math.max(vp1.width, vp1.height));
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    out.push(await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.92)));
    c.width = c.height = 0;
    page.cleanup();
  }
  await doc.destroy();
  return out;
}

/** Import arbitrary files (images, HEIC, PDF) into pages. */
export async function importFiles(files: File[], progress?: Progress): Promise<{ pages: Page[]; failed: string[] }> {
  const pages: Page[] = [];
  const failed: string[] = [];
  let i = 0;
  for (const f of files) {
    i++;
    try {
      if (isPdf(f)) {
        const blobs = await pdfToBlobs(f, (k, n) => progress?.(i - 1, files.length, `กำลังเปิด PDF หน้า ${k}/${n}`));
        for (const b of blobs) pages.push(await pageFromBlob(b, { flat: true }));
      } else {
        progress?.(i - 1, files.length, `กำลังนำเข้า ${i}/${files.length}`);
        let blob: Blob = f;
        try {
          pages.push(await pageFromBlob(blob));
        } catch (e) {
          if (!isHeic(f)) throw e;
          blob = await heicToJpeg(f);
          pages.push(await pageFromBlob(blob));
        }
      }
    } catch (e) {
      console.warn('import failed', f.name, e);
      failed.push(f.name);
    }
  }
  progress?.(files.length, files.length, 'เสร็จสิ้น');
  return { pages, failed };
}

export const ACCEPT = 'image/*,.heic,.heif,application/pdf,.pdf';
