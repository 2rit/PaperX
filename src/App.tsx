import { lazy, Suspense, useEffect, useState } from 'react';
import { Camera, FileText, House, Keyboard, Library, ScanText, Settings as SettingsIcon, Upload, X } from 'lucide-react';
import { navigate, useRoute, type Route } from './lib/router';
import { useToasts, dismiss } from './lib/toast';
import { useBusy } from './lib/busy';
import { importToNewDoc, pickFiles } from './lib/actions';
import { cx, Logo, Sheet, Spinner, Wordmark } from './components/ui';
import Home from './screens/Home';
import LibraryScreen from './screens/Library';

const CameraScreen = lazy(() => import('./screens/Camera'));
const Editor = lazy(() => import('./screens/Editor'));
const ExportScreen = lazy(() => import('./screens/Export'));
const OcrScreen = lazy(() => import('./screens/Ocr'));
const SettingsScreen = lazy(() => import('./screens/Settings'));

const NAV = [
  { name: 'home', label: 'Home', th: 'หน้าแรก', icon: House, path: 'home' },
  { name: 'library', label: 'Library', th: 'คลังเอกสาร', icon: Library, path: 'library' },
  { name: 'ocr', label: 'OCR', th: 'OCR', icon: ScanText, path: 'ocr' },
  { name: 'settings', label: 'Settings', th: 'ตั้งค่า', icon: SettingsIcon, path: 'settings' },
] as const;

function activeTab(r: Route) {
  if (r.name === 'export') return 'library';
  return r.name;
}

function Sidebar({ route }: { route: Route }) {
  const tab = activeTab(route);
  return (
    <aside className="hidden md:flex flex-col shrink-0 w-[180px] lg:w-[210px] bg-ink-900 text-white pt-safe pl-safe" data-testid="sidebar">
      <button className="flex flex-col items-center gap-1.5 py-7" onClick={() => navigate('home')} aria-label="PAPERX หน้าแรก">
        <Logo size={46} />
        <Wordmark className="text-xl text-white" />
      </button>
      <nav className="flex flex-col gap-1 px-0">
        {NAV.map((n) => (
          <button
            key={n.name}
            data-testid={'nav-' + n.name}
            onClick={() => navigate(n.path)}
            className={cx(
              'pressable flex items-center gap-3 h-12 px-5 mr-3 rounded-r-xl text-[15px] transition-colors',
              tab === n.name ? 'bg-lime text-ink-900 font-semibold' : 'text-white/80 hover:bg-white/5 hover:text-white',
            )}
          >
            <n.icon size={20} /> {n.label}
          </button>
        ))}
      </nav>
      <div className="mt-auto p-4 text-[11px] text-white/40 leading-relaxed">
        ประมวลผลในเครื่อง<br />ปลอดภัยเป็นส่วนตัว
      </div>
    </aside>
  );
}

function BottomNav({ route }: { route: Route }) {
  const tab = activeTab(route);
  const item = (n: (typeof NAV)[number]) => (
    <button key={n.name} data-testid={'bnav-' + n.name} onClick={() => navigate(n.path)}
      className={cx('pressable flex-1 flex flex-col items-center justify-center gap-0.5 h-14 text-[11px]', tab === n.name ? 'text-lime' : 'text-white/60')}>
      <n.icon size={22} />{n.th}
    </button>
  );
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-ink-900/95 backdrop-blur pb-safe-0 pl-safe pr-safe" data-testid="bottomnav">
      <div className="flex items-center">
        {item(NAV[0])}{item(NAV[1])}
        <div className="flex-1 flex justify-center">
          <button data-testid="bnav-scan" aria-label="สแกนเอกสาร" onClick={() => navigate('camera')}
            className="pressable -mt-6 h-16 w-16 rounded-full bg-lime text-ink-900 shadow-lime ring-4 ring-paper flex items-center justify-center">
            <Camera size={28} />
          </button>
        </div>
        {item(NAV[2])}{item(NAV[3])}
      </div>
    </nav>
  );
}

function Toasts() {
  const ts = useToasts();
  return (
    <div className="fixed z-[70] inset-x-0 bottom-24 md:bottom-6 flex flex-col items-center gap-2 pointer-events-none px-4" aria-live="polite">
      {ts.map((t) => (
        <div key={t.id} data-testid="toast" className={cx('pointer-events-auto animate-fadeUp flex items-center gap-3 rounded-2xl pl-4 pr-2 py-2 shadow-2xl text-sm max-w-md w-full sm:w-auto',
          t.kind === 'error' ? 'bg-red-600 text-white' : 'bg-ink-800 text-white')}>
          {t.kind === 'success' && <span className="h-5 w-5 rounded-full bg-lime text-ink-900 flex items-center justify-center text-xs">✓</span>}
          <span className="flex-1 py-1">{t.text}</span>
          {t.action && (
            <button data-testid="toast-action" className="pressable px-3 h-9 rounded-xl text-lime font-semibold hover:bg-white/10"
              onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>
          )}
          <button aria-label="ปิด" className="h-9 w-9 flex items-center justify-center text-white/50" onClick={() => dismiss(t.id)}><X size={16} /></button>
        </div>
      ))}
    </div>
  );
}

