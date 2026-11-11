// Copies heavy on-device engines (OpenCV, Tesseract, language data) into public/vendor
import { cpSync, mkdirSync, existsSync } from 'node:fs';
const nm = (p) => new URL('../node_modules/' + p, import.meta.url).pathname;
const out = (p) => new URL('../public/vendor/' + p, import.meta.url).pathname;
mkdirSync(out('opencv'), { recursive: true });
mkdirSync(out('tesseract/core'), { recursive: true });
mkdirSync(out('tesseract/lang'), { recursive: true });
const copies = [
  ['@techstark/opencv-js/dist/opencv.js', 'opencv/opencv.js'],
  ['tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js'],
  ['@tesseract.js-data/tha/4.0.0_best_int/tha.traineddata.gz', 'tesseract/lang/tha.traineddata.gz'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'tesseract/lang/eng.traineddata.gz'],
];
for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) {
  if (existsSync(nm('tesseract.js-core/' + f))) copies.push(['tesseract.js-core/' + f, 'tesseract/core/' + f]);
}
for (const [a, b] of copies) { cpSync(nm(a), out(b)); console.log('vendor:', b); }

// Learned models and ONNX Runtime are fetched on first scan, not at startup.
// Weights are stored float16 (fp32 compute via Cast) so Pages stays under the large-file limit.
mkdirSync(out('models'), { recursive: true });
mkdirSync(out('ort'), { recursive: true });
const root = (p) => new URL('../' + p, import.meta.url).pathname;
for (const f of ['docaligner-lcnet100.onnx', 'UVDoc_grid.onnx']) {
  cpSync(root('models/' + f), out('models/' + f));
  console.log('vendor: models/' + f);
}
const ortFiles = [
  'ort.wasm.min.mjs',
  'ort.webgpu.min.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
];
for (const f of ortFiles) {
  const src = nm('onnxruntime-web/dist/' + f);
  if (!existsSync(src)) continue;
  cpSync(src, out('ort/' + f));
  console.log('vendor: ort/' + f);
}
