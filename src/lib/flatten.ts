/**
 * Text-line page flattening (VFlat-style geometric dewarp).
 *
 * Perspective warp only makes the page outline a rectangle. A curled or wrinkled sheet still
 * bends the text. This estimates a dense displacement on the rectified page:
 *
 * 1. Text ink is a horizontal high-pass, so wide gutter shadows and fingers do not look like lines.
 * 2. Text lines are tracked across vertical strips (ordered peak matching). Each line is pulled
 *    straight to its own median — a cubic-sheet / baseline model, including one-sided book curl
 *    that a pure skew would throw away.
 * 3. A local cross-correlation pass fills the residual (fine wrinkles) and is the fallback when
 *    there are not enough lines to track.
 * 4. Where glyph width is compressed along the curl (gutter foreshortening), a horizontal
 *    scale field expands it back. Uniform pages get no horizontal warp.
 *
 * Resampling is out(x, y) = in(x + Dx, y + Dy).
 */
import type { Img } from './imaging';

export interface FlowField {
  gx: number;
  gy: number;
  d: Float32Array; // vertical displacement, fraction of height, row-major strip-major
  dx?: Float32Array; // horizontal displacement, fraction of width, same layout
  strength: number;
}

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

/**
 * Narrow dark strokes only. A wide horizontal blur is the local paper brightness, so a gutter
 * shadow or a finger (both wide) cancels out and text strokes remain.
 */
/** Lift a dark gutter / uneven shade so text strokes survive on both pages of a spread. */
function liftShade(g: Float32Array, w: number, h: number) {
  const rad = Math.max(10, Math.round(Math.min(w, h) / 16));
  const bg = new Float32Array(g);
  // separable box blur, two passes
  const tmp = new Float32Array(g.length);
  const blur1 = (src: Float32Array, dst: Float32Array, horiz: boolean) => {
    const len = horiz ? w : h, lines = horiz ? h : w, step = horiz ? 1 : w, lstep = horiz ? w : 1;
    const inv = 1 / (2 * rad + 1);
    for (let l = 0; l < lines; l++) {
      const base = l * lstep;
      let acc = 0;
      for (let k = -rad; k <= rad; k++) acc += src[base + Math.min(len - 1, Math.max(0, k)) * step];
      for (let i = 0; i < len; i++) {
        dst[base + i * step] = acc * inv;
        acc += src[base + Math.min(len - 1, i + rad + 1) * step] - src[base + Math.max(0, i - rad) * step];
      }
    }
  };
  blur1(bg, tmp, true); blur1(tmp, bg, false);
  blur1(bg, tmp, true); blur1(tmp, bg, false);
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = Math.min(255, (g[i] / Math.max(40, bg[i])) * 210);
  return out;
}

function textInk(g: Float32Array, w: number, h: number) {
  g = liftShade(g, w, h);
  const r = Math.max(6, Math.round(w / 14));
  const ink = new Float32Array(w * h);
  const pref = new Float64Array(w + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    pref[0] = 0;
    for (let x = 0; x < w; x++) pref[x + 1] = pref[x] + g[o + x];
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const m = (pref[x1 + 1] - pref[x0]) / (x1 - x0 + 1);
      const v = m - g[o + x] - 3;
      ink[o + x] = v > 0 ? Math.min(48, v) : 0;
    }
  }
  return ink;
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
  const ink = textInk(g, w, h);
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
  const maxS = Math.max(3, Math.round(h * 0.012)); // residual pass: small steps only, the sheet model handles the big curl
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
  // This pass only keeps curvature that is not a straight tilt. The sheet model owns
  // the large one-sided book bend; applying a tilt here would shear an already-flat page.
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
  if (maxAbs < 0.0015) return null;
  return { gx: STRIPS, gy, d, strength: maxAbs };
}

function solve3(A: number[][], b: number[]) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-8) return null;
    if (p !== c) { const t = M[c]; M[c] = M[p]; M[p] = t; }
    const piv = M[c][c];
    for (let k = c; k < 4; k++) M[c][k] /= piv;
    for (let r = 0; r < 3; r++) if (r !== c) {
      const f = M[r][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3], M[1][3], M[2][3]];
}

