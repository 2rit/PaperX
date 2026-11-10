// Main-thread clients for the processing & detection workers.
import type { PageParams, Pt, Quad } from './types';
import ProcessWorker from '../workers/process.worker.ts?worker';

type Pending = { res: (v: any) => void; rej: (e: any) => void };

function makeClient(factory: () => Worker) {
  let w: Worker | null = null;
  let seq = 0;
  const pending = new Map<number, Pending>();
  const get = () => {
    if (!w) {
      w = factory();
      w.onmessage = (e) => {
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
}
export const detectorState = () => cvState;
export async function detectDocument(image: ImageData): Promise<Detection> {
  try {
    const r = await detector.call<Detection>({ type: 'detect', image }, [image.data.buffer]);
    cvState = 'ready';
    return r;
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
