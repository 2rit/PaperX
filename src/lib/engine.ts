// Main-thread clients for the processing & detection workers.
import type { PageParams, Pt, Quad } from './types';
import ProcessWorker from '../workers/process.worker.ts?worker';
import { emitModelProgress, onModelProgress, type ModelProgress } from './learned';

type Pending = { res: (v: any) => void; rej: (e: any) => void };

function makeClient(factory: () => Worker) {
  let w: Worker | null = null;
  let seq = 0;
  const pending = new Map<number, Pending>();
  const get = () => {
    if (!w) {
      w = factory();
      w.onmessage = (e) => {
        if (e.data?.type === 'models') { emitModelProgress(e.data as ModelProgress); return; }
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        e.data.ok ? p.res(e.data.result) : p.rej(new Error(e.data.error));
      };
      w.onerror = (e) => {
        pending.forEach((p) => p.rej(new Error(e.message || 'worker error')));
        pending.clear();
        w?.terminate();
        w = null;
      };
    }
    return w;
  };
  return {
    call<T = any>(msg: any, transfer: Transferable[] = []): Promise<T> {
      const id = ++seq;
      return new Promise<T>((res, rej) => {
        pending.set(id, { res, rej });
        get().postMessage({ ...msg, id }, transfer);
      });
    },
  };
}

const proc = makeClient(() => new ProcessWorker());
const detector = makeClient(
  () => new Worker(new URL(`${import.meta.env.BASE_URL}workers/detect.js`, window.location.origin), { name: 'paperx-detect' }),
);

const loaded = new Set<string>();
export async function ensureSource(key: string, blob: () => Promise<Blob | undefined>) {
  if (loaded.has(key)) return;
  const b = await blob();
  if (!b) throw new Error('missing image');
  await proc.call({ type: 'load', key, blob: b });
  loaded.add(key);
}
export function unloadSource(key: string) {
  if (!loaded.delete(key)) return;
  proc.call({ type: 'unload', key }).catch(() => {});
}

export type RenderTarget = 'preview' | 'full' | 'thumb' | 'ocr' | 'modeThumb';
export function renderBitmap(key: string, params: PageParams, target: 'preview' | 'modeThumb', raw = false) {
  return proc.call<{ bitmap: ImageBitmap; w: number; h: number }>({ type: 'render', key, params, target, opts: { raw } });
}
export function renderBlob(key: string, params: PageParams, target: 'full' | 'thumb' | 'ocr', type = 'image/jpeg', quality = 0.9) {
  return proc.call<{ blob: Blob; w: number; h: number }>({ type: 'render', key, params, target, opts: { type, quality } });
}
export function detectSkew(key: string, params: PageParams) {
  return proc.call<{ angle: number }>({ type: 'skew', key, params });
}
export function detectSpine(key: string, params: PageParams) {
  return proc.call<{ at: number }>({ type: 'spine', key, params });
}
export function flowStrength(key: string, params: PageParams) {
  return proc.call<{ strength: number }>({ type: 'flowInfo', key, params });
}
export function downscale(blob: Blob, max = 3000, quality = 0.92) {
  return proc.call<{ blob: Blob; w: number; h: number; small: ImageData }>({ type: 'downscale', blob, max, quality });
}

export interface Detection {
  found: boolean;
  corners?: Quad;
  mids?: Quad;
  curved?: boolean;
  areaRatio?: number;
  ratio?: number;
  ms?: number;
}
let cvState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
export function warmupDetector() {
  if (cvState !== 'idle') return;
  cvState = 'loading';
  detector.call({ type: 'warmup' }).then(
    () => (cvState = 'ready'),
    () => (cvState = 'failed'),
  );
  // Download DocAligner in the processing worker, not on the UI thread.
  proc.call({ type: 'warmupModels', which: 'detect' }).catch(() => {});
}
export const detectorState = () => cvState;
export { onModelProgress };

function cornerGap(a: Quad, b: Quad) {
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y));
  return m;
}

function mergeDetection(classical: Detection, learned: { corners: Quad; areaRatio: number } | null): Detection {
  if (!learned) return classical;
  if (!classical.found || !classical.corners) {
    return { found: true, corners: learned.corners, areaRatio: learned.areaRatio, curved: false };
  }
  const gap = cornerGap(classical.corners, learned.corners);
  // They agree. Keep the classical quad, including its curved-edge handles.
  if (gap <= 0.045) return classical;
  // Classical grabbed the whole frame or a thin strip. Trust the learned quad.
  const ca = classical.areaRatio ?? 0;
  const weak = ca > 0.92 || ca < 0.18;
  if (weak && learned.areaRatio > 0.12 && learned.areaRatio < 0.95) {
    return { found: true, corners: learned.corners, areaRatio: learned.areaRatio, mids: gap < 0.1 ? classical.mids : undefined, curved: gap < 0.1 && !!classical.curved };
  }
  return classical;
}

export async function detectDocument(image: ImageData, opts?: { waitModel?: boolean }): Promise<Detection> {
  const pixels = new Uint8ClampedArray(image.data);
  const view = { data: pixels, width: image.width, height: image.height };
  try {
    const classicalP = detector.call<Detection>({ type: 'detect', image }, [image.data.buffer]);
    // Live frames stay classical so the viewfinder is not blocked. A still asks the
    // worker for DocAligner and does not wait long enough to freeze the page.
    let learnedP: Promise<{ corners: Quad; areaRatio: number } | null> = Promise.resolve(null);
    if (opts?.waitModel) {
      const copy = new Uint8ClampedArray(pixels);
      learnedP = Promise.race([
        proc.call<{ corners: Quad; areaRatio: number } | null>({ type: 'align', width: view.width, height: view.height, data: copy }, [copy.buffer]),
        new Promise<null>((res) => setTimeout(() => res(null), 2500)),
      ]).catch(() => null);
    }
    const classical = await classicalP;
    cvState = 'ready';
    const learned = await learnedP;
    return mergeDetection(classical, learned);
  } catch (e) {
    console.warn('detect failed', e);
    return { found: false };
  }
}

/** Human label for a detected sheet, from side ratio. */
export function paperLabel(ratio?: number) {
  if (!ratio) return 'ตรวจพบเอกสาร';
  if (Math.abs(ratio - 1.414) < 0.09) return 'ตรวจพบเอกสาร A4';
  if (Math.abs(ratio - 1.294) < 0.035) return 'ตรวจพบเอกสาร Letter';
  if (ratio > 1.5 && ratio < 1.7) return 'ตรวจพบบัตร/ใบเสร็จ';
  return 'ตรวจพบเอกสาร';
}

export function quadArea(q: Pt[]) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i], n = q[(i + 1) % 4];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}