function fitQuadratic(xs: number[], ys: number[]) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i], x2 = x * x;
    s0++; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
    t0 += y; t1 += y * x; t2 += y * x2;
  }
  const abc = solve3([[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]], [t0, t1, t2]);
  if (!abc) return null;
  const [a, b, c] = abc;
  return (x: number) => a + b * x + c * x * x;
}

function linePitchOf(p: Float32Array) {
  const n = p.length;
  let best = Math.round(n * 0.034), bestS = -1;
  const maxLag = Math.round(n * 0.08), minLag = Math.round(n * 0.016);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let y = 0; y < n - lag; y += 2) s += p[y] * p[y + lag];
    if (s > bestS) { bestS = s; best = lag; }
  }
  return Math.max(8, best);
}

/** Absolute shift s so that b[i + s] lines up with a[i], searched near `expect`. */
function corrShift(a: Float32Array, b: Float32Array, expect: number, radius: number) {
  const n = Math.min(a.length, b.length);
  let best = expect, bestS = -2, second = -2;
  const s0 = Math.round(expect - radius), s1 = Math.round(expect + radius);
  for (let s = s0; s <= s1; s++) {
    let ma = 0, mb = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      const j = i + s;
      if (j < 0 || j >= n) continue;
      ma += a[i]; mb += b[j]; cnt++;
    }
    if (cnt < n * 0.65) continue;
    ma /= cnt; mb /= cnt;
    let num = 0, ea = 0, eb = 0;
    for (let i = 0; i < n; i++) {
      const j = i + s;
      if (j < 0 || j >= n) continue;
      const da = a[i] - ma, db = b[j] - mb;
      num += da * db; ea += da * da; eb += db * db;
    }
    const sc = ea > 1e-3 && eb > 1e-6 ? num / Math.sqrt(ea * eb) : -2;
    if (sc > bestS) { second = bestS; bestS = sc; best = s; }
    else if (sc > second) second = sc;
  }
  if (bestS < 0.3) return null;
  // parabolic sub-pixel around the integer peak
  let off = 0;
  const sm = (s: number) => {
    let ma = 0, mb = 0, cnt = 0;
    for (let i = 0; i < n; i++) { const j = i + s; if (j < 0 || j >= n) continue; ma += a[i]; mb += b[j]; cnt++; }
    if (!cnt) return -2;
    ma /= cnt; mb /= cnt;
    let num = 0, ea = 0, eb = 0;
    for (let i = 0; i < n; i++) { const j = i + s; if (j < 0 || j >= n) continue; const da = a[i] - ma, db = b[j] - mb; num += da * db; ea += da * da; eb += db * db; }
    return ea > 1e-3 && eb > 1e-6 ? num / Math.sqrt(ea * eb) : -2;
  };
  const l = sm(best - 1), r = sm(best + 1), den = l - 2 * bestS + r;
  if (den < 0) off = (0.5 * (l - r)) / den;
  return { s: best + off, score: bestS, unique: bestS - second > 0.05 };
}

/**
 * Cubic-sheet style dewarp on the rectified page.
 * The page is split into horizontal bands. In each band every vertical strip is
 * aligned to the centre strip, walking outward so a large gutter bow can accumulate
 * without hopping onto the next text line. Bands are blended into D(x, y).
 */
