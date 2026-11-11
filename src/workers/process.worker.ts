/// <reference lib="webworker" />
import { enhance, warp, quadSize, detectSkew, type Img } from '../lib/imaging';
import { estimateFlow, applyFlow, findSpine, cropHalf, removeFingers, type FlowField } from '../lib/flatten';
import type { PageParams, Pt } from '../lib/types';

declare const self: DedicatedWorkerGlobalScope;

type Target = 'preview' | 'full' | 'thumb' | 'ocr' | 'modeThumb';
const LIMITS: Record<Target, number> = { preview: 1400, full: 2600, thumb: 420, ocr: 2400, modeThumb: 220 };

interface Source { blob: Blob; w: number; h: number; levels: Map<number, Img> }
const sources = new Map<string, Source>();
const warpCache = new Map<string, Img>();
const flowCache = new Map<string, FlowField | null>();

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
    // the field is estimated on a ~720px copy, so it is resolution independent: cache it per geometry
    const fk = `${key}|${JSON.stringify(p.corners)}|${JSON.stringify(p.mids)}|${JSON.stringify(p.book || null)}`;
    let f = flowCache.get(fk);
    if (f === undefined) {
      f = estimateFlow(img);
      flowCache.set(fk, f);
      if (flowCache.size > 24) flowCache.delete(flowCache.keys().next().value!);
    }
    if (f) img = applyFlow(img, f);
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
      for (const k of [...flowCache.keys()]) if (k.startsWith(e.data.key + '|')) flowCache.delete(k);
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
      const f = flowCache.get(`${e.data.key}|${JSON.stringify(p.corners)}|${JSON.stringify(p.mids)}|${JSON.stringify(p.book || null)}`);
      result = { strength: f ? f.strength : 0 };
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
