// Pure image processing routines (run inside a Web Worker).
import type { Mode, PageParams, Pt } from './types';

export type Img = { data: Uint8ClampedArray; width: number; height: number };

// ---------- geometry ----------
export type Homography = { a: number; b: number; c: number; d: number; e: number; f: number; g: number; h: number };

/** Projective map from unit square (u,v) to quad q0..q3 (TL,TR,BR,BL). */
export function squareToQuad(q: Pt[]): Homography {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    return { a: p1.x - p0.x, b: p2.x - p1.x, c: p0.x, d: p1.y - p0.y, e: p2.y - p1.y, f: p0.y, g: 0, h: 0 };
  }
  const det = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const h = (dx1 * dy3 - dx3 * dy1) / det;
  return {
    a: p1.x - p0.x + g * p1.x, b: p3.x - p0.x + h * p3.x, c: p0.x,
    d: p1.y - p0.y + g * p1.y, e: p3.y - p0.y + h * p3.y, f: p0.y, g, h,
  };
}
export function applyH(H: Homography, u: number, v: number): Pt {
  const w = H.g * u + H.h * v + 1;
  return { x: (H.a * u + H.b * v + H.c) / w, y: (H.d * u + H.e * v + H.f) / w };
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * True aspect ratio (w/h) of a rectangle seen in perspective (Zhang & He, "Whiteboard scanning").
 * Returns null when it can't be estimated reliably.
 */
export function perspectiveAspect(q: Pt[], cx: number, cy: number): number | null {
  // m1=TL, m2=TR, m3=BL, m4=BR, homogeneous, relative to principal point
  const h = (p: Pt) => [p.x - cx, p.y - cy, 1];
  const m1 = h(q[0]), m2 = h(q[1]), m3 = h(q[3]), m4 = h(q[2]);
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const c14 = cross(m1, m4);
  const k2 = dot(c14, m3) / dot(cross(m2, m4), m3);
  const k3 = dot(c14, m2) / dot(cross(m3, m4), m2);
  const n2 = m2.map((v, i) => k2 * v - m1[i]);
  const n3 = m3.map((v, i) => k3 * v - m1[i]);
  const den = n2[2] * n3[2];
  let ratio: number;
  if (Math.abs(den) < 1e-9) {
    ratio = Math.hypot(n2[0], n2[1]) / Math.hypot(n3[0], n3[1]);
  } else {
    const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / den;
    if (!(f2 > 0)) {
      ratio = Math.hypot(n2[0], n2[1]) / Math.hypot(n3[0], n3[1]);
    } else {
      const f = Math.sqrt(f2);
      const num = (n2[0] * n2[0] + n2[1] * n2[1]) / (f * f) + n2[2] * n2[2];
      const dd = (n3[0] * n3[0] + n3[1] * n3[1]) / (f * f) + n3[2] * n3[2];
      ratio = Math.sqrt(num / dd);
    }
  }
  return isFinite(ratio) && ratio > 0.1 && ratio < 10 ? ratio : null;
}

/** Output size for a (possibly curved) quad in pixel space. */
export function quadSize(q: Pt[], mids: Pt[] | null, center?: Pt) {
  const edge = (a: Pt, b: Pt, m?: Pt) => (m ? dist(a, m) + dist(m, b) : dist(a, b));
  const top = edge(q[0], q[1], mids?.[0]);
  const right = edge(q[1], q[2], mids?.[1]);
  const bottom = edge(q[3], q[2], mids?.[2]);
  const left = edge(q[0], q[3], mids?.[3]);
  let w = Math.max(top, bottom), h = Math.max(left, right);
  if (center) {
    const r = perspectiveAspect(q, center.x, center.y);
    const heur = w / h;
    // trust the projective estimate unless it disagrees wildly with the naive one
    let ar = heur;
    if (r && r / heur < 1.25 && heur / r < 1.25) ar = r;
    // snap to standard paper shapes (A4 / Letter) when close
    for (const std of [1 / Math.SQRT2, Math.SQRT2, 8.5 / 11, 11 / 8.5]) if (Math.abs(ar - std) / std < 0.05) { ar = std; break; }
    const area = w * h;
    w = Math.sqrt(area * ar);
    h = Math.sqrt(area / ar);
  }
  return { w, h };
}

/**
 * Perspective warp with optional curved-edge (Coons patch) dewarping.
 * quad/mids are in source pixel coordinates.
 */
export function warp(src: Img, quad: Pt[], mids: Pt[] | null, outW: number, outH: number): Img {
  const H = squareToQuad(quad);
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sd = src.data, sw = src.width, sh = src.height;
  // edge displacement vectors for dewarping
  let D: Pt[] | null = null;
  if (mids) {
    const straight = [applyH(H, 0.5, 0), applyH(H, 1, 0.5), applyH(H, 0.5, 1), applyH(H, 0, 0.5)];
    D = mids.map((m, i) => ({ x: m.x - straight[i].x, y: m.y - straight[i].y }));
    if (D.every((d) => Math.hypot(d.x, d.y) < 0.5)) D = null;
  }
  const bu = new Float32Array(outW);
  for (let x = 0; x < outW; x++) {
    const u = (x + 0.5) / outW;
    bu[x] = 4 * u * (1 - u);
  }
  let o = 0;
  for (let y = 0; y < outH; y++) {
    const v = (y + 0.5) / outH;
    const bv = 4 * v * (1 - v);
    for (let x = 0; x < outW; x++, o += 4) {
      const u = (x + 0.5) / outW;
      const w = H.g * u + H.h * v + 1;
      let sx = (H.a * u + H.b * v + H.c) / w;
      let sy = (H.d * u + H.e * v + H.f) / w;
      if (D) {
        const b = bu[x];
        sx += (1 - v) * D[0].x * b + v * D[2].x * b + (1 - u) * D[3].x * bv + u * D[1].x * bv;
        sy += (1 - v) * D[0].y * b + v * D[2].y * b + (1 - u) * D[3].y * bv + u * D[1].y * bv;
      }
      sx -= 0.5;
      sy -= 0.5;
      if (sx < 0) sx = 0; else if (sx > sw - 1.001) sx = sw - 1.001;
      if (sy < 0) sy = 0; else if (sy > sh - 1.001) sy = sh - 1.001;
      const x0 = sx | 0, y0 = sy | 0;
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      out[o] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
      out[o + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
      out[o + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: outW, height: outH };
}

// ---------- filters ----------
function luminance(img: Img) {
  const n = img.width * img.height, d = img.data;
  const L = new Uint8ClampedArray(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return L;
}

function boxBlur1D(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horiz: boolean) {
  const len = horiz ? w : h, lines = horiz ? h : w;
  const step = horiz ? 1 : w, lstep = horiz ? w : 1;
  const inv = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = l * lstep;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[base + Math.min(len - 1, Math.max(0, k)) * step];
    for (let i = 0; i < len; i++) {
      dst[base + i * step] = acc * inv;
      const add = Math.min(len - 1, i + r + 1), rem = Math.max(0, i - r);
      acc += src[base + add * step] - src[base + rem * step];
    }
  }
}
function boxBlur(a: Float32Array, w: number, h: number, r: number, passes = 2) {
  const tmp = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    boxBlur1D(a, tmp, w, h, r, true);
    boxBlur1D(tmp, a, w, h, r, false);
  }
  return a;
}

/**
 * Estimate the paper background (illumination) of a channel: block maxima on a coarse grid,
 * dilate, smooth, then bilinear upsample. Returns full-res Float32 background.
 */
function background(ch: Uint8ClampedArray, w: number, h: number, cellsAcross = 90): Float32Array {
  const cell = Math.max(4, Math.round(Math.max(w, h) / cellsAcross));
  const sw = Math.ceil(w / cell), sh = Math.ceil(h / cell);
  const small = new Float32Array(sw * sh);
  // use a high percentile (2nd highest of sampled) for robustness against specks
  for (let cy = 0; cy < sh; cy++) {
    for (let cx = 0; cx < sw; cx++) {
      let m1 = 0, m2 = 0;
      const y1 = Math.min(h, (cy + 1) * cell), x1 = Math.min(w, (cx + 1) * cell);
      for (let y = cy * cell; y < y1; y += 2) {
        const row = y * w;
        for (let x = cx * cell; x < x1; x += 2) {
          const v = ch[row + x];
          if (v > m1) { m2 = m1; m1 = v; } else if (v > m2) m2 = v;
        }
      }
      small[cy * sw + cx] = m2 || m1;
    }
  }
  // dilate (max filter radius 1) to bridge cells covered by large glyphs
  const dil = new Float32Array(small.length);
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy >= 0 && yy < sh && xx >= 0 && xx < sw) m = Math.max(m, small[yy * sw + xx]);
        }
      dil[y * sw + x] = m;
    }
  boxBlur(dil, sw, sh, 2, 2);
  // bilinear upsample
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(sh - 1.001, Math.max(0, (y + 0.5) / cell - 0.5));
    const y0 = gy | 0, fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = Math.min(sw - 1.001, Math.max(0, (x + 0.5) / cell - 0.5));
      const x0 = gx | 0, fx = gx - x0;
      const i = y0 * sw + x0;
      const a = dil[i], b = dil[i + 1 < dil.length ? i + 1 : i];
      const c = dil[i + sw < dil.length ? i + sw : i], d = dil[i + sw + 1 < dil.length ? i + sw + 1 : i];
      out[y * w + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

/** Divide each channel by its estimated background: removes shadows & colour cast. strength 0..1 */
function normalizeColor(img: Img, strength = 1) {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  for (let c = 0; c < 3; c++) {
    const ch = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) ch[i] = d[i * 4 + c];
    const bg = background(ch, w, h);
    for (let i = 0; i < n; i++) {
      const b = Math.max(bg[i], 24);
      const v = ch[i];
      const nv = Math.min(255, (v / b) * 255 * 1.02);
      d[i * 4 + c] = v + (nv - v) * strength;
    }
  }
}

function normalizeGray(L: Uint8ClampedArray, w: number, h: number) {
  const bg = background(L, w, h);
  for (let i = 0; i < L.length; i++) L[i] = Math.min(255, (L[i] / Math.max(bg[i], 24)) * 255 * 1.02);
}

function percentile(L: Uint8ClampedArray, p: number) {
  const hist = new Uint32Array(256);
  const step = L.length > 400000 ? 3 : 1;
  let n = 0;
  for (let i = 0; i < L.length; i += step) { hist[L[i]]++; n++; }
  let acc = 0;
  const target = n * p;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
  return 255;
}

function otsu(L: Uint8ClampedArray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < L.length; i += 2) hist[L[i]]++;
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
  let sumB = 0, wB = 0, best = 0, th = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; th = t; }
  }
  return th;
}