function estimateFromLines(img: Img): FlowField | null {
  const { g, w, h } = grayOf(img, 640);
  const ink = textInk(g, w, h);
  const BANDS = 5;
  const ref = Math.floor(STRIPS / 2);
  const sw = w / STRIPS;
  const stripX = (i: number) => [Math.round(i * sw), Math.max(Math.round(i * sw) + 1, Math.round((i + 1) * sw))] as const;
  const profiles: Float32Array[][] = [];
  for (let b = 0; b < BANDS; b++) {
    const y0 = Math.round(h * (0.06 + (b / BANDS) * 0.88));
    const y1 = Math.round(h * (0.06 + ((b + 1) / BANDS) * 0.88));
    const row: Float32Array[] = [];
    for (let i = 0; i < STRIPS; i++) {
      const [x0, x1] = stripX(i);
      const n = Math.max(1, y1 - y0);
      const p = new Float32Array(n);
      for (let y = y0; y < y1; y++) {
        let s = 0;
        const o = y * w;
        for (let x = x0; x < x1; x++) s += ink[o + x];
        p[y - y0] = s / (x1 - x0);
      }
      row.push(smooth1(p, Math.max(1, n / 80)));
    }
    profiles.push(row);
  }
  // Pitch from the full page, not a short band (a band is only a couple of lines and
  // its autocorrelation locks onto noise).
  const full = new Float32Array(h);
  {
    const [x0, x1] = stripX(ref);
    for (let y = 0; y < h; y++) {
      let s = 0;
      const o = y * w;
      for (let x = x0; x < x1; x++) s += ink[o + x];
      full[y] = s / (x1 - x0);
    }
  }
  const pitch = linePitchOf(smooth1(full, Math.max(1, h / 400)));
  const radius = Math.max(6, Math.round(pitch * 0.45));
  const bandShift: number[][] = [];
  for (let b = 0; b < BANDS; b++) {
    const shift = new Array(STRIPS).fill(0);
    shift[ref] = 0;
    for (const dir of [1, -1]) {
      for (let i = ref + dir; i >= 0 && i < STRIPS; i += dir) {
        const r = corrShift(profiles[b][ref], profiles[b][i], shift[i - dir], radius);
        shift[i] = r && r.score >= 0.45 ? r.s : shift[i - dir];
      }
    }
    // light smooth so a single noisy strip cannot kink the sheet
    const sm = shift.slice();
    for (let i = 1; i < STRIPS - 1; i++) sm[i] = shift[i] * 0.5 + (shift[i - 1] + shift[i + 1]) * 0.25;
    bandShift.push(sm);
  }
  // Bands must agree. A real sheet sags the same way from top to bottom (only the
  // amplitude changes); a band that locked onto the next text line is thrown out,
  // and the kept profile is projected onto a quadratic so it cannot shear the page.
  const median = new Array(STRIPS).fill(0);
  for (let i = 0; i < STRIPS; i++) {
    const col = bandShift.map((s) => s[i]).sort((a, b) => a - b);
    median[i] = col[col.length >> 1];
  }
  // Keep the measured profile (lightly smoothed). A single quadratic cannot
  // follow the steep bend right next to a book gutter.
  const sheet = median.map((v, i) => {
    const l = median[Math.max(0, i - 1)], r = median[Math.min(STRIPS - 1, i + 1)];
    return v * 0.5 + (l + r) * 0.25;
  });
  let maxAbsPx = 0;
  for (const v of sheet) maxAbsPx = Math.max(maxAbsPx, Math.abs(v));
  if (maxAbsPx < h * 0.004) return null;
  const gy = Math.round(1 / STEP) + 1;
  const d = new Float32Array(STRIPS * gy);
  for (let i = 0; i < STRIPS; i++) {
    // mild vertical gain: lower bands of a book curl a little more than upper ones
    const gains = bandShift.map((s) => {
      let num = 0, den = 0;
      for (let k = 0; k < STRIPS; k++) { num += s[k] * sheet[k]; den += sheet[k] * sheet[k]; }
      return den > 1 ? Math.max(0.5, Math.min(1.6, num / den)) : 1;
    });
    for (let j = 0; j < gy; j++) {
      const yn = j * STEP;
      const gb = yn * (BANDS - 1);
      const b0 = Math.max(0, Math.min(BANDS - 2, Math.floor(gb)));
      const t = gb - b0;
      const gain = gains[b0] * (1 - t) + gains[b0 + 1] * t;
      d[i * gy + j] = Math.max(-0.12, Math.min(0.12, (sheet[i] * gain) / h));
    }
  }
  let maxAbs = 0;
  for (const v of d) maxAbs = Math.max(maxAbs, Math.abs(v));
  if (maxAbs < 0.004) return null;
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

function addField(total: FlowField, extra: FlowField) {
  for (let i = 0; i < total.d.length; i++) total.d[i] = Math.max(-0.16, Math.min(0.16, total.d[i] + extra.d[i]));
  if (extra.dx) {
    if (!total.dx) total.dx = new Float32Array(total.d.length);
    for (let i = 0; i < total.dx.length; i++) total.dx[i] = Math.max(-0.06, Math.min(0.06, total.dx[i] + (extra.dx[i] || 0)));
  }
}

/**
 * Solid table rules and dotted/dashed leader lines. These must stay straight, so the
 * displacement along each one is replaced by a smooth quadratic instead of a wiggly field.
 */
function ruleRows(ink: Float32Array, w: number, h: number) {
  const ys: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    let dark = 0, runs = 0, runLen = 0, short = 0, prev = false;
    for (let x = 0; x < w; x++) {
      const on = ink[y * w + x] > 1.2 || ink[(y - 1) * w + x] > 1.2 || ink[(y + 1) * w + x] > 1.2;
      if (on) {
        dark++;
        if (!prev) { runs++; runLen = 1; } else runLen++;
      } else if (prev) {
        if (runLen <= 3) short++;
        prev = false;
      }
      prev = on;
    }
    const cov = dark / w;
    const solid = cov > 0.5;
    const dotted = runs >= Math.max(8, w / 48) && short >= runs * 0.55 && cov > 0.025 && cov < 0.4;
    if ((solid || dotted) && (!ys.length || y - ys[ys.length - 1] > 4)) ys.push(y);
  }
  return ys;
}

