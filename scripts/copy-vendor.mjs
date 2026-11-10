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
