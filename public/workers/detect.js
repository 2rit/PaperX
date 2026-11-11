/* PAPERX document detector — classic worker, OpenCV.js (loaded lazily, fully on-device). */
/* global cv, importScripts */
let ready = null;
function loadCV() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    try {
      importScripts('../vendor/opencv/opencv.js');
    } catch (e) {
      reject(e);
      return;
    }
    const c = self.cv;
    if (c && c.Mat) return resolve(c);
    if (c && typeof c.then === 'function') {
      c.then((m) => {
        if (m && m.then) delete m.then; // avoid thenable recursion
        self.cv = m;
        resolve(m);
      }, reject);
    } else if (c) {
      c.onRuntimeInitialized = () => resolve(c);
    } else reject(new Error('OpenCV failed to load'));
  });
  return ready;
}

function orderCorners(pts) {
  // TL, TR, BR, BL using centroid angles (robust for strongly rotated quads)
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // sorted clockwise starting from about -180deg (left). find TL as min x+y
  let start = 0, best = Infinity;
  sorted.forEach((p, i) => { const s = p.x + p.y; if (s < best) { best = s; start = i; } });
  return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]);
}

function polyArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) { const p = q[i], n = q[(i + 1) % q.length]; a += p.x * n.y - n.x * p.y; }
  return Math.abs(a) / 2;
}

function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const s = Math.sign(cr);
    if (s === 0) continue;
    if (sign === 0) sign = s; else if (s !== sign) return false;
  }
  return true;
}

function minAngleOk(q) {
  for (let i = 0; i < 4; i++) {
    const p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4];
    const v1x = p.x - c.x, v1y = p.y - c.y, v2x = n.x - c.x, v2y = n.y - c.y;
    const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) + 1e-9);
    const ang = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
    if (ang < 45 || ang > 135) return false;
  }
  return true;
}

/** Border-connected skin (a hand holding the sheet). Interior skin — a photo on the page — is kept. */
function handMask(src) {
  const w = src.cols, h = src.rows, data = src.data;
  const skin = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < skin.length; p++, i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const cb = 128 - (0.168736 * r + 0.331264 * g - 0.5 * b);
    const cr = 128 + (0.5 * r - 0.418688 * g - 0.081312 * b);
    if (r > 95 && r > g + 8 && cr > 138 && cr < 185 && cb > 78 && cb < 132) skin[p] = 1;
  }
  const seen = new Uint8Array(w * h);
  const stack = [];
  const push = (p) => { if (p >= 0 && p < skin.length && skin[p] && !seen[p]) { seen[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop();
    const x = p % w;
    if (x > 0) push(p - 1);
    if (x + 1 < w) push(p + 1);
    push(p - w);
    push(p + w);
  }
  const mask = cv.Mat.zeros(h, w, cv.CV_8UC1);
  const md = mask.data;
  let n = 0;
  for (let p = 0; p < seen.length; p++) if (seen[p]) { md[p] = 255; n++; }
  mask._count = n;
  return mask;
}

function contourPts(cnt) {
  const d = cnt.data32S, out = [];
  for (let i = 0; i < d.length; i += 2) out.push({ x: d[i], y: d[i + 1] });
  return out;
}

/** midpoint of each side pulled toward the actual contour (for curved page dewarping). */
function edgeMids(q, pts) {
  const mids = [];
  for (let s = 0; s < 4; s++) {
    const A = q[s], B = q[(s + 1) % 4];
    const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L, ny = dx / L;
    const offs = [];
    for (const p of pts) {
      const t = ((p.x - A.x) * dx + (p.y - A.y) * dy) / (L * L);
      if (t < 0.38 || t > 0.62) continue;
      const off = (p.x - A.x) * nx + (p.y - A.y) * ny;
      if (Math.abs(off) < L * 0.12) offs.push(off);
    }
    let off = 0;
    if (offs.length) { offs.sort((a, b) => a - b); off = offs[offs.length >> 1]; }
    if (Math.abs(off) < L * 0.04) off = 0;
    mids.push({ x: (A.x + B.x) / 2 + nx * off, y: (A.y + B.y) / 2 + ny * off, curved: off !== 0 });
  }
  return mids;
}

/** How much of each side sits on a real edge. Color does not matter, only the boundary. */
function edgeSupport(q, edge) {
  const w = edge.cols, h = edge.rows, data = edge.data;
  let sum = 0, worst = 1;
  for (let s = 0; s < 4; s++) {
    const A = q[s], B = q[(s + 1) % 4];
    const dx = B.x - A.x, dy = B.y - A.y;
    const L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L, ny = dx / L;
    let hits = 0, n = 0;
    for (let t = 0.08; t <= 0.92; t += 0.07) {
      const x = A.x + dx * t, y = A.y + dy * t;
      let hit = 0;
      for (let o = -5; o <= 5; o++) {
        const xx = (x + nx * o) | 0, yy = (y + ny * o) | 0;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && data[yy * w + xx]) { hit = 1; break; }
      }
      hits += hit;
      n++;
    }
    const f = hits / n;
    sum += f;
    if (f < worst) worst = f;
  }
  return { mean: sum / 4, min: worst };
}

