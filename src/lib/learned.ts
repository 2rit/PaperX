/**
 * DocAligner (corners) and UVDoc (page grid), loaded only when a scan needs them.
 * Weights are float16 on disk and cast back to float32 inside the graph.
 * WebGPU is tried first, then WASM. Any failure leaves the classical pipeline in charge.
 */
import type { Quad } from './types';

export interface ModelProgress {
  name: 'detect' | 'dewarp';
  loaded: number;
  total: number;
  phase: 'download' | 'ready' | 'failed';
}

type Listener = (p: ModelProgress) => void;
const listeners = new Set<Listener>();
export function onModelProgress(fn: Listener) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
export function emitModelProgress(p: ModelProgress) {
  listeners.forEach((fn) => fn(p));
  const scope = self as unknown as { postMessage?: (m: unknown) => void };
  if (typeof DedicatedWorkerGlobalScope !== 'undefined' && scope instanceof DedicatedWorkerGlobalScope) scope.postMessage({ type: 'models', ...p });
}

const DB = 'paperx-models';
const STORE = 'files';

function asset(path: string) {
  const base = import.meta.env.BASE_URL || '/';
  return new URL(path.replace(/^\//, ''), new URL(base, self.location.origin)).href;
}

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function idbGet(key: string): Promise<ArrayBuffer | undefined> {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const q = db.transaction(STORE).objectStore(STORE).get(key);
      q.onsuccess = () => res(q.result as ArrayBuffer | undefined);
      q.onerror = () => rej(q.error);
    });
  } catch {
    return undefined;
  }
}

async function idbPut(key: string, buf: ArrayBuffer) {
  try {
    const db = await idb();
    await new Promise<void>((res, rej) => {
      const q = db.transaction(STORE, 'readwrite').objectStore(STORE).put(buf, key);
      q.onsuccess = () => res();
      q.onerror = () => rej(q.error);
    });
  } catch { /* the service worker cache still holds the response */ }
}

async function fetchBytes(url: string, name: ModelProgress['name'], fileKey: string): Promise<ArrayBuffer> {
  const cached = await idbGet(fileKey);
  if (cached && cached.byteLength > 1000) {
    emitModelProgress({ name, loaded: cached.byteLength, total: cached.byteLength, phase: 'download' });
    return cached;
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(name + ' ' + res.status);
  const total = Number(res.headers.get('content-length') || 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    emitModelProgress({ name, loaded, total: total || loaded, phase: 'download' });
  }
  const buf = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  const out = buf.buffer;
  await idbPut(fileKey, out);
  return out;
}

let ortPromise: Promise<any> | null = null;
function gpuAvailable() {
  return typeof navigator !== 'undefined' && !!(navigator as Navigator & { gpu?: unknown }).gpu;
}

async function loadOrt() {
  if (!ortPromise) {
    ortPromise = (async () => {
      const gpu = gpuAvailable();
      const href = asset(gpu ? 'vendor/ort/ort.webgpu.min.mjs' : 'vendor/ort/ort.wasm.min.mjs');
      const mod = await import(/* @vite-ignore */ href);
      const ort = mod.InferenceSession ? mod : mod.default?.InferenceSession ? mod.default : mod.ort || mod.default;
      if (!ort?.InferenceSession) throw new Error('onnx runtime missing');
      ort.env.wasm.wasmPaths = asset('vendor/ort/');
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.simd = true;
      return ort;
    })().catch((e) => { ortPromise = null; throw e; });
  }
  return ortPromise;
}

async function openSession(bytes: ArrayBuffer) {
  const ort = await loadOrt();
  const providers = gpuAvailable() ? ['webgpu', 'wasm'] : ['wasm'];
  try {
    return await ort.InferenceSession.create(bytes, { executionProviders: providers });
  } catch (e) {
    if (!gpuAvailable()) throw e;
    return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  }
}

type Session = { run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array }>>; inputNames: string[] };

let detectSession: Session | null = null;
let dewarpSession: Session | null = null;
let detectState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
let dewarpState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
let detectJob: Promise<void> | null = null;
let dewarpJob: Promise<void> | null = null;

export const modelState = () => ({ detect: detectState, dewarp: dewarpState });
export const dewarpGeneration = () => (dewarpState === 'ready' ? 1 : dewarpState === 'failed' ? 2 : 0);

async function prepare(which: 'detect' | 'dewarp') {
  const file = which === 'detect' ? 'vendor/models/docaligner-lcnet100.onnx' : 'vendor/models/UVDoc_grid.onnx';
  const bytes = await fetchBytes(asset(file), which, which + '.onnx');
  const session = await openSession(bytes);
  if (which === 'detect') detectSession = session;
  else dewarpSession = session;
  emitModelProgress({ name: which, loaded: bytes.byteLength, total: bytes.byteLength, phase: 'ready' });
}