function BusyOverlay() {
  const b = useBusy();
  if (!b) return null;
  return (
    <div className="fixed inset-0 z-[80] bg-ink-900/55 backdrop-blur-sm flex items-center justify-center animate-fadeIn" data-testid="busy">
      <div className="bg-white rounded-3xl p-6 w-[min(320px,86vw)] text-center shadow-2xl animate-pop">
        <Spinner size={34} className="text-lime-600 mb-3" />
        <div className="font-medium">{b.label}</div>
        {b.progress !== undefined && (
          <div className="mt-4 h-2 rounded-full bg-paper-200 overflow-hidden">
            <div className="h-full bg-lime transition-all duration-300" style={{ width: `${Math.round(b.progress * 100)}%` }} />
          </div>
        )}
        <div className="mt-3 text-xs text-ink/50">ประมวลผลในเครื่องของคุณ ไม่มีการอัปโหลด</div>
      </div>
    </div>
  );
}

function DropOverlay() {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
    const enter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; setOver(true); };
    const leave = (e: DragEvent) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) setOver(false); };
    const overH = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; setOver(false);
      if ((e.target as HTMLElement)?.closest?.('[data-own-drop]')) return;
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) importToNewDoc(files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overH);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave); window.removeEventListener('dragover', overH); window.removeEventListener('drop', drop); };
  }, []);
  if (!over) return null;
  return (
    <div className="fixed inset-0 z-[75] bg-lime/20 backdrop-blur-[2px] p-6 pointer-events-none animate-fadeIn" data-testid="drop-overlay">
      <div className="h-full rounded-3xl border-4 border-dashed border-lime-600 flex flex-col items-center justify-center text-ink-900">
        <Upload size={56} className="text-lime-700 mb-3" />
        <div className="text-2xl font-semibold">วางไฟล์เพื่อนำเข้า</div>
        <div className="text-ink/60 mt-1">รองรับรูปภาพ, HEIC และ PDF หลายไฟล์พร้อมกัน</div>
      </div>
    </div>
  );
}

export const SHORTCUTS: [string, string][] = [
  ['N', 'สแกนเอกสารใหม่ (เปิดกล้อง)'],
  ['I', 'นำเข้าจากแกลเลอรี/ไฟล์'],
  ['L', 'ไปที่คลังเอกสาร'],
  ['/', 'ค้นหาเอกสาร'],
  ['?', 'แสดงคีย์ลัด'],
  ['Ctrl/⌘ + Z', 'ย้อนกลับ (หน้าแก้ไข)'],
  ['Ctrl/⌘ + Shift + Z', 'ทำซ้ำ (หน้าแก้ไข)'],
  ['Ctrl/⌘ + S', 'บันทึก (หน้าแก้ไข)'],
  ['1 – 7', 'เลือกโหมดเอกสาร (หน้าแก้ไข)'],
  ['R / C / B', 'หมุน / ครอบตัด / เปรียบเทียบ (หน้าแก้ไข)'],
  ['+ / −', 'ซูมเข้า / ออก (หน้าแก้ไข)'],
  ['Space / ถ่าย', 'ถ่ายภาพ (หน้ากล้อง)'],
  ['Delete', 'ลบรายการที่เลือก (คลังเอกสาร)'],
  ['Esc', 'ปิด / ย้อนกลับ'],
];

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="คีย์ลัด" testId="shortcuts">
      <div className="divide-y divide-ink/5">
        {SHORTCUTS.map(([k, d]) => (
          <div key={k} className="flex justify-between gap-4 py-2 text-sm">
            <span className="text-ink/70">{d}</span>
            <kbd className="px-2 py-0.5 rounded-lg bg-paper-200 border border-ink/10 font-mono text-xs whitespace-nowrap">{k}</kbd>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};

export default function App() {
  const route = useRoute();
  const [help, setHelp] = useState(false);
  const full = route.name === 'camera' || route.name === 'editor';

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const r = route.name;
      if (e.key === '?') { setHelp(true); e.preventDefault(); }
      if (r === 'camera' || r === 'editor') return;
      if (e.key === 'n' || e.key === 'N') navigate('camera');
      else if (e.key === 'i' || e.key === 'I') pickFiles().then(importToNewDoc);
      else if (e.key === 'l' || e.key === 'L') navigate('library');
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [route.name]);

  useEffect(() => {
    const onHelp = () => setHelp(true);
    window.addEventListener('px-shortcuts', onHelp);
    return () => window.removeEventListener('px-shortcuts', onHelp);
  }, []);

  const fallback = (
    <div className="flex-1 flex items-center justify-center text-ink/40"><Spinner size={28} /></div>
  );

  let screen;
  switch (route.name) {
    case 'home': screen = <Home />; break;
    case 'library': screen = <LibraryScreen />; break;
    case 'ocr': screen = <OcrScreen id={route.id} />; break;
    case 'settings': screen = <SettingsScreen />; break;
    case 'export': screen = <ExportScreen id={route.id} />; break;
    case 'camera': screen = <CameraScreen docId={route.id} />; break;
    case 'editor': screen = <Editor id={route.id} startPage={route.page} />; break;
  }
  const routeKey = route.name + ('id' in route ? route.id || '' : '');

  return (
    <div className="h-full flex">
      {!full && <Sidebar route={route} />}
      <main className={cx('flex-1 min-w-0 flex flex-col', full ? 'h-full' : 'h-full overflow-y-auto overflow-x-hidden')} id="main">
        <Suspense fallback={fallback}>
          <div key={routeKey} className={cx('flex-1 flex flex-col min-h-0', !full && 'route-enter')}>{screen}</div>
        </Suspense>
        {!full && <div className="md:hidden h-24 shrink-0" />}
      </main>
      {!full && <BottomNav route={route} />}
      <Toasts />
      <BusyOverlay />
      <DropOverlay />
      <ShortcutHelp open={help} onClose={() => setHelp(false)} />
    </div>
  );
}