function enforceRules(img: Img, f: FlowField) {
  const { g, w, h } = grayOf(img, 640);
  const ink = textInk(g, w, h);
  const rules = ruleRows(ink, w, h);
  if (rules.length < 2) return;
  for (const y of rules) {
    const j = Math.max(0, Math.min(f.gy - 1, Math.round((y / h) * (f.gy - 1))));
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < f.gx; i++) { xs.push((i + 0.5) / f.gx); ys.push(f.d[i * f.gy + j]); }
    const q = fitQuadratic(xs, ys);
    if (!q) continue;
    for (let i = 0; i < f.gx; i++) {
      const v = Math.max(-0.14, Math.min(0.14, q((i + 0.5) / f.gx)));
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= f.gy) continue;
        const idx = i * f.gy + jj;
        f.d[idx] = f.d[idx] * 0.2 + v * 0.8;
      }
    }
  }
}

function calmGutter(f: FlowField) {
  const limit = 0.018;
  const next = new Float32Array(f.d);
  for (let i = 0; i < f.gx; i++) {
    const left = Math.max(0, i - 1), right = Math.min(f.gx - 1, i + 1);
    for (let j = 0; j < f.gy; j++) {
      const v = f.d[i * f.gy + j];
      const l = f.d[left * f.gy + j], r = f.d[right * f.gy + j];
      const edge = i === 0 || i === f.gx - 1;
      const neighbour = i === 0 ? r : l;
      if (edge && Math.abs(v - neighbour) > limit) next[i * f.gy + j] = neighbour;
      else if (!edge && Math.abs(v - l) > limit && Math.abs(v - r) > limit && (v - l) * (v - r) > 0) next[i * f.gy + j] = (l + r) / 2;
    }
  }
  f.d.set(next);
}

/** Mean absolute disagreement of strip shifts versus the centre strip, in pixels. */
export function lineSpread(img: Img) {
  const { g, w, h } = grayOf(img, 420);
  const ink = textInk(g, w, h);
  const n = 8;
  const ref = n >> 1;
  const sw = w / n;
  const prof: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    const x0 = Math.round(i * sw), x1 = Math.max(x0 + 1, Math.round((i + 1) * sw));
    const p = new Float32Array(h);
    for (let y = Math.round(h * 0.1); y < h * 0.9; y++) {
      let s = 0;
      for (let x = x0; x < x1; x++) s += ink[y * w + x];
      p[y] = s / (x1 - x0);
    }
    prof.push(p);
  }
  const shifts: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = corrShift(prof[ref], prof[i], 0, Math.round(h * 0.08));
    shifts.push(r ? r.s : 0);
  }
  const sorted = [...shifts].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  let acc = 0;
  for (const s of shifts) acc += Math.abs(s - med);
  return acc / n;
}

