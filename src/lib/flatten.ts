/**
 * Text-line based page flattening ("auto flatten", VFlat-style).
 *
 * After the page outline has been rectified, curved or wrinkled paper still leaves text lines
 * bent. We measure that bend from the content itself: the page is cut into vertical strips,
 * each strip gets an ink projection profile, and neighbouring strips are aligned with local
 * windowed cross-correlation. Accumulating those shifts from the centre strip outwards gives a
 * smooth vertical displacement field D(x, y); resampling with it straightens the text lines.
 */
import type { Img } from './imaging';

export interface FlowField { gx: number; gy: number; d: Float32Array; strength: number } // d normalised by height

const STRIPS = 20;
const WIN = 1 / 7; // window height (fraction of page height)
const STEP = 1 / 28;

function grayOf(img: Img, maxW: number) {
  const k = Math.min(1, maxW / img.width);
  const w = Math.max(16, Math.round(img.width * k)), h = Math.max(16, Math.round(img.height * k));
  const g = new Float32Array(w * h);
  const sx = img.width / w, sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const yy = Math.min(img.height - 1, Math.floor((y + 0.5) * sy));
    for (let x = 0; x < w; x++) {
      const xx = Math.min(img.width - 1, Math.floor((x + 0.5) * sx));
      const i = (yy * img.width + xx) * 4;
      g[y * w + x] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
    }
  }
  return { g, w, h };
}

/** ink map: how much darker than the local background (integral-image box mean) */
function inkMap(g: Float32Array, w: number, h: number) {
  const r = Math.max(6, Math.round(Math.min(w, h) / 40));
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += g[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
  }
  const ink = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      const m = s / ((x1 - x0) * (y1 - y0));
      const v = m - g[y * w + x] - 8;
      ink[y * w + x] = v > 0 ? Math.min(60, v) : 0;
    }
  }
  return ink;
}

function smooth1(a: Float32Array, sigma: number) {
  const r = Math.ceil(sigma * 2.5), k: number[] = [];
  let ks = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); ks += v; }
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let s = 0;
    for (let j = -r; j <= r; j++) { const t = Math.min(a.length - 1, Math.max(0, i + j)); s += a[t] * k[j + r]; }
    o[i] = s / ks;
  }
  return o;
}

function interp(a: Float32Array, y: number) {
  const y0 = Math.max(0, Math.min(a.length - 1, Math.floor(y))), y1 = Math.min(a.length - 1, y0 + 1), t = Math.max(0, Math.min(1, y - y0));
  return a[y0] * (1 - t) + a[y1] * t;
}

/** best shift s (sub-pixel) so that b[y + s] ≈ a[y] inside window [c - half, c + half] */
function align(a: Float32Array, b: Float32Array, c: number, half: number, maxS: number) {
  const n = a.length;
  const y0 = Math.max(0, Math.round(c - half)), y1 = Math.min(n - 1, Math.round(c + half));
  let ma = 0, ea = 0;
  for (let y = y0; y <= y1; y++) ma += a[y];
  ma /= y1 - y0 + 1;
  for (let y = y0; y <= y1; y++) ea += (a[y] - ma) ** 2;
  if (ea < 1e-3) return null;
  const scores: number[] = [];
  let best = -2, bi = 0;
  for (let s = -maxS; s <= maxS; s++) {
    let mb = 0, cnt = 0;
    for (let y = y0; y <= y1; y++) { const t = y + s; if (t >= 0 && t < n) { mb += b[t]; cnt++; } }
    if (cnt < (y1 - y0) * 0.7) { scores.push(-2); continue; }
    mb /= cnt;
    let num = 0, eb = 0;
    for (let y = y0; y <= y1; y++) { const t = y + s; if (t < 0 || t >= n) continue; const db = b[t] - mb; num += (a[y] - ma) * db; eb += db * db; }
    const sc = eb > 1e-6 ? num / Math.sqrt(ea * eb) - Math.abs(s) * 0.004 : -2;
    scores.push(sc);
    if (sc > best) { best = sc; bi = s + maxS; }
  }
  if (best < 0.45) return null;
  let off = 0;
  if (bi > 0 && bi < scores.length - 1 && scores[bi - 1] > -2 && scores[bi + 1] > -2) {
    const l = scores[bi - 1], r = scores[bi + 1], den = l - 2 * best + r;
    if (den < 0) off = (0.5 * (l - r)) / den;
  }
  return { s: bi - maxS + off, score: best };
}