function levelsLUT(black: number, white: number, gamma = 1) {
  const lut = new Uint8ClampedArray(256);
  const span = Math.max(1, white - black);
  for (let v = 0; v < 256; v++) {
    const t = Math.min(1, Math.max(0, (v - black) / span));
    lut[v] = Math.round(Math.pow(t, gamma) * 255);
  }
  return lut;
}

/** Unsharp mask on luminance, applied to all channels. */
function sharpen(img: Img, amount: number, radius = 1) {
  const { width: w, height: h, data: d } = img;
  const L = luminance(img);
  const blur = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) blur[i] = L[i];
  boxBlur(blur, w, h, radius, 1);
  for (let i = 0, j = 0; i < L.length; i++, j += 4) {
    const delta = (L[i] - blur[i]) * amount;
    d[j] += delta; d[j + 1] += delta; d[j + 2] += delta;
  }
}

function grayToImg(L: Uint8ClampedArray, img: Img) {
  const d = img.data;
  for (let i = 0, j = 0; i < L.length; i++, j += 4) { d[j] = d[j + 1] = d[j + 2] = L[i]; d[j + 3] = 255; }
}

/** Adjust luminance with a LUT while keeping chroma. */
function applyLumaLUT(img: Img, lut: Uint8ClampedArray) {
  const d = img.data;
  for (let j = 0; j < d.length; j += 4) {
    const l = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    const dl = lut[l] - l;
    d[j] += dl; d[j + 1] += dl; d[j + 2] += dl;
  }
}

