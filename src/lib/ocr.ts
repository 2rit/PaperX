// On-device OCR (Thai + English) via tesseract.js, all assets served locally.
import type { Worker as TWorker } from 'tesseract.js';

let worker: TWorker | null = null;
let workerLang = '';
let progressCb: ((p: number, status: string) => void) | null = null;

const abs = (p: string) => new URL(`${import.meta.env.BASE_URL}${p}`, window.location.origin).href;

const STATUS_TH: Record<string, string> = {
  'loading tesseract core': 'กำลังโหลดระบบ OCR',
  'initializing tesseract': 'กำลังเตรียมระบบ OCR',
  'loading language traineddata': 'กำลังโหลดภาษาไทย-อังกฤษ',
  'initializing api': 'กำลังเริ่มต้น',
  'recognizing text': 'กำลังอ่านข้อความ',
};

async function getWorker(lang: string) {
  if (worker && workerLang === lang) return worker;
  if (worker) await worker.terminate();
  const { createWorker } = await import('tesseract.js');
  worker = await createWorker(lang.split('+'), 1, {
    workerPath: abs('vendor/tesseract/worker.min.js'),
    corePath: abs('vendor/tesseract/core/'),
    langPath: abs('vendor/tesseract/lang'),
    gzip: true,
    workerBlobURL: false,
    logger: (m: any) => progressCb?.(m.progress ?? 0, STATUS_TH[m.status] || m.status),
  });
  // fully automatic page segmentation: finds headings, columns and body text
  await worker.setParameters({ tessedit_pageseg_mode: '3' as any, preserve_interword_spaces: '1' });
  workerLang = lang;
  return worker;
}

/** Remove the spurious spaces tesseract inserts between Thai glyphs. */
export function cleanThai(text: string) {
  return text
    .replace(/([\u0E00-\u0E7F]) +(?=[\u0E00-\u0E7F])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export async function recognize(image: Blob, lang: string, onProgress?: (p: number, status: string) => void) {
  progressCb = onProgress || null;
  const w = await getWorker(lang);
  const { data } = await w.recognize(image);
  progressCb = null;
  return { text: cleanThai(data.text || ''), confidence: data.confidence };
}