/** Estimate the displacement field (baselines, then residual correlation). Null when the page is already flat. */
export function estimateFlow(img: Img, iters = 2): FlowField | null {
  let small = shrink(img, 720);
  let total: FlowField | null = null;
  const sheet = estimateFromLines(small);
  if (sheet) {
    const before = lineSpread(small);
    const after = lineSpread(applyFlow(small, sheet));
    // keep the cubic sheet only when it actually straightens lines
    if (after < before * 0.92) total = sheet;
  }
  for (let it = 0; it < iters; it++) {
    const f = estimateOnce(small);
    if (f) {
      if (!total) total = { ...f, d: new Float32Array(f.d), dx: f.dx ? new Float32Array(f.dx) : undefined };
      else addField(total, f);
    }
    if (!total) break;
    if (it < iters - 1) small = applyFlow(shrink(img, 720), total);
  }
  if (!total) return null;
  // A gutter shadow can lock the outermost strip onto the next text line, which
  // bends the right-hand page the wrong way. A real sheet cannot jump that far
  // between two neighbouring strips, so pull the spike back to its neighbour.
  calmGutter(total);
  enforceRules(small, total);
  let m = 0;
  for (const v of total.d) m = Math.max(m, Math.abs(v));
  if (total.dx) for (const v of total.dx) m = Math.max(m, Math.abs(v));
  total.strength = m;
  if (m < 0.008) return null;
  return total;
}

function sampleBilinear(data: Uint8ClampedArray, w: number, h: number, x: number, y: number, out: Uint8ClampedArray, o: number) {
  if (x < 0) x = 0; else if (x > w - 1.001) x = w - 1.001;
  if (y < 0) y = 0; else if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0, y0 = y | 0;
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  out[o] = data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
  out[o + 1] = data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
  out[o + 2] = data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;
  out[o + 3] = 255;
}

/**
 * Apply a UVDoc sampling grid. `grid` is x then y, each 45×31, in normalized −1..1.
 * out(x, y) = in(grid). The geometric sheet can still run on the result.
 */
export function applyUvGrid(img: Img, grid: Float32Array): Img {
  const GH = 45, GW = 31;
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(data.length);
  const at = (yy: number, xx: number, ch: number) => grid[ch * GH * GW + yy * GW + xx];
  for (let y = 0; y < h; y++) {
    const gy = h === 1 ? 0 : (y / (h - 1)) * (GH - 1);
    const y0 = Math.min(GH - 2, gy | 0), ty = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = w === 1 ? 0 : (x / (w - 1)) * (GW - 1);
      const x0 = Math.min(GW - 2, gx | 0), tx = gx - x0;
      const sx = at(y0, x0, 0) * (1 - tx) * (1 - ty) + at(y0, x0 + 1, 0) * tx * (1 - ty) + at(y0 + 1, x0, 0) * (1 - tx) * ty + at(y0 + 1, x0 + 1, 0) * tx * ty;
      const sy = at(y0, x0, 1) * (1 - tx) * (1 - ty) + at(y0, x0 + 1, 1) * tx * (1 - ty) + at(y0 + 1, x0, 1) * (1 - tx) * ty + at(y0 + 1, x0 + 1, 1) * tx * ty;
      sampleBilinear(data, w, h, ((sx + 1) / 2) * (w - 1), ((sy + 1) / 2) * (h - 1), out, (y * w + x) * 4);
    }
  }
  return { data: out, width: w, height: h };
}