function saturate(img: Img, s: number) {
  if (s === 1) return;
  const d = img.data;
  for (let j = 0; j < d.length; j += 4) {
    const l = d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114;
    d[j] = l + (d[j] - l) * s; d[j + 1] = l + (d[j + 1] - l) * s; d[j + 2] = l + (d[j + 2] - l) * s;
  }
}

function chalkBoard(L: Uint8ClampedArray) {
  let mean = 0, light = 0;
  for (let i = 0; i < L.length; i++) mean += L[i];
  mean /= L.length;
  if (mean > 100) return false;
  for (let i = 0; i < L.length; i++) if (L[i] > mean + 45) light++;
  const f = light / L.length;
  return f > 0.008 && f < 0.4;
}

function glareFraction(img: Img) {
  const d = img.data;
  const step = Math.max(1, Math.floor(d.length / 4 / 8000));
  let n = 0, g = 0;
  for (let i = 0; i < d.length; i += step * 4) {
    n++;
    const l = (d[i] * 30 + d[i + 1] * 59 + d[i + 2] * 11) / 100;
    if (l > 248) g++;
  }
  return g / Math.max(1, n);
}

/** Put red and blue stamp ink back after a clean-up pass. Ordinary paper is left alone. */
function restoreStamps(img: Img, orig: Uint8ClampedArray) {
  const d = img.data;
  for (let j = 0; j < d.length; j += 4) {
    const r = orig[j], g = orig[j + 1], b = orig[j + 2];
    const red = r > 170 && g < 120 && b < 120 && r > g + 70 && r > b + 70;
    const blue = b > 140 && r < 110 && g < 150 && b > r + 50;
    if (red || blue) { d[j] = r; d[j + 1] = g; d[j + 2] = b; }
  }
}

