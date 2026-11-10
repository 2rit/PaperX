// Bench the text-line flattener on synthetic pages: node tests/flatten-bench.mjs
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('/tmp/fb', { recursive: true });
await build({ entryPoints: ['src/lib/flatten.ts'], bundle: true, format: 'esm', outfile: '/tmp/fb/flatten.mjs', platform: 'node' });
const F = await import('/tmp/fb/flatten.mjs?' + Date.now());
const py = (code) => execFileSync('python3', ['-c', code], { encoding: 'utf8' });
const toRaw = (src, dst) => py(`from PIL import Image;im=Image.open('${src}').convert('RGBA');open('${dst}','wb').write(im.tobytes());print(im.size[0],im.size[1])`).trim().split(' ').map(Number);
const fromRaw = (src, w, h, dst) => py(`from PIL import Image;Image.frombytes('RGBA',(${w},${h}),open('${src}','rb').read()).convert('RGB').save('${dst}')`);
const METRIC0 = `
import sys,numpy as np
from PIL import Image
g=np.asarray(Image.open(sys.argv[1]).convert('L')).astype(float); h,w=g.shape
ink=(g<150).astype(float); n=12
P=[np.convolve(ink[:,int(i*w/n):int((i+1)*w/n)].mean(1),np.ones(3)/3,'same') for i in range(n)]
c=P[n//2]; res=[]
for i in range(n):
  for yc in range(int(h*.1),int(h*.9),int(h/12)):
    a=c[yc-60:yc+60]
    if a.std()<1e-3: continue
    best=max(range(-60,61),key=lambda s: np.dot(a-a.mean(),P[i][yc-60+s:yc+60+s]-P[i][yc-60+s:yc+60+s].mean()) if 0<=yc-60+s and yc+60+s<=h else -1e9)
    res.append(abs(best))
print('%.2f'%np.mean(res), '%.0f'%np.max(res))
`;
const METRIC = `
import sys,numpy as np
from PIL import Image
a=np.asarray(Image.open(sys.argv[1]).convert('L')).astype(float); t=np.asarray(Image.open(sys.argv[2]).convert('L')).astype(float)
h=min(a.shape[0],t.shape[0]); w=min(a.shape[1],t.shape[1]); a=a[:h,:w]; t=t[:h,:w]
ia=(a<150).astype(float); it=(t<150).astype(float); n=10; R=36; D=[]
np.seterr(all='ignore')
for yc in range(int(h*.12),int(h*.88),int(h/14)):
  row=[]
  for i in range(n):
    x0,x1=int(i*w/n),int((i+1)*w/n); pa=ia[:,x0:x1].mean(1); pt=it[:,x0:x1].mean(1)
    b=pt[yc-80:yc+80]
    if b.std()<0.02: continue
    sc=[np.nan_to_num(np.corrcoef(b,pa[yc-80+s:yc+80+s])[0,1],nan=-1) if 0<=yc-80+s and yc+80+s<=h else -1 for s in range(-R,R+1)]
    row.append(int(np.argmax(sc))-R)
  if len(row)>2: r=np.array(row); D+=list(np.abs(r-np.median(r)))
D=np.array(D); print('%.2f/%d'%(D.mean(),D.max()))
`;
writeFileSync('/tmp/fb/metric.py', METRIC);
const metric = (f, truth) => execFileSync('python3', ['/tmp/fb/metric.py', f, truth], { encoding: 'utf8' }).trim();
const truthOf = (n, side) => n === 'book' ? `test-assets/book_truth_${side}.png` : 'test-assets/wrinkled_page_truth.png';
for (const [name, file, book] of [['wrinkled', 'test-assets/wrinkled_page.png', false], ['truth(flat)', 'test-assets/wrinkled_page_truth.png', false], ['book', 'test-assets/book_spread.jpg', true]]) {
  const [w, h] = toRaw(file, '/tmp/fb/in.raw');
  let img = { data: new Uint8ClampedArray(readFileSync('/tmp/fb/in.raw')), width: w, height: h };
  const pages = [];
  if (book) {
    // crop to page box like the warp would
    const box = JSON.parse(readFileSync('test-assets/book_spread.json', 'utf8')).page_box;
    const cw = box[2] - box[0], ch = box[3] - box[1], d = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) d.set(img.data.subarray(((y + box[1]) * w + box[0]) * 4, ((y + box[1]) * w + box[2]) * 4), y * cw * 4);
    img = { data: d, width: cw, height: ch };
    const at = F.findSpine(img);
    console.log('book spine at', at.toFixed(3), '(truth 0.500)');
    pages.push(['L', F.cropHalf(img, 'L', at)], ['R', F.cropHalf(img, 'R', at)]);
  } else pages.push(['', img]);
  for (const [side, im] of pages) {
    writeFileSync('/tmp/fb/a.raw', im.data); fromRaw('/tmp/fb/a.raw', im.width, im.height, `/tmp/fb/${name}${side}-before.png`);
    const t0 = performance.now();
    const flow = F.estimateFlow(im);
    const t1 = performance.now();
    const out = flow ? F.applyFlow(im, flow) : im;
    const t2 = performance.now();
    writeFileSync('/tmp/fb/b.raw', out.data); fromRaw('/tmp/fb/b.raw', out.width, out.height, `/tmp/fb/${name}${side}-after.png`);
    console.log(`${name}${side}: line misalignment vs truth (mean/max px) before ${metric(`/tmp/fb/${name}${side}-before.png`, truthOf(name, side))} -> after ${metric(`/tmp/fb/${name}${side}-after.png`, truthOf(name, side))}  flow=${flow ? flow.strength.toFixed(4) : 'none'} est ${Math.round(t1 - t0)}ms apply ${Math.round(t2 - t1)}ms`);
  }
}
