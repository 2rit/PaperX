// Builds test-results/CHECKLIST.md: every mockup / brief feature → the automated checks that prove it, per engine.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const load = (e) => (existsSync(`test-results/${e}/results.json`) ? JSON.parse(readFileSync(`test-results/${e}/results.json`, 'utf8')) : []);
const R = { chromium: load('chromium'), webkit: load('webkit') };
const F = [
  ['Mockup · Sidebar (Home / Library / OCR / Settings), lime accent', /Sidebar navigation/],
  ['Mockup · Home hero: สแกนเอกสาร', /สแกนเอกสาร” opens the camera/],
  ['Mockup · Home hero: นำเข้าจากแกลเลอรี', /นำเข้าจากแกลเลอรี” imports/],
  ['Mockup · Recent documents + ดูทั้งหมด', /Recent documents grid|ดูทั้งหมด/],
  ['Mockup · Advanced processing toggles (5)', /Advanced toggle/],
  ['Mockup · Camera: live rear camera (playsinline)', /Live camera stream/],
  ['Mockup · Camera: auto document detection, green frame, “ตรวจพบเอกสาร A4” pill', /green quad/],
  ['Mockup · Camera: hint text', /Hint pill/],
  ['Mockup · Camera: shutter / gallery / close', /Shutter button|Gallery button in camera|Close with captured/],
  ['Mockup · Camera: flash (shown only when torch supported)', /Flash button/],
  ['Mockup · Camera: fallback when no camera (native camera / gallery / retry)', /No-camera fallback/],
  ['UX · Auto-capture when steady + toggle', /Auto-capture/],
  ['UX · Batch tray: add / remove / เสร็จสิ้น → multi-page doc', /Tray ✕|เสร็จสิ้น/],
  ['Mockup · Editor: undo / redo (+ Ctrl+Z)', /Undo reverts|Ctrl\+Z/],
  ['Mockup · Editor: zoom', /Zoom in/],
  ['Mockup · Editor: บันทึก (full-res render → IndexedDB)', /บันทึก renders/],
  ['Mockup · Editor: 7 document modes', /โหมด “/],
  ['Mockup · Editor: 3 sliders (ความสว่าง / ความคมชัด / ความอิ่มตัว)', /Slider sl-/],
  ['Mockup · Tool ครอบตัด (4-corner crop + perspective)', /ครอบตัด: drag a corner/],
  ['Mockup · Tool ครอบตัด: curved edge handles, auto-detect, full, straight, cancel', /mid-edge handle/],
  ['Mockup · Tool หมุน', /หมุน rotates/],
  ['Mockup · Tool ปรับมุม (slider, ±0.5°, auto-straighten, reset)', /ปรับมุม:/],
  ['Mockup · Tool ฟิลเตอร์ (live thumbnails)', /ฟิลเตอร์ sheet/],
  ['Mockup · Tool ปรับแต่ง (shadow / text enhancement / reset)', /ปรับแต่ง sheet: Shadow/],
  ['Mockup · Tool เปรียบเทียบ (before/after divider)', /เปรียบเทียบ shows/],
  ['HERO · Auto Flatten on by default, chip / sheet / panel toggles re-render', /Auto Flatten is ON|Auto Flatten chip|“Auto Flatten” toggles/],
  ['HERO · Auto Flatten accuracy on wrinkled page (≥50% less line misalignment)', /Auto Flatten accuracy/],
  ['HERO · Auto Flatten visible in before/after compare', /“ก่อน” side is the un-flattened/],
  ['HERO · Book mode: Home spotlight → camera in book mode; mode switch', /spotlight/],
  ['HERO · Book mode in camera: spine guide, spread → 2 pages (L+R)', /โหมดหนังสือ: spine guide|incl\. book|เสร็จสิ้น/],
  ['HERO · Book mode in editor: split at detected spine, spine slider, auto spine', /แยกเป็น 2 หน้า|spine slider/],
  ['HERO · Book mode: persist L/R pages, merge back, undo', /persists L\/R/],
  ['UX · Page tray: add / select / drag reorder / delete + undo toast', /Page tray/],
  ['UX · Inline rename (editor + library card)', /rename/i],
  ['UX · Menu ⋯: duplicate / shortcuts / share (when supported) / delete + undo / navigate', /Menu ⋯|Panel buttons/],
  ['UX · Autosave on back', /auto-saves/],
  ['UX · Drag & drop import; keyboard shortcuts', /Drag & drop|Keyboard shortcuts/],
  ['UX · Onboarding + Thai empty state', /Onboarding|Empty state/],
  ['Mockup · Library: search (incl. OCR text)', /Search filters|searchable in the library/],
  ['Mockup · Library: sort', /Sort/],
  ['Mockup · Library: select, ลบ (+undo), คัดลอก, เปิด, ส่งออก, รวม, import', /Select checkmark|คัดลอก duplicates|ลบ removes|Delete removes|ส่งออก and เปิด|รวม merges|นำเข้า” imports/],
  ['Mockup · Export: PDF / JPG / PNG, A4 / ขนาดต้นฉบับ, สูง / มาตรฐาน', /Option buttons|ดาวน์โหลด/],
  ['Mockup · Export: real multi-page PDF', /page PDF/],
  ['Mockup · Export: open after download', /เปิดด้วยแอปพลิเคชัน/],
  ['Mockup · Export: share (only when Web Share supported); back', /ปุ่มแชร์|Back button returns/],
  ['Mockup · OCR: Thai+English on-device, success state', /Thai\+English text extracted|OCR picker/],
  ['Mockup · OCR: คัดลอก / .txt / per page / language / re-read', /คัดลอก copies|\.txt|Page ‹ ›|Language/],
  ['Mockup · Settings: defaults, toggles, reset, storage, install, shortcuts', /Default mode|Toggles & selects|คืนค่า|Persistent-storage|ดูคีย์ลัด|Install section/],
  ['Processing · Four-corner detection vs ground truth', /Four-corner detection/],
  ['Processing · Shadow removal', /Shadow removal flattens/],
  ['PWA · manifest + apple-touch-icon, service worker, offline', /manifest|Service worker|offline/],
  ['Mobile · bottom tabs + center scan, ≥44px touch targets, bottom sheets', /Bottom tab bar|Touch targets|Editor on phone/],
  ['Quality · no console errors / failed requests', /No console errors/],
];
const cell = (rs, re) => {
  const m = rs.filter((r) => re.test(r.name));
  if (!m.length) return '— (n/a)';
  const ok = m.filter((r) => r.ok).length;
  return ok === m.length ? `✅ ${ok}/${m.length}` : `❌ ${ok}/${m.length}`;
};
const used = new Set();
let md = `# PAPERX — feature checklist (generated ${new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })} เวลาไทย)\n\n`;
const tot = (rs) => `${rs.filter((r) => r.ok).length}/${rs.length}`;
md += `Automated Playwright run (tests/e2e.mjs) — Chromium: **${tot(R.chromium)}**, WebKit (Safari engine): **${tot(R.webkit)}**.\n`;
md += `WebKit on this Linux box has no camera stack (getUserMedia crashes the engine), so live-camera checks run on Chromium only; WebKit runs the no-camera fallback path.\n\n`;
md += `| Feature | Chromium | WebKit |\n|---|---|---|\n`;
for (const [f, re] of F) {
  md += `| ${f} | ${cell(R.chromium, re)} | ${cell(R.webkit, re)} |\n`;
  [...R.chromium, ...R.webkit].forEach((r) => re.test(r.name) && used.add(r.name));
}
md += `\n## Every individual check\n\n| Section | Check | Chromium | WebKit |\n|---|---|---|---|\n`;
const names = [...new Map([...R.chromium, ...R.webkit].map((r) => [r.section + '|' + r.name, r])).values()];
for (const r of names) {
  const c = R.chromium.find((x) => x.name === r.name && x.section === r.section), w = R.webkit.find((x) => x.name === r.name && x.section === r.section);
  const f = (x) => (!x ? '—' : (x.ok ? '✅' : '❌') + (x.detail ? ' ' + String(x.detail).replace(/\|/g, '/').slice(0, 90) : ''));
  md += `| ${r.section} | ${r.name} | ${f(c)} | ${f(w)} |\n`;
}
const unmapped = names.filter((r) => !used.has(r.name)).map((r) => r.name);
if (unmapped.length) md += `\nChecks not mapped to a feature row: ${unmapped.join('; ')}\n`;
writeFileSync('test-results/CHECKLIST.md', md);
console.log('features', F.length, 'chromium', tot(R.chromium), 'webkit', tot(R.webkit), 'unmapped', unmapped.length);