/** Estimate the displacement field. Returns null when the page has too little text to trust. */
function estimateOnce(img: Img): FlowField | null {
  const { g, w, h } = grayOf(img, 720);
  const ink = inkMap(g, w, h);
  const sw = w / STRIPS;
  const prof: Float32Array[] = [];
  const energy: number[] = [];
  for (let i = 0; i < STRIPS; i++) {
    const x0 = Math.round(i * sw), x1 = Math.round((i + 1) * sw);
    const p = new Float32Array(h);
    let e = 0;
    for (let y = 0; y < h; y++) { let s = 0; for (let x = x0; x < x1; x++) s += ink[y * w + x]; p[y] = s / (x1 - x0); e += p[y]; }
    prof.push(smooth1(p, Math.max(1, h / 500)));
    energy.push(e / h);
  }
  const gy = Math.round(1 / STEP) + 1;
  const half = (WIN * h) / 2;
  const maxS = Math.max(3, Math.round(h * 0.012)); // < half a text-line pitch: avoids locking onto the neighbouring line
  const D = new Float32Array(STRIPS * gy); // pixels, at strip centres
  const W = new Float32Array(STRIPS * gy); // confidence
  const ref = Math.floor(STRIPS / 2);
  let good = 0, total = 0;
  for (let j = 0; j < gy; j++) W[ref * gy + j] = 1;
  for (const dir of [1, -1]) {
    for (let i = ref + dir; i >= 0 && i < STRIPS; i += dir) {
      const prev = i - dir;
      for (let j = 0; j < gy; j++) {
        const yc = j * STEP * h;
        const dp = D[prev * gy + j];
        const r = align(prof[prev], prof[i], yc + dp, half, maxS);
        total++;
        if (r) { good++; D[i * gy + j] = dp + r.s; W[i * gy + j] = Math.min(1, r.score) * W[prev * gy + j]; }
        else { D[i * gy + j] = dp; W[i * gy + j] = W[prev * gy + j] * 0.5; }
      }
    }
  }
  if (total === 0 || good / total < 0.35) return null;
  // fill weak cells from neighbours along y, then smooth across the grid
  for (let i = 0; i < STRIPS; i++) {
    let sumW = 0, sum = 0;
    for (let j = 0; j < gy; j++) { sumW += W[i * gy + j]; sum += D[i * gy + j] * W[i * gy + j]; }
    const mean = sumW > 0 ? sum / sumW : 0;
    for (let j = 0; j < gy; j++) { const wv = W[i * gy + j]; D[i * gy + j] = D[i * gy + j] * wv + mean * (1 - wv); }
  }
  const S = new Float32Array(STRIPS * gy);
  for (let i = 0; i < STRIPS; i++) for (let j = 0; j < gy; j++) {
    let s = 0, c = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -2; dj <= 2; dj++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= STRIPS || jj >= gy) continue;
      const wt = (di === 0 ? 2 : 1) * (dj === 0 ? 2 : 1);
      s += D[ii * gy + jj] * wt; c += wt;
    }
    S[i * gy + j] = s / c;
  }
  // remove a global linear tilt (deskew handles that) so we only straighten curvature
  let mx = 0, my = 0, sxx = 0, sxy = 0;
  const xsC = Array.from({ length: STRIPS }, (_, i) => (i + 0.5) / STRIPS - 0.5);
  const colMean = xsC.map((_, i) => { let s = 0; for (let j = 0; j < gy; j++) s += S[i * gy + j]; return s / gy; });
  for (let i = 0; i < STRIPS; i++) { mx += xsC[i]; my += colMean[i]; }
  mx /= STRIPS; my /= STRIPS;
  for (let i = 0; i < STRIPS; i++) { sxx += (xsC[i] - mx) ** 2; sxy += (xsC[i] - mx) * (colMean[i] - my); }
  const slope = sxx ? sxy / sxx : 0;
  let maxAbs = 0;
  const d = new Float32Array(STRIPS * gy);
  for (let i = 0; i < STRIPS; i++) for (let j = 0; j < gy; j++) {
    const v = (S[i * gy + j] - slope * (xsC[i] - mx) - my) / h;
    d[i * gy + j] = Math.max(-0.08, Math.min(0.08, v));
    maxAbs = Math.max(maxAbs, Math.abs(d[i * gy + j]));
  }
  if (maxAbs < 0.0015) return null; // already flat
  return { gx: STRIPS, gy, d, strength: maxAbs };
}

