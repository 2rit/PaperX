// Detection IoU and dewarp straightness on the hard fixtures. Writes comparison PNGs.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import cvPromise from '@techstark/opencv-js';

const cv = await cvPromise;
globalThis.cv = cv;
globalThis.self = globalThis;
globalThis.importScripts = () => {};
eval(readFileSync('public/workers/detect.js', 'utf8'));
cv.matFromImageData = (img) => cv.matFromArray(img.height, img.width, cv.CV_8UC4, img.data);

function py(code) {
  return execFileSync('python3', ['-c', code], { encoding: 'utf8' });
}
function loadScaled(path, max = 900) {
  const [w, h] = py(`
from PIL import Image
im=Image.open(${JSON.stringify(path)}).convert('RGBA')
w,h=im.size
s=min(1, ${max}/max(w,h))
im=im.resize((max(1,round(w*s)), max(1,round(h*s))), Image.Resampling.LANCZOS)
open('/tmp/px.raw','wb').write(im.tobytes())
print(im.size[0], im.size[1])
`).trim().split(' ').map(Number);
  return { width: w, height: h, data: new Uint8ClampedArray(readFileSync('/tmp/px.raw')) };
}
async function detect(path) {
  const image = loadScaled(path, 900);
  const res = await new Promise((resolve) => {
    self.postMessage = (m) => resolve(m);
    self.onmessage({ data: { id: 1, type: 'detect', image } });
  });
  return res.result;
}
function iou(a, b, n = 180) {
  const pip = (q, x, y) => {
    let c = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const yi = q[i].y, yj = q[j].y, xi = q[i].x, xj = q[j].x;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) c = !c;
    }
    return c;
  };
  let inter = 0, union = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const px = (x + 0.5) / n, py = (y + 0.5) / n;
    const A = pip(a, px, py), B = pip(b, px, py);
    if (A && B) inter++;
    if (A || B) union++;
  }
  return union ? inter / union : 0;
}

const cases = ['skewed_shadow', 'rotated', 'curved', 'quality_white', 'quality_hand', 'quality_shadow'];
console.log('detection');
for (const name of cases) {
  const r = await detect('test-assets/' + name + '.jpg');
  const truth = JSON.parse(readFileSync('test-assets/' + name + '.json', 'utf8')).corners;
  if (!r.found) { console.log(name, 'MISS'); continue; }
  const err = Math.max(...r.corners.map((q, i) => Math.hypot(q.x - truth[i].x, q.y - truth[i].y)));
  console.log(`${name}  corner ${(err * 100).toFixed(2)}%  IoU ${iou(r.corners, truth).toFixed(3)}  curved=${!!r.curved}  ${r.method}  ${r.ms}ms`);
  writeFileSync('/tmp/quad.json', JSON.stringify(r.corners));
  py(`
import json
from PIL import Image, ImageDraw
im=Image.open('test-assets/${name}.jpg').convert('RGB')
w,h=im.size
q=json.load(open('/tmp/quad.json'))
d=ImageDraw.Draw(im)
pts=[(p['x']*w, p['y']*h) for p in q]
d.line(pts+[pts[0]], fill=(40,200,40), width=6)
im.resize((900, int(900*h/w))).save('/tmp/det-${name}.jpg', quality=90)
`);
}

await build({ entryPoints: ['src/lib/flatten.ts'], bundle: true, format: 'esm', outfile: '/tmp/fb/flatten.mjs', platform: 'node' });
const F = await import('/tmp/fb/flatten.mjs?' + Date.now());
function loadRaw(path) {
  const [w, h] = py(`
from PIL import Image
im=Image.open(${JSON.stringify(path)}).convert('RGBA')
open('/tmp/px.raw','wb').write(im.tobytes()); print(im.size[0], im.size[1])
`).trim().split(' ').map(Number);
  return { data: new Uint8ClampedArray(readFileSync('/tmp/px.raw')), width: w, height: h };
}
function saveRaw(img, path) {
  writeFileSync('/tmp/out.raw', img.data);
  py(`
from PIL import Image
Image.frombytes('RGBA', (${img.width}, ${img.height}), open('/tmp/out.raw','rb').read()).convert('RGB').save(${JSON.stringify(path)})
`);
}
const metric = (a, b) => py(`
import sys,numpy as np
from PIL import Image
A=np.asarray(Image.open(${JSON.stringify(a)}).convert('L')).astype(float)
T=np.asarray(Image.open(${JSON.stringify(b)}).convert('L')).astype(float)
h=min(A.shape[0],T.shape[0]); w=min(A.shape[1],T.shape[1]); A=A[:h,:w]; T=T[:h,:w]
ia=(A<150).astype(float); it=(T<150).astype(float); n=10; R=48; D=[]
for yc in range(int(h*.12), int(h*.88), int(h/14)):
  row=[]
  for i in range(n):
    x0,x1=int(i*w/n),int((i+1)*w/n); pa=ia[:,x0:x1].mean(1); pt=it[:,x0:x1].mean(1)
    bb=pt[yc-80:yc+80]
    if bb.std()<0.02: continue
    sc=[np.corrcoef(bb, pa[yc-80+s:yc+80+s])[0,1] if 0<=yc-80+s and yc+80+s<=h else -1 for s in range(-R,R+1)]
    row.append(int(np.nanargmax(sc))-R)
  if len(row)>2:
    r=np.array(row); D+=list(np.abs(r-np.median(r)))
D=np.array(D); print('%.2f %.0f'%(D.mean(), D.max()))
`).trim();

console.log('dewarp');
for (const [name, src, truth] of [
  ['wrinkled', 'test-assets/wrinkled_page.png', 'test-assets/wrinkled_page_truth.png'],
  ['curl', 'test-assets/quality_curl.png', 'test-assets/quality_curl_truth.png'],
]) {
  const im = loadRaw(src);
  const flow = F.estimateFlow(im);
  const out = flow ? F.applyFlow(im, flow) : im;
  saveRaw(im, `/tmp/before-${name}.png`);
  saveRaw(out, `/tmp/after-${name}.png`);
  console.log(name, 'before', metric(`/tmp/before-${name}.png`, truth), 'after', metric(`/tmp/after-${name}.png`, truth), 'strength', flow ? flow.strength.toFixed(4) : 'none');
  py(`
from PIL import Image
b=Image.open('/tmp/before-${name}.png'); a=Image.open('/tmp/after-${name}.png'); t=Image.open(${JSON.stringify(truth)}).convert('RGB')
H=420
def sc(im):
  return im.resize((max(1,round(im.width*H/im.height)), H))
b,a,t=sc(b),sc(a),sc(t)
c=Image.new('RGB', (b.width+a.width+t.width+8, H), (20,20,20))
c.paste(b,(0,0)); c.paste(a,(b.width+4,0)); c.paste(t,(b.width+a.width+8,0))
c.save('/tmp/compare-${name}.jpg', quality=90)
`);
}