/** Pull specular blobs down toward the local paper brightness. */
function suppressGlare(img: Img) {
  const { width: w, height: h, data: d } = img;
  const L = luminance(img);
  const bg = background(L, w, h, 36);
  for (let i = 0, j = 0; i < L.length; i++, j += 4) {
    if (L[i] < 236 || L[i] < bg[i] + 18) continue;
    const k = Math.min(0.85, (L[i] - bg[i]) / 80);
    const t = Math.min(255, bg[i]);
    d[j] = d[j] * (1 - k) + t * k;
    d[j + 1] = d[j + 1] * (1 - k) + t * k;
    d[j + 2] = d[j + 2] * (1 - k) + t * k;
  }
}

/** Main enhancement pipeline. Mutates img. */
export function enhance(img: Img, p: Pick<PageParams, 'mode' | 'brightness' | 'contrast' | 'saturation' | 'shadow' | 'sharpen'>) {
  const { width: w, height: h } = img;
  const scale = Math.max(w, h) / 1600; // sharpen radius relative to resolution
  const sr = scale > 1.3 ? 2 : 1;
  const mode: Mode = p.mode;
  switch (mode) {
    case 'original':
      if (p.shadow) normalizeColor(img, 0.0);
      break;
    case 'color': {
      if (p.shadow) normalizeColor(img, 1);
      const L = luminance(img);
      applyLumaLUT(img, levelsLUT(percentile(L, 0.01) * 0.8, 252, 1.15));
      saturate(img, 1.25);
      if (p.sharpen) sharpen(img, 0.6, sr);
      break;
    }
    case 'bw': {
      const L = luminance(img);
      if (p.shadow) normalizeGray(L, w, h);
      const lut = levelsLUT(Math.max(0, percentile(L, 0.02) - 10), p.shadow ? 245 : percentile(L, 0.97), 1.25);
      for (let i = 0; i < L.length; i++) L[i] = lut[L[i]];
      grayToImg(L, img);
      if (p.sharpen) sharpen(img, 0.7, sr);
      break;
    }
    case 'textBoost': {
      const orig = new Uint8ClampedArray(img.data);
      let L0 = luminance(img);
      // Chalk on a dark board is inverted before the normal clean-up, so a blackboard
      // scan becomes black text on white without a separate mode.
      if (chalkBoard(L0)) for (let i = 0; i < L0.length; i++) {
        const v = 255 - L0[i];
        const j = i * 4;
        img.data[j] = img.data[j + 1] = img.data[j + 2] = v;
      }
      if (glareFraction(img) > 0.03) suppressGlare(img);
      if (p.shadow) normalizeColor(img, 1);
      const L = luminance(img);
      const black = Math.max(0, percentile(L, 0.03) + 10);
      applyLumaLUT(img, levelsLUT(black, p.shadow ? 238 : percentile(L, 0.95), 1.6));
      saturate(img, 1.1);
      if (p.sharpen) sharpen(img, 1.1, sr);
      restoreStamps(img, orig);
      break;
    }
    case 'cleanPaper': {
      if (p.shadow) normalizeColor(img, 1);
      else {
        const L = luminance(img);
        applyLumaLUT(img, levelsLUT(0, percentile(L, 0.9), 1));
      }
      const d = img.data;
      for (let j = 0; j < d.length; j += 4) {
        const r = d[j], g = d[j + 1], b = d[j + 2];
        const l = r * 0.299 + g * 0.587 + b * 0.114;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (l > 205 && mx - mn < 40) { d[j] = d[j + 1] = d[j + 2] = 255; }
        else if (l > 175) { const t = (l - 175) / 30; d[j] += (255 - r) * t * 0.7; d[j + 1] += (255 - g) * t * 0.7; d[j + 2] += (255 - b) * t * 0.7; }
      }
      applyLumaLUT(img, levelsLUT(20, 255, 1.2));
      if (p.sharpen) sharpen(img, 0.6, sr);
      break;
    }
    case 'highContrast': {
      const L = luminance(img);
      let mean = 0;
      for (let i = 0; i < L.length; i++) mean += L[i];
      mean /= L.length;
      // White chalk on a blackboard: flip so the board becomes the paper.
      if (mean < 105) for (let i = 0; i < L.length; i++) L[i] = 255 - L[i];
      if (p.shadow) normalizeGray(L, w, h);
      if (p.sharpen) {
        const tmp = { data: new Uint8ClampedArray(L.length * 4), width: w, height: h };
        grayToImg(L, tmp); sharpen(tmp, 0.8, sr);
        for (let i = 0; i < L.length; i++) L[i] = tmp.data[i * 4];
      }
      let t = otsu(L);
      t = Math.min(215, Math.max(90, t + 12));
      for (let i = 0; i < L.length; i++) L[i] = L[i] < t ? 0 : 255;
      grayToImg(L, img);
      break;
    }
    case 'photo': {
      if (glareFraction(img) > 0.03) suppressGlare(img);
      if (p.shadow) normalizeColor(img, 0.55);
      const L = luminance(img);
      applyLumaLUT(img, levelsLUT(percentile(L, 0.005), Math.max(200, percentile(L, 0.995)), 1));
      saturate(img, 1.12);
      if (p.sharpen) sharpen(img, 0.35, sr);
      break;
    }
  }
  adjust(img, p.brightness, p.contrast, p.saturation);
  return img;
}

