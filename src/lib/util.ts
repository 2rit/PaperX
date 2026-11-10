export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

export function thaiDate(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const hm = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false });
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff === 0) return `วันนี้ ${hm}`;
  if (diff === 1) return `เมื่อวานนี้ ${hm}`;
  return `${d.getDate()} ${TH_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;
}

export function defaultDocName(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `สแกน_${d.getFullYear() + 543}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

export function safeFileName(name: string) {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'PAPERX';
}

export function formatBytes(b: number) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export const isIOS = () =>
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1);

export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true;

export const isTouch = () => matchMedia('(pointer: coarse)').matches;