export function warmupModels(which: 'detect' | 'dewarp' | 'both' = 'both') {
  const jobs: Promise<void>[] = [];
  if (which !== 'dewarp' && detectState !== 'ready' && detectState !== 'failed') {
    if (!detectJob) {
      detectState = 'loading';
      detectJob = prepare('detect').then(() => { detectState = 'ready'; }, () => { detectState = 'failed'; emitModelProgress({ name: 'detect', loaded: 0, total: 0, phase: 'failed' }); });
    }
    jobs.push(detectJob);
  }
  if (which !== 'detect' && dewarpState !== 'ready' && dewarpState !== 'failed') {
    if (!dewarpJob) {
      dewarpState = 'loading';
      dewarpJob = prepare('dewarp').then(() => { dewarpState = 'ready'; }, () => { dewarpState = 'failed'; emitModelProgress({ name: 'dewarp', loaded: 0, total: 0, phase: 'failed' }); });
    }
    jobs.push(dewarpJob);
  }
  return Promise.all(jobs).then(() => undefined);
}

function resizeNCHW(data: Uint8ClampedArray, w: number, h: number, tw: number, th: number) {
  const out = new Float32Array(3 * tw * th);
  for (let y = 0; y < th; y++) {
    const sy = (y + 0.5) * h / th - 0.5;
    const y0 = Math.max(0, sy | 0), y1 = Math.min(h - 1, y0 + 1), fy = Math.min(1, Math.max(0, sy - y0));
    for (let x = 0; x < tw; x++) {
      const sx = (x + 0.5) * w / tw - 0.5;
      const x0 = Math.max(0, sx | 0), x1 = Math.min(w - 1, x0 + 1), fx = Math.min(1, Math.max(0, sx - x0));
      for (let c = 0; c < 3; c++) {
        const p00 = data[(y0 * w + x0) * 4 + c], p10 = data[(y0 * w + x1) * 4 + c];
        const p01 = data[(y1 * w + x0) * 4 + c], p11 = data[(y1 * w + x1) * 4 + c];
        out[c * tw * th + y * tw + x] = (p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy) / 255;
      }
    }
  }
  return out;
}

function peak(hm: Float32Array, w: number, h: number) {
  let best = 0, bi = 0;
  for (let i = 0; i < hm.length; i++) if (hm[i] > best) { best = hm[i]; bi = i; }
  if (best < 0.2) return null;
  const x = bi % w, y = (bi / w) | 0;
  // soft peak in a 3×3 window so the corner is not stuck on a heatmap cell
  let sx = 0, sy = 0, sw = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    const v = hm[yy * w + xx];
    sx += xx * v; sy += yy * v; sw += v;
  }
  return { x: (sx / sw + 0.5) / w, y: (sy / sw + 0.5) / h, score: best };
}

function shoelace(q: Quad) {
  let a = 0;
  for (let i = 0; i < 4; i++) { const p = q[i], n = q[(i + 1) % 4]; a += p.x * n.y - n.x * p.y; }
  return Math.abs(a) / 2;
}

function convex(q: Quad) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1e-4) continue;
    const s = Math.sign(z);
    if (!sign) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** DocAligner corners in normalized image space, or null when the model is not ready. */
export async function learnedCorners(image: { data: Uint8ClampedArray; width: number; height: number }): Promise<{ corners: Quad; areaRatio: number } | null> {
  if (detectState !== 'ready' || !detectSession) return null;
  const ort = await loadOrt();
  const tw = 256, th = 256;
  const input = resizeNCHW(image.data, image.width, image.height, tw, th);
  const tensor = new ort.Tensor('float32', input, [1, 3, th, tw]);
  const out = await detectSession.run({ [detectSession.inputNames[0]]: tensor });
  const hm = out[Object.keys(out)[0]].data as Float32Array;
  const hw = 128, hh = 128, plane = hw * hh;
  const pts = [0, 1, 2, 3].map((k) => peak(hm.subarray(k * plane, (k + 1) * plane), hw, hh));
  if (pts.some((p) => !p)) return null;
  const corners = pts.map((p) => ({ x: p!.x, y: p!.y })) as Quad;
  if (!convex(corners)) return null;
  const area = shoelace(corners);
  if (area < 0.08 || area > 0.98) return null;
  return { corners, areaRatio: area };
}

/** UVDoc grid (x then y, 45×31, −1..1), or null when the model is not ready. */
export async function learnedGrid(img: { data: Uint8ClampedArray; width: number; height: number }): Promise<Float32Array | null> {
  if (dewarpState !== 'ready' || !dewarpSession) return null;
  const ort = await loadOrt();
  const input = resizeNCHW(img.data, img.width, img.height, 496, 720);
  const tensor = new ort.Tensor('float32', input, [1, 3, 720, 496]);
  const out = await dewarpSession.run({ [dewarpSession.inputNames[0]]: tensor });
  const grid = out[Object.keys(out)[0]].data as Float32Array;
  if (grid.length !== 2 * 45 * 31) return null;
  return grid;
}