/** brightness/contrast/saturation sliders in -100..100 */
export function adjust(img: Img, b: number, c: number, s: number) {
  if (b || c) {
    const lut = new Uint8ClampedArray(256);
    const cf = c >= 0 ? 1 + c / 60 : 1 + c / 110;
    for (let v = 0; v < 256; v++) lut[v] = (v - 128) * cf + 128 + b * 1.1;
    const d = img.data;
    for (let j = 0; j < d.length; j += 4) { d[j] = lut[d[j]]; d[j + 1] = lut[d[j + 1]]; d[j + 2] = lut[d[j + 2]]; }
  }
  if (s) saturate(img, 1 + s / 100);
}

/** Detect residual text skew (degrees) by maximizing horizontal projection variance. */
export function detectSkew(img: Img): number {
  const { width: w, height: h } = img;
  const L = luminance(img);
  normalizeGray(L, w, h);
  const t = Math.min(200, otsu(L));
  const pts: number[] = [];
  const step = Math.max(1, Math.round(Math.max(w, h) / 700));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (L[y * w + x] < t) pts.push(x - w / 2, y - h / 2);
  if (pts.length < 200) return 0;
  const score = (deg: number) => {
    const r = (deg * Math.PI) / 180, sn = Math.sin(r), cs = Math.cos(r);
    const bins = new Float64Array(Math.ceil(Math.hypot(w, h) / step) + 4);
    const off = bins.length / 2;
    for (let i = 0; i < pts.length; i += 2) {
      const yy = (-pts[i] * sn + pts[i + 1] * cs) / step + off;
      bins[yy | 0]++;
    }
    let s = 0;
    for (let i = 0; i < bins.length; i++) s += bins[i] * bins[i];
    return s;
  };
  let best = 0, bestS = -1;
  for (let a = -10; a <= 10; a += 0.5) { const s = score(a); if (s > bestS) { bestS = s; best = a; } }
  const c = best;
  for (let a = c - 0.5; a <= c + 0.5; a += 0.1) { const s = score(a); if (s > bestS) { bestS = s; best = a; } }
  return Math.round(best * 10) / 10;
}
