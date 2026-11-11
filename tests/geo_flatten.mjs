// Apply the geometric flattener to a folder of RGBA raw files named stem_WxH.raw
import { build } from 'esbuild';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const [src, dst] = process.argv.slice(2);
mkdirSync('/tmp/fb', { recursive: true });
mkdirSync(dst, { recursive: true });
await build({ entryPoints: ['src/lib/flatten.ts'], bundle: true, format: 'esm', outfile: '/tmp/fb/flatten.mjs', platform: 'node' });
const F = await import('/tmp/fb/flatten.mjs?' + Date.now());
for (const name of readdirSync(src)) {
  if (!name.endsWith('.raw')) continue;
  const m = name.match(/^(.*)_(\d+)x(\d+)\.raw$/);
  if (!m) continue;
  const [, stem, ws, hs] = m;
  const w = Number(ws), h = Number(hs);
  const img = { data: new Uint8ClampedArray(readFileSync(`${src}/${name}`)), width: w, height: h };
  const flow = F.estimateFlow(img);
  const out = flow ? F.applyFlow(img, flow) : img;
  const raw = `/tmp/fb/one.raw`;
  writeFileSync(raw, out.data);
  execFileSync('python3', ['-c', `from PIL import Image; Image.frombytes('RGBA',(${out.width},${out.height}),open('${raw}','rb').read()).convert('RGB').save('${dst}/${stem}.png')`]);
}
