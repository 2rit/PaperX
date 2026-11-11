/// <reference lib="webworker" />
import { enhance, warp, quadSize, detectSkew, glareFraction, suppressGlare, type Img } from '../lib/imaging';
import { estimateFlow, applyFlow, applyUvGrid, findSpine, cropHalf, removeFingers, lineSpread, type FlowField } from '../lib/flatten';
import { dewarpGeneration, learnedCorners, learnedGrid, warmupModels } from '../lib/learned';
import type { PageParams, Pt } from '../lib/types';

declare const self: DedicatedWorkerGlobalScope;

type Target = 'preview' | 'full' | 'thumb' | 'ocr' | 'modeThumb';
const LIMITS: Record<Target, number> = { preview: 1400, full: 2600, thumb: 420, ocr: 2400, modeThumb: 220 };

interface Source { blob: Blob; w: number; h: number; levels: Map<number, Img> }
const sources = new Map<string, Source>();
const warpCache = new Map<string, Img>();
const flowCache = new Map<string, FlowField | null>();
const flatCache = new Map<string, Img>();

function canvas(w: number, h: number) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  return { c, ctx };
}

async function sourceAt(key: string, maxSide: number): Promise<{ img: Img; scale: number; s: Source }> {
  const s = sources.get(key);
  if (!s) throw new Error('source not loaded: ' + key);
  const long = Math.max(s.w, s.h);
  const scale = Math.min(1, maxSide / long);
  const lvl = Math.round(scale * 1000);
  let img = s.levels.get(lvl);
  if (!img) {
    const w = Math.max(1, Math.round(s.w * scale)), h = Math.max(1, Math.round(s.h * scale));
    const bmp = await createImageBitmap(s.blob);
    const { ctx } = canvas(w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const id = ctx.getImageData(0, 0, w, h);
    img = { data: id.data, width: w, height: h };
    // keep only small levels resident to limit memory on iOS
    if (maxSide <= LIMITS.preview) s.levels.set(lvl, img);
  }
  return { img, scale, s };
}

function cloneImg(i: Img): Img {
  return { data: new Uint8ClampedArray(i.data), width: i.width, height: i.height };
}

async function warped(key: string, p: PageParams, target: Target): Promise<Img> {
  const limit = LIMITS[target];
  const s = sources.get(key)!;
  // choose source resolution so that the cropped region roughly matches output limit
  const qpx = p.corners.map((c) => ({ x: c.x * s.w, y: c.y * s.h }));
  const mpx = p.mids ? p.mids.map((c) => ({ x: c.x * s.w, y: c.y * s.h })) : null;
  const size = quadSize(qpx, mpx, { x: s.w / 2, y: s.h / 2 });
  const regionLong = Math.max(size.w, size.h);
  const needLong = Math.max(s.w, s.h) * Math.min(1, limit / regionLong);
  const srcMax = Math.min(Math.max(s.w, s.h), Math.ceil(needLong));
  const ck = `${key}|${target}|${srcMax}|${JSON.stringify(p.corners)}|${JSON.stringify(p.mids)}`;
  const hit = warpCache.get(ck);
  if (hit) return cloneImg(hit);
  const { img, scale } = await sourceAt(key, srcMax);
  const q: Pt[] = qpx.map((c) => ({ x: c.x * scale, y: c.y * scale }));
  const m: Pt[] | null = mpx ? mpx.map((c) => ({ x: c.x * scale, y: c.y * scale })) : null;
  const sz = quadSize(q, m, { x: img.width / 2, y: img.height / 2 });
  const k = Math.min(1, limit / Math.max(sz.w, sz.h));
  const ow = Math.max(8, Math.round(sz.w * k)), oh = Math.max(8, Math.round(sz.h * k));
  const out = warp(img, q, m, ow, oh);
  if (target === 'preview' || target === 'modeThumb' || target === 'thumb') {
    warpCache.set(ck, out);
    if (warpCache.size > 6) warpCache.delete(warpCache.keys().next().value!);
    return cloneImg(out);
  }
  return out;
}

function orient(img: Img, rotation: number, angle: number) {
  const w = img.width, h = img.height;
  const rot = ((rotation % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const W = swap ? h : w, H = swap ? w : h;
  const src = canvas(w, h);
  src.ctx.putImageData(new ImageData(img.data as any, w, h), 0, 0);
  const { c, ctx } = canvas(W, H);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(W / 2, H / 2);
  ctx.rotate(((rot + angle) * Math.PI) / 180);
  if (angle) {
    const r = Math.abs((angle * Math.PI) / 180);
    const cs = Math.cos(r), sn = Math.sin(r);
    const sc = Math.max((W * cs + H * sn) / W, (W * sn + H * cs) / H);
    ctx.scale(sc, sc);
  }
  ctx.drawImage(src.c, -w / 2, -h / 2);
  return c;
}

/** warp + book split + auto flatten: the geometric part of the pipeline */
async function geometry(key: string, p: PageParams, target: Target): Promise<Img> {
  let img = await warped(key, p, target);
  if (p.book) img = cropHalf(img, p.book.side, p.book.at);
  if (p.flatten) {
    img = removeFingers(img);
    // Specular plastic hides the creases UVDoc needs. Soften glare before measuring them.
    if (glareFraction(img) > 0.03) suppressGlare(img);
    // A nearly flat page does not need the learned grid. Loading it there also
    // pulls dark borders back in and undoes shadow removal.
    const curl = lineSpread(img);
    if (curl >= 2 && dewarpGeneration() === 0 && target === 'full') {
      await Promise.race([warmupModels('dewarp'), new Promise((r) => setTimeout(r, 12000))]);
    } else if (curl >= 2 && dewarpGeneration() === 0) {
      warmupModels('dewarp');
    }
    const gen = dewarpGeneration();
    // Target is part of the key: a preview-sized cache must not be reused for the full export.
    const fk = `${target}|${key}|${JSON.stringify(p.corners)}|${JSON.stringify(p.mids)}|${JSON.stringify(p.book || null)}|g${gen}`;
    const hit = flatCache.get(fk);
    if (hit) return cloneImg(hit);
    const geo = estimateFlow(img);
    let best = geo ? applyFlow(img, geo) : img;
    // Preview stays on the fast geometric sheet so the editor never waits on the
    // first model run. Saving and OCR use UVDoc when the page is actually curled.
    if (gen === 1 && curl >= 2 && (target === 'full' || target === 'ocr')) {
      try {
        const grid = await learnedGrid(img);
        if (grid) {
          const un = applyUvGrid(img, grid);
          const extra = estimateFlow(un);
          const refined = extra ? applyFlow(un, extra) : un;
          const edge = (im: Img) => {
            const band = Math.max(2, Math.round(Math.min(im.width, im.height) * 0.08));
            let s = 0, n = 0;
            for (let y = 0; y < im.height; y += 4) {
              for (let x = 0; x < band; x += 3) {
                const i = (y * im.width + x) * 4;
                s += im.data[i] * 0.299 + im.data[i + 1] * 0.587 + im.data[i + 2] * 0.114;
                n++;
              }
            }
            return s / Math.max(1, n);
          };
          // Keep the learned grid only when the lines are straighter and the page edge stays as bright.
          if (lineSpread(refined) < lineSpread(best) * 0.9 && edge(refined) > edge(best) - 12) best = refined;
        }
      } catch { /* geometric result stands */ }
    }
    flowCache.set(fk, geo);
    img = best;
    // While the model is still downloading, don't cache: the next render should try again.
    if (gen !== 0 && (target === 'preview' || target === 'thumb' || target === 'modeThumb')) {
      flatCache.set(fk, img);
      if (flatCache.size > 6) flatCache.delete(flatCache.keys().next().value!);
      img = cloneImg(img);
    }
  }
  return img;
}

async function render(key: string, p: PageParams, target: Target, opts: { raw?: boolean; type?: string; quality?: number }) {
  // raw = geometry before auto-flatten and colour processing (used by the before/after compare)
  const img = opts.raw ? await geometry(key, { ...p, flatten: false }, target) : await geometry(key, p, target);
  if (!opts.raw) enhance(img, p);
  const c = orient(img, p.rotation, p.angle);
  if (target === 'preview' || target === 'modeThumb') {
    const bmp = c.transferToImageBitmap();
    return { bitmap: bmp, w: bmp.width, h: bmp.height };
  }
  const blob = await c.convertToBlob({ type: opts.type || 'image/jpeg', quality: opts.quality ?? 0.9 });
  return { blob, w: c.width, h: c.height };
}

self.onmessage = async (e: MessageEvent) => {
  const { id, type } = e.data;
  try {
    let result: any;
    if (type === 'load') {
      const { key, blob } = e.data;
      if (!sources.has(key)) {
        const bmp = await createImageBitmap(blob);
        sources.set(key, { blob, w: bmp.width, h: bmp.height, levels: new Map() });
        bmp.close();
      }
      const s = sources.get(key)!;
      result = { w: s.w, h: s.h };
    } else if (type === 'unload') {
      sources.delete(e.data.key);
      for (const k of [...warpCache.keys()]) if (k.startsWith(e.data.key + '|')) warpCache.delete(k);
      for (const k of [...flowCache.keys()]) if (k.includes('|' + e.data.key + '|')) flowCache.delete(k);
      for (const k of [...flatCache.keys()]) if (k.includes('|' + e.data.key + '|')) flatCache.delete(k);
      result = true;
    } else if (type === 'render') {
      result = await render(e.data.key, e.data.params, e.data.target, e.data.opts || {});
    } else if (type === 'skew') {
      const img = await geometry(e.data.key, { ...e.data.params, rotation: 0, angle: 0 }, 'preview');
      result = { angle: detectSkew(img) };
    } else if (type === 'spine') {
      const img = await warped(e.data.key, { ...e.data.params, book: null }, 'preview');
      result = { at: findSpine(img) };
    } else if (type === 'flowInfo') {
      await geometry(e.data.key, { ...e.data.params, flatten: true }, 'preview');
      const p = e.data.params;
      const prefix = `|${e.data.key}|${JSON.stringify(p.corners)}|${JSON.stringify(p.mids)}|${JSON.stringify(p.book || null)}|`;
      const f = [...flowCache.entries()].find(([k]) => k.startsWith(prefix))?.[1];
      result = { strength: f ? f.strength : 0 };
    } else if (type === 'warmupModels') {
      await Promise.race([warmupModels(e.data.which || 'both'), new Promise((r) => setTimeout(r, 20000))]);
      result = true;
    } else if (type === 'align') {
      await Promise.race([warmupModels('detect'), new Promise((r) => setTimeout(r, 1800))]);
      const data = new Uint8ClampedArray(e.data.data);
      result = await learnedCorners({ data, width: e.data.width, height: e.data.height });
    } else if (type === 'downscale') {
      // decode a picked file, honour EXIF orientation, and downscale to protect memory (iOS)
      const { blob, max, quality } = e.data;
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' } as any);
      const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
      const { c, ctx } = canvas(w, h);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      const out = await c.convertToBlob({ type: 'image/jpeg', quality: quality ?? 0.92 });
      const small = Math.min(1, 640 / Math.max(w, h));
      const sw = Math.round(w * small), sh = Math.round(h * small);
      const s2 = canvas(sw, sh);
      s2.ctx.drawImage(c, 0, 0, sw, sh);
      const id = s2.ctx.getImageData(0, 0, sw, sh);
      result = { blob: out, w, h, small: id };
    }
    const transfer: Transferable[] = [];
    if (result?.bitmap) transfer.push(result.bitmap);
    if (result?.small) transfer.push(result.small.data.buffer);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err: any) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
