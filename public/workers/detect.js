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
    if (Math.abs(off) < L * 0.022) off = 0;
    mids.push({ x: (A.x + B.x) / 2 + nx * off, y: (A.y + B.y) / 2 + ny * off, curved: off !== 0 });
  }
  return mids;
}

function detect(imgData) {
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
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const kernelBig = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));

  const consider = (bin, tag) => {
    const contours = new cv.MatVector(), hier = new cv.Mat();
    cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const a = cv.contourArea(cnt);
      if (a < area * 0.12) { cnt.delete(); continue; }
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
        if (isConvex(q) && minAngleOk(q) && qa < area * 0.985) {
          // fill ratio: how well the contour fills the quad (rejects random shapes)
          const fill = a / qa;
          if (fill > 0.82) candidates.push({ q, score: qa * (0.6 + 0.4 * fill), tag, pts: contourPts(cnt) });
        }
      }
      hull.delete(); cnt.delete();
    }
    contours.delete(); hier.delete();
  };

  // 1) Canny edges on gray
  cv.GaussianBlur(gray, blur, k5, 0);
  const edges = new cv.Mat();
  for (const [lo, hi] of [[40, 120], [15, 60]]) {
    cv.Canny(blur, edges, lo, hi);
    cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 2);
    cv.erode(edges, edges, kernel, new cv.Point(-1, -1), 1);
    consider(edges, 'canny' + lo);
  }
  // 2) Otsu on paperness
  const pb = new cv.Mat();
  cv.GaussianBlur(paperness, pb, new cv.Size(7, 7), 0);
  const th = new cv.Mat();
  cv.threshold(pb, th, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  cv.morphologyEx(th, th, cv.MORPH_CLOSE, kernelBig);
  cv.morphologyEx(th, th, cv.MORPH_OPEN, kernelBig);
  consider(th, 'otsu');
  // 3) Otsu on gray
  const th2 = new cv.Mat();
  cv.threshold(blur, th2, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  cv.morphologyEx(th2, th2, cv.MORPH_CLOSE, kernelBig);
  consider(th2, 'otsuGray');

  [src, gray, hsv, rgb, sat, val, paperness, blur, edges, pb, th, th2, kernel, kernelBig].forEach((m) => m.delete());
  chans.delete();

  if (!candidates.length) return { found: false };
  // prefer largest; when two methods agree, boost
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
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
      const r = detect(e.data.image);
      r.ms = Math.round(performance.now() - t0);
      self.postMessage({ id, ok: true, result: r });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