/** Resample: out(x, y) = in(x + Dx, y + Dy). */
export function applyFlow(img: Img, f: FlowField): Img {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(data.length);
  const col = new Float32Array(f.gy);
  const colX = new Float32Array(f.gy);
  const disp = new Float32Array(h);
  const dispX = new Float32Array(h);
  const hasX = !!f.dx;
  for (let x = 0; x < w; x++) {
    const fx = (x + 0.5) / w * f.gx - 0.5;
    const i0 = Math.max(0, Math.min(f.gx - 1, Math.floor(fx))), i1 = Math.min(f.gx - 1, i0 + 1), tx = Math.max(0, Math.min(1, fx - i0));
    for (let j = 0; j < f.gy; j++) {
      col[j] = (f.d[i0 * f.gy + j] * (1 - tx) + f.d[i1 * f.gy + j] * tx) * h;
      if (hasX) colX[j] = (f.dx![i0 * f.gy + j] * (1 - tx) + f.dx![i1 * f.gy + j] * tx) * w;
    }
    for (let y = 0; y < h; y++) {
      const t = (y / h) * (f.gy - 1);
      disp[y] = interp(col, t);
      if (hasX) dispX[y] = interp(colX, t);
    }
    for (let y = 0; y < h; y++) {
      sampleBilinear(data, w, h, x + (hasX ? dispX[y] : 0), y + disp[y], out, (y * w + x) * 4);
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Inpaint skin-coloured blobs that touch the page border (a finger holding the sheet).
 * Components that do not touch the border, or that cover the middle of the page, are left alone
 * so a photo of a person printed on the document is not erased.
 */
export function removeFingers(img: Img): Img {
  const { width: w, height: h, data } = img;
  const skin = new Uint8Array(w * h);
  let count = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const yb = (r * 77 + g * 150 + b * 29) >> 8;
    const cb = 128 - Math.round((0.168736 * r + 0.331264 * g - 0.5 * b));
    const cr = 128 + Math.round((0.5 * r - 0.418688 * g - 0.081312 * b));
    if (yb > 50 && cb > 77 && cb < 135 && cr > 135 && cr < 180 && r > g && r > b - 10) { skin[y * w + x] = 1; count++; }
  }
  if (count < 40 || count > w * h * 0.12) return img;
  // flood only components that touch the outer 2% frame
  const seen = new Uint8Array(w * h);
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  const stack: number[] = [];
  const blobs: number[][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const edge = x < band || y < band || x >= w - band || y >= h - band;
    const id = y * w + x;
    if (!edge || !skin[id] || seen[id]) continue;
    const blob: number[] = [];
    stack.push(id); seen[id] = 1;
    let touches = true;
    let minX = x, maxX = x, minY = y, maxY = y;
    while (stack.length) {
      const p = stack.pop()!;
      blob.push(p);
      const px = p % w, py = (p / w) | 0;
      if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py;
      const nbs = [p - 1, p + 1, p - w, p + w];
      for (const n of nbs) {
        if (n < 0 || n >= skin.length || seen[n] || !skin[n]) continue;
        const nx = n % w, ny = (n / w) | 0;
        if (Math.abs(nx - px) + Math.abs(ny - py) !== 1) continue;
        seen[n] = 1; stack.push(n);
      }
    }
    const bw = maxX - minX, bh = maxY - minY;
    // a finger is a compact blob on the rim, not a long streak of shadow
    if (touches && blob.length > 30 && blob.length < w * h * 0.08 && bw < w * 0.45 && bh < h * 0.45) blobs.push(blob);
  }
  if (!blobs.length) return img;
  const out = new Uint8ClampedArray(data);
  const mask = new Uint8Array(w * h);
  for (const blob of blobs) for (const p of blob) mask[p] = 1;
  for (const blob of blobs) {
    for (const p of blob) {
      const px = p % w, py = (p / w) | 0;
      // step inward (toward the page centre) until paper
      const dx = px < w / 2 ? 1 : -1, dy = py < h / 2 ? 1 : -1;
      let sx = px, sy = py, found = false;
      for (let s = 0; s < Math.max(w, h); s++) {
        sx += dx; sy += dy;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) break;
        if (!mask[sy * w + sx]) { found = true; break; }
      }
      const o = p * 4;
      if (!found) continue;
      const q = (sy * w + sx) * 4;
      out[o] = data[q]; out[o + 1] = data[q + 1]; out[o + 2] = data[q + 2]; out[o + 3] = 255;
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
