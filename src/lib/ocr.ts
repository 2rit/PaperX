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

/** Drop dotted leader lines (……) while keeping the words written on them. */
export function stripLeaders(text: string) {
  return text
    .replace(/[.\u2026\u00B7\u2022\u2027\u2219]{2,}/g, ' ')
    .replace(/(?:\s*[.\u00B7\u2022]\s*){3,}/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export async function recognize(image: Blob, lang: string, onProgress?: (p: number, status: string) => void) {
  progressCb = onProgress || null;
  const w = await getWorker(lang);
  const { data } = await w.recognize(image);
  let text = stripLeaders(cleanThai(data.text || ''));
  const stamps = await stampText(image, w);
  if (stamps) text = `${text}\n\n[ตราประทับ]\n${stamps}`.trim();
  progressCb = null;
  return { text, confidence: data.confidence };
}

/** OCR only the red/blue pixels, so a seal is labeled instead of mixed into the body. */
async function stampText(image: Blob, w: TWorker) {
  const bmp = await createImageBitmap(image);
  const c = document.createElement('canvas');
  const k = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  let hits = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const stamp = (r > 150 && r > g + 45 && r > b + 35) || (b > 110 && b > r + 30 && b > g + 15);
    if (!stamp) { d[i] = d[i + 1] = d[i + 2] = 255; }
    else { hits++; d[i] = d[i + 1] = d[i + 2] = 20; }
  }
  if (hits < d.length / 4 * 0.004) return '';
  ctx.putImageData(id, 0, 0);
  const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/png'));
  const { data } = await w.recognize(blob);
  const t = stripLeaders(cleanThai(data.text || ''));
  return t.replace(/\s+/g, ' ').trim();
}