function quadGapNorm(a, b, W, H) {
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot((a[i].x - b[i].x) / W, (a[i].y - b[i].y) / H));
  return m;
}

function detect(imgData, hint, fast) {
  const W = imgData.width, H = imgData.height, area = W * H;
  const src = cv.matFromImageData(imgData);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  // also use saturation-aware channel: paper is bright & unsaturated
  const hsv = new cv.Mat();
  const rgb = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  const chans = new cv.MatVector();
  cv.split(hsv, chans);
  const sat = chans.get(1), val = chans.get(2);
  const paperness = new cv.Mat();
  // value - saturation highlights white paper against coloured/wooden backgrounds
  cv.subtract(val, sat, paperness);
  const blur = new cv.Mat();
  const k5 = new cv.Size(5, 5);
  const candidates = [];
  const edgeMap = cv.Mat.zeros(H, W, cv.CV_8UC1);
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const kernelBig = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
  const kernelText = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));
  const hand = handMask(src);
  const noHand = new cv.Mat();
  cv.bitwise_not(hand, noHand);

  const consider = (bin, tag, stripHand = false) => {
    const use = new cv.Mat();
    if (stripHand && hand._count > 30) {
      cv.bitwise_and(bin, noHand, use);
      cv.morphologyEx(use, use, cv.MORPH_CLOSE, kernelBig);
    } else bin.copyTo(use);
    const contours = new cv.MatVector(), hier = new cv.Mat();
    cv.findContours(use, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    use.delete();
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const a = cv.contourArea(cnt);
      if (a < area * 0.07) { cnt.delete(); continue; }
      const hull = new cv.Mat();
      cv.convexHull(cnt, hull, false, true);
      const peri = cv.arcLength(hull, true);
      let quad = null;
      for (const eps of [0.015, 0.02, 0.03, 0.045, 0.06, 0.08]) {
        const ap = new cv.Mat();
        cv.approxPolyDP(hull, ap, eps * peri, true);
        if (ap.rows === 4) quad = contourPts(ap);
        ap.delete();
        if (quad) break;
      }
      if (quad) {
        const q = orderCorners(quad);
        const qa = polyArea(q);
        const topE = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), botE = Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y);
        const leftE = Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y), rightE = Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y);
        const aspect = Math.max(topE + botE, leftE + rightE) / Math.min(topE + botE, leftE + rightE);
        // Long thermal slips are skinny but still a real page. A bright interior
        // stripe (aspect ~6, small area) is not, and stays rejected.
        // Squares are aspect ≈ 1 and are valid. Only absurdly thin strips are dropped,
        // except a tall receipt that still covers a real share of the frame.
        const longSlip = aspect >= 2.5 && aspect <= 6.2 && qa > area * 0.3;
        if (isConvex(q) && minAngleOk(q) && qa > area * 0.08 && qa < area * 0.985 && (aspect < 3.2 || longSlip)) {
          const fill = a / qa;
          if (fill > 0.78) candidates.push({ q, qa, fill, tag, pts: contourPts(cnt) });
        }
      }
      hull.delete(); cnt.delete();
    }
    contours.delete(); hier.delete();
  };

  // 1) Canny edges on gray
  cv.GaussianBlur(gray, blur, k5, 0);
  const edges = new cv.Mat();
  for (const [lo, hi] of [[40, 120], [15, 60], [30, 90]]) {
    cv.Canny(blur, edges, lo, hi);
    cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 2);
    cv.erode(edges, edges, kernel, new cv.Point(-1, -1), 1);
    cv.bitwise_or(edgeMap, edges, edgeMap);
    consider(edges, 'canny' + lo);
  }
  // Strong contrast boundaries, whatever color is inside. A green tin, a red label
  // and a photo print all show up here. Brightness is not consulted.
  const grad = new cv.Mat();
  cv.morphologyEx(blur, grad, cv.MORPH_GRADIENT, kernel);
  cv.threshold(grad, grad, 16, 255, cv.THRESH_BINARY);
  cv.dilate(grad, grad, kernel, new cv.Point(-1, -1), 1);
  cv.bitwise_or(edgeMap, grad, edgeMap);
  consider(grad, 'grad');
  grad.delete();
  // Cap specular highlights, then look for edges again. A clear cutting board and a
  // shiny packet stay one rectangle instead of breaking up around the glare.
  const dull = new cv.Mat();
  cv.threshold(blur, dull, 232, 232, cv.THRESH_TRUNC);
  cv.Canny(dull, edges, 18, 60);
  cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 2);
  cv.bitwise_or(edgeMap, edges, edgeMap);
  consider(edges, 'cannyGloss');
  dull.delete();
  // Paper masks are only a fallback for a white sheet on a white table. On the live
  // path a strong edge quad already wins, so these are skipped to stay at frame rate.
  const strongEdge = candidates.some((c) => (c.tag === 'grad' || String(c.tag).startsWith('canny')) && c.qa > area * 0.12);
  const pb = new cv.Mat();
  const th = new cv.Mat();
  if (!fast || !strongEdge) {
    cv.GaussianBlur(paperness, pb, new cv.Size(7, 7), 0);
    cv.threshold(pb, th, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(th, th, cv.MORPH_CLOSE, kernelBig);
    cv.morphologyEx(th, th, cv.MORPH_OPEN, kernelBig);
    consider(th, 'otsu', true);
  }
  // 3) Otsu on gray
  const th2 = new cv.Mat();
  cv.threshold(blur, th2, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  cv.morphologyEx(th2, th2, cv.MORPH_CLOSE, kernelBig);
  consider(th2, 'otsuGray', true);
  // Chalk on a blackboard is the inverse of a white page: edges show up after a flip.
  if (cv.mean(gray)[0] < 105) {
    const inv = new cv.Mat();
    const de = new cv.Mat();
    cv.bitwise_not(blur, inv);
    cv.Canny(inv, de, 25, 80);
    cv.dilate(de, de, kernel, new cv.Point(-1, -1), 2);
    cv.bitwise_or(edgeMap, de, edgeMap);
    consider(de, 'dark');
    inv.delete();
    de.delete();
  }
  // Bright-paper masks. A white sheet on a white table has almost no Canny edge, but it is
  // still a few levels brighter than the table. Several cutoffs, text holes closed.
  // They never outrank a boundary that actually has edges.
  const hi = new cv.Mat();
  if (!fast || !strongEdge) {
    for (const cut of [205, 225, 240, 248]) {
      cv.threshold(blur, hi, cut, 255, cv.THRESH_BINARY);
      cv.morphologyEx(hi, hi, cv.MORPH_CLOSE, kernelText);
      cv.morphologyEx(hi, hi, cv.MORPH_OPEN, kernel);
      consider(hi, 'bright' + cut, true);
    }
  }
  const havePage = candidates.some((c) => c.qa > area * 0.18);
  const wide = new cv.Mat();
  const illum = new cv.Mat();
  const nedges = new cv.Mat();
  if (!havePage) {
    cv.GaussianBlur(gray, wide, new cv.Size(0, 0), 21);
    cv.divide(gray, wide, illum, 180);
    cv.GaussianBlur(illum, blur, k5, 0);
    cv.Canny(blur, nedges, 20, 60);
    cv.dilate(nedges, nedges, kernel, new cv.Point(-1, -1), 2);
    cv.bitwise_or(edgeMap, nedges, edgeMap);
    consider(nedges, 'norm');
  }

  for (const c of candidates) {
    const sup = edgeMap.data && edgeMap.rows ? edgeSupport(c.q, edgeMap) : { mean: 0.5, min: 0.5 };
    const cx = c.q.reduce((s, p) => s + p.x, 0) / 4, cy = c.q.reduce((s, p) => s + p.y, 0) / 4;
    const centrality = 1 - Math.min(1, Math.hypot(cx - W / 2, cy - H / 2) / (0.5 * Math.hypot(W, H)));
    // Prominence: large, central, and sitting on real edges. A white blob with no
    // boundary loses to a smaller colored rectangle that has four strong sides.
    let score = c.qa * (0.28 + 0.72 * sup.mean) * (0.7 + 0.3 * centrality) * (0.55 + 0.45 * c.fill);
    // The photograph's own border is not an object. A real page still has margin.
    let onBorder = 0;
    for (const p of c.q) if (p.x < W * 0.025 || p.y < H * 0.025 || p.x > W * 0.975 || p.y > H * 0.975) onBorder++;
    if (onBorder >= 3) score *= 0.08;
    if (String(c.tag).startsWith('canny') || c.tag === 'grad') score *= 1.2;
    if ((String(c.tag).startsWith('bright') || String(c.tag).startsWith('otsu') || c.tag === 'norm') && sup.mean < 0.38) score *= 0.4;
    c.score = score;
    c.sup = sup.mean;
  }
  [src, gray, hsv, rgb, sat, val, paperness, blur, edges, pb, th, th2, kernel, kernelBig, kernelText, hand, noHand, hi, wide, illum, nedges, edgeMap].forEach((m) => m.delete());
  chans.delete();

  if (!candidates.length) return { found: false };
  candidates.sort((a, b) => b.score - a.score);
  let best = candidates[0];
  // Stick to the quad we are already tracking when it is still a strong candidate,
  // so two similar outlines do not flicker. A clearly better shape elsewhere wins
  // on this same frame (a pan switches in one step, with no lag).
  if (hint && hint.length === 4) {
    const hq = hint.map((p) => ({ x: p.x * W, y: p.y * H }));
    const near = candidates.filter((c) => c.score > best.score * 0.72 && quadGapNorm(c.q, hq, W, H) < 0.07);
    if (near.length) {
      near.sort((a, b) => quadGapNorm(a.q, hq, W, H) - quadGapNorm(b.q, hq, W, H));
      best = near[0];
    }
  }
  const mids = edgeMids(best.q, best.pts);
  // pull corners slightly inward so background never bleeds into the scan edge
  const cx = best.q.reduce((s, p) => s + p.x, 0) / 4, cy = best.q.reduce((s, p) => s + p.y, 0) / 4;
  const inset = (p, k) => ({ x: p.x + (cx - p.x) * k, y: p.y + (cy - p.y) * k });
  const q = best.q.map((p) => inset(p, 0.008));
  for (let i = 0; i < 4; i++) { const m = inset(mids[i], 0.008); mids[i].x = m.x; mids[i].y = m.y; }
  const top = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), bottom = Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y);
  const left = Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y), right = Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y);
  const ratio = Math.max(top + bottom, left + right) / Math.min(top + bottom, left + right);
  const norm = (p) => ({ x: p.x / W, y: p.y / H });
  return {
    found: true,
    corners: q.map(norm),
    mids: mids.map((m) => ({ x: m.x / W, y: m.y / H })),
    curved: mids.some((m) => m.curved),
    areaRatio: polyArea(q) / area,
    ratio,
    method: best.tag,
  };
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'warmup') { await loadCV(); self.postMessage({ id, ok: true, result: true }); return; }
    if (type === 'detect') {
      await loadCV();
      const t0 = performance.now();
      const r = detect(e.data.image, e.data.hint || null, !!e.data.fast);
      r.ms = Math.round(performance.now() - t0);
      self.postMessage({ id, ok: true, result: r });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