function shrink(img: Img, maxW: number): Img {
  const k = Math.min(1, maxW / img.width);
  if (k === 1) return img;
  const w = Math.max(16, Math.round(img.width * k)), h = Math.max(16, Math.round(img.height * k));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const yy = Math.min(img.height - 1, Math.floor((y + 0.5) / k));
    for (let x = 0; x < w; x++) {
      const xx = Math.min(img.width - 1, Math.floor((x + 0.5) / k));
      const a = (yy * img.width + xx) * 4, o = (y * w + x) * 4;
      out[o] = img.data[a]; out[o + 1] = img.data[a + 1]; out[o + 2] = img.data[a + 2]; out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/** Estimate the displacement field (iteratively refined). Returns null when the page has too little text or is already flat. */
export function estimateFlow(img: Img, iters = 3): FlowField | null {
  let small = shrink(img, 720);
  let total: FlowField | null = null;
  for (let it = 0; it < iters; it++) {
    const f = estimateOnce(small);
    if (!f) break;
    if (!total) total = { ...f, d: new Float32Array(f.d) };
    else for (let i = 0; i < total.d.length; i++) total.d[i] = Math.max(-0.1, Math.min(0.1, total.d[i] + f.d[i]));
    if (it < iters - 1) small = applyFlow(shrink(img, 720), total);
  }
  if (!total) return null;
  let m = 0;
  for (const v of total.d) m = Math.max(m, Math.abs(v));
  total.strength = m;
  return total;
}

/** Resample an image with the flow field: out(x, y) = in(x, y + D(x, y)). */
export function applyFlow(img: Img, f: FlowField): Img {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(data.length);
  const col = new Float32Array(f.gy);
  const disp = new Float32Array(h);
  for (let x = 0; x < w; x++) {
    // horizontal interpolation between strip centres
    const fx = (x + 0.5) / w * f.gx - 0.5;
    const i0 = Math.max(0, Math.min(f.gx - 1, Math.floor(fx))), i1 = Math.min(f.gx - 1, i0 + 1), tx = Math.max(0, Math.min(1, fx - i0));
    for (let j = 0; j < f.gy; j++) col[j] = (f.d[i0 * f.gy + j] * (1 - tx) + f.d[i1 * f.gy + j] * tx) * h;
    for (let y = 0; y < h; y++) disp[y] = interp(col, (y / h) / STEP);
    for (let y = 0; y < h; y++) {
      const sy = Math.max(0, Math.min(h - 1, y + disp[y])); // clamp: extend the paper edge instead of a white wedge
      const o = (y * w + x) * 4;
      const y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), t = sy - y0;
      const a = (y0 * w + x) * 4, b = (y1 * w + x) * 4;
      out[o] = data[a] + (data[b] - data[a]) * t;
      out[o + 1] = data[a + 1] + (data[b + 1] - data[a + 1]) * t;
      out[o + 2] = data[a + 2] + (data[b + 2] - data[a + 2]) * t;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/** Find the book spine (gutter) column of a two-page spread, as fraction of width. */
export function findSpine(img: Img): number {
  const { g, w, h } = grayOf(img, 600);
  const colM = new Float32Array(w);
  for (let x = 0; x < w; x++) { let s = 0; for (let y = Math.round(h * 0.1); y < h * 0.9; y++) s += g[y * w + x]; colM[x] = s / (h * 0.8); }
  const sm = smooth1(colM, Math.max(1, w / 150));
  const a = Math.round(w * 0.36), b = Math.round(w * 0.64);
  let mn = Infinity, mi = Math.round(w / 2), mxv = -Infinity, ma = mi;
  for (let x = a; x <= b; x++) { if (sm[x] < mn) { mn = sm[x]; mi = x; } if (sm[x] > mxv) { mxv = sm[x]; ma = x; } }
  const sorted = Array.from(sm.slice(a, b + 1)).sort((p, q) => p - q);
  const med = sorted[sorted.length >> 1];
  // shaded gutter (photographed book) -> darkest valley; flat spread -> widest white gap
  if (med - mn > 6) return mi / w;
  // white gap: column with least ink
  const ink = inkMap(g, w, h);
  let best = Infinity, bx = Math.round(w / 2);
  for (let x = a; x <= b; x++) {
    let s = 0;
    for (let dx = -3; dx <= 3; dx++) { const xx = Math.min(w - 1, Math.max(0, x + dx)); for (let y = Math.round(h * 0.1); y < h * 0.9; y += 2) s += ink[y * w + xx]; }
    s += Math.abs(x - w / 2) * 0.02;
    if (s < best) { best = s; bx = x; }
  }
  void ma;
  return bx / w;
}

/** Crop the left or right page out of a spread. */
export function cropHalf(img: Img, side: 'L' | 'R', at: number): Img {
  const { width: w, height: h, data } = img;
  const cut = Math.round(w * Math.max(0.2, Math.min(0.8, at)));
  const gap = Math.round(w * 0.012); // drop the darkest part of the gutter
  const x0 = side === 'L' ? 0 : Math.min(w - 1, cut + gap), x1 = side === 'L' ? Math.max(1, cut - gap) : w;
  const nw = x1 - x0;
  const out = new Uint8ClampedArray(nw * h * 4);
  for (let y = 0; y < h; y++) out.set(data.subarray((y * w + x0) * 4, (y * w + x1) * 4), y * nw * 4);
  return { data: out, width: nw, height: h };
}
