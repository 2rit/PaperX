import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, BookOpen, Camera, Waves, Columns2, Crop, Download, FileText, Image as ImageIcon, Keyboard, MoreHorizontal, Redo2, RotateCw,
  Share2, Sparkles, SlidersHorizontal, SquareDashed, Trash2, Undo2, Wand2, ZoomIn, ZoomOut, Check, Copy,
} from 'lucide-react';
import { getBlob, getDoc, saveDoc, useDocs, duplicateDoc, deleteDocs, restoreDocs, pendingKeys } from '../lib/docs';
import { ensureSource, renderBitmap, detectSkew, detectSpine } from '../lib/engine';
import { renderPage, splitBook } from '../lib/pages';
import { importIntoDoc, pickFiles } from '../lib/actions';
import { navigate, back } from '../lib/router';
import { toast } from '../lib/toast';
import { haptic } from '../lib/haptics';
import { MODES, type Doc, type Mode, type Page, type PageParams } from '../lib/types';
import { Button, IconButton, Sheet, Slider, Spinner, Toggle, cx } from '../components/ui';
import { InlineName } from '../components/DocCard';
import BitmapCanvas from '../components/BitmapCanvas';
import CropView from '../components/CropView';
import PageStrip from '../components/PageStrip';
import { setBusy } from '../lib/busy';
import { exportDoc, canShareFiles, shareFiles } from '../lib/exporter';
import { getSettings } from '../lib/settings';

const PARAM_KEYS: (keyof PageParams)[] = ['corners', 'mids', 'rotation', 'angle', 'mode', 'brightness', 'contrast', 'saturation', 'shadow', 'sharpen', 'flatten', 'book'];
const paramsOf = (p: Page): PageParams => Object.fromEntries(PARAM_KEYS.map((k) => [k, (p as any)[k]])) as any;
const sig = (p: Page) => JSON.stringify(paramsOf(p));

type SheetKind = 'filters' | 'adjust' | 'angle' | 'more' | 'add' | 'book' | null;
const isSibling = (a: Page, b: Page) => a.id !== b.id && a.srcKey === b.srcKey && !!a.book && !!b.book && a.book.side !== b.book.side;

export default function Editor({ id, startPage = 0 }: { id: string; startPage?: number }) {
  const docs = useDocs();
  const stored = docs.find((d) => d.id === id);
  const [doc, setDoc] = useState<Doc | null>(() => (stored ? structuredClone(stored) : null));
  const [cur, setCur] = useState(Math.min(startPage, (stored?.pages.length || 1) - 1));
  const [past, setPast] = useState<Page[][]>([]);
  const [future, setFuture] = useState<Page[][]>([]);
  const lastCoalesce = useRef<{ key: string; t: number } | null>(null);
  const [saved, setSaved] = useState<Map<string, string>>(() => new Map(stored?.pages.map((p) => [p.id, sig(p)])));
  const [view, setView] = useState<'edit' | 'crop' | 'compare'>('edit');
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [bmp, setBmp] = useState<ImageBitmap | null>(null);
  const [rawBmp, setRawBmp] = useState<ImageBitmap | null>(null);
  const [rendering, setRendering] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [split, setSplit] = useState(0.5);
  const [editingName, setEditingName] = useState(false);
  const [saving, setSaving] = useState(false);
  const [skewBusy, setSkewBusy] = useState(false);

  // pick up doc once store has loaded / name changed externally
  useEffect(() => {
    if (!stored) return;
    if (!doc) { setDoc(structuredClone(stored)); setSaved(new Map(stored.pages.map((p) => [p.id, sig(p)]))); }
    else if (stored.name !== doc.name) setDoc((d) => (d ? { ...d, name: stored.name } : d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);

  const pages = doc?.pages || [];
  const page = pages[Math.min(cur, pages.length - 1)];
  const dirtyIds = useMemo(() => new Set(pages.filter((p) => saved.get(p.id) !== sig(p) || !p.outKey).map((p) => p.id)), [pages, saved]);
  const orderChanged = useMemo(() => !!stored && (stored.pages.length !== pages.length || stored.pages.some((p, i) => p.id !== pages[i]?.id)), [stored, pages]);
  const dirty = dirtyIds.size > 0 || orderChanged;

  // ---------- history ----------
  const commit = useCallback((next: Page[], coalesce?: string) => {
    setDoc((d) => {
      if (!d) return d;
      const now = Date.now();
      const lc = lastCoalesce.current;
      const merge = coalesce && lc && lc.key === coalesce && now - lc.t < 800;
      if (!merge) { setPast((p) => [...p.slice(-60), d.pages]); setFuture([]); }
      lastCoalesce.current = coalesce ? { key: coalesce, t: now } : null;
      return { ...d, pages: next };
    });
  }, []);
  const update = (patch: Partial<PageParams>, coalesce?: string) => {
    if (!page) return;
    // the two halves of a book spread share the spread geometry (crop quad + edge curve)
    const shared: Partial<PageParams> = {};
    if (page.book) { if ('corners' in patch) shared.corners = patch.corners; if ('mids' in patch) shared.mids = patch.mids; }
    commit(pages.map((p) => (p.id === page.id ? { ...p, ...patch } : Object.keys(shared).length && isSibling(p, page) ? { ...p, ...shared } : p)), coalesce ? coalesce + page.id : undefined);
  };
  const undo = () => {
    if (!past.length || !doc) return;
    haptic('tap');
    setFuture((f) => [doc.pages, ...f]);
    const prev = past[past.length - 1];
    setPast((p) => p.slice(0, -1));
    setDoc({ ...doc, pages: prev });
    setCur((c) => Math.min(c, prev.length - 1));
    lastCoalesce.current = null;
  };
  const redo = () => {
    if (!future.length || !doc) return;
    haptic('tap');
    setPast((p) => [...p, doc.pages]);
    const nx = future[0];
    setFuture((f) => f.slice(1));
    setDoc({ ...doc, pages: nx });
    setCur((c) => Math.min(c, nx.length - 1));
    lastCoalesce.current = null;
  };

  // ---------- live preview (worker, latest-only) ----------
  const reqRef = useRef(0);
  const pageSig = page ? sig(page) + page.srcKey : '';
  useEffect(() => {
    if (!page) return;
    const my = ++reqRef.current;
    setRendering(true);
    const t = setTimeout(async () => {
      try {
        await ensureSource(page.srcKey, () => getBlob(page.srcKey));
        if (my !== reqRef.current) return;
        const r = await renderBitmap(page.srcKey, paramsOf(page), 'preview');
        if (my !== reqRef.current) { r.bitmap.close(); return; }
        setBmp((old) => { old?.close(); return r.bitmap; });
      } catch (e) {
        console.error(e);
        toast('แสดงตัวอย่างไม่สำเร็จ', { kind: 'error' });
      } finally {
        if (my === reqRef.current) setRendering(false);
      }
    }, 16);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSig]);

  // raw (unfiltered) render for compare
  useEffect(() => {
    if (view !== 'compare' || !page) return;
    let alive = true;
    (async () => {
      await ensureSource(page.srcKey, () => getBlob(page.srcKey));
      const r = await renderBitmap(page.srcKey, { ...paramsOf(page), mode: 'original', brightness: 0, contrast: 0, saturation: 0, shadow: false, sharpen: false }, 'preview', true);
      if (alive) setRawBmp((old) => { old?.close(); return r.bitmap; }); else r.bitmap.close();
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, page?.srcKey, JSON.stringify(page?.corners), JSON.stringify(page?.mids), page?.rotation, page?.angle, JSON.stringify(page?.book || null), page?.flatten]);

  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, [cur]);

  // ---------- zoom / pan / pinch ----------
  const stageRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = fitRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const cs = getComputedStyle(el);
      const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), h = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      setBox((b) => (b.w === w && b.h === h ? b : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [!!page, view === 'crop']);
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; z: number } | null>(null);
  const lastTap = useRef(0);
  const clampZoom = (z: number) => Math.max(1, Math.min(6, z));
  const setZ = (z: number) => { const nz = clampZoom(z); setZoom(nz); if (nz === 1) setPan({ x: 0, y: 0 }); };
  const onPDown = (e: React.PointerEvent) => {
    if (view !== 'edit' || (e.target as HTMLElement).closest('button,input,[data-testid=crop-view]')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size === 2) {
      const [a, b] = [...ptrs.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), z: zoom };
    }
    const now = Date.now();
    if (ptrs.current.size === 1 && now - lastTap.current < 280) { setZ(zoom > 1 ? 1 : 2.5); lastTap.current = 0; }
    else lastTap.current = now;
  };
  const onPMove = (e: React.PointerEvent) => {
    const prev = ptrs.current.get(e.pointerId);
    if (!prev) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size === 2 && pinch.current) {
      const [a, b] = [...ptrs.current.values()];
      setZ(pinch.current.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.d));
    } else if (zoom > 1) {
      setPan((p) => ({ x: p.x + (e.clientX - prev.x) / zoom, y: p.y + (e.clientY - prev.y) / zoom }));
    }
  };
  const onPUp = (e: React.PointerEvent) => { ptrs.current.delete(e.pointerId); if (ptrs.current.size < 2) pinch.current = null; };
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const w = (e: WheelEvent) => {
      if (view !== 'edit') return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > 0) setZoom((z) => { const nz = clampZoom(z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002))); if (nz === 1) setPan({ x: 0, y: 0 }); return nz; });
    };
    el.addEventListener('wheel', w, { passive: false });
    return () => el.removeEventListener('wheel', w);
  }, [view]);

  // ---------- actions ----------
  const rotate = () => { haptic('tap'); update({ rotation: (((page.rotation + 90) % 360) as any) }); };
  const setMode = (m: Mode) => { haptic('tap'); update({ mode: m }); };
  const applyAll = () => {
    const p = page;
    commit(pages.map((x) => ({ ...x, mode: p.mode, brightness: p.brightness, contrast: p.contrast, saturation: p.saturation, shadow: p.shadow, sharpen: p.sharpen, flatten: p.flatten })));
    toast(`ใช้การตั้งค่านี้กับทั้ง ${pages.length} หน้าแล้ว`, { kind: 'success' });
  };
  const autoStraighten = async () => {
    setSkewBusy(true);
    try {
      await ensureSource(page.srcKey, () => getBlob(page.srcKey));
      const { angle } = await detectSkew(page.srcKey, paramsOf(page));
      update({ angle: -angle });
      toast(angle ? `ปรับมุมอัตโนมัติ ${(-angle).toFixed(1)}°` : 'เอกสารตรงอยู่แล้ว', { kind: 'success' });
    } finally {
      setSkewBusy(false);
    }
  };
  const [bookBusy, setBookBusy] = useState(false);
  const toBook = async () => {
    setBookBusy(true);
    try {
      const [l, r] = await splitBook({ ...page, flatten: page.flatten ?? true });
      // render both halves right away so the page strip shows real thumbnails (still unsaved until บันทึก)
      const [lp, rp] = await Promise.all([renderPage({ ...l, id: page.id }), renderPage(r)]); // left half keeps the current id
      commit(pages.flatMap((p) => (p.id === page.id ? [lp, rp] : [p])));
      haptic('success');
      toast(`แยกเป็น 2 หน้าแล้ว (สันหนังสือ ${Math.round(l.book!.at * 100)}%)`, { kind: 'success', action: { label: 'เลิกทำ', run: () => document.dispatchEvent(new CustomEvent('px-undo')) } });
    } catch (e: any) {
      toast('แยกหน้าไม่สำเร็จ: ' + (e?.message || e), { kind: 'error' });
    } finally { setBookBusy(false); }
  };
  const setSpine = (at: number, coalesce = true) => {
    if (!page.book) return;
    commit(pages.map((p) => (p.id === page.id || isSibling(p, page) ? { ...p, book: { ...p.book!, at } } : p)), coalesce ? 'spine' + page.srcKey : undefined);
  };
  const autoSpine = async () => {
    setBookBusy(true);
    try {
      await ensureSource(page.srcKey, () => getBlob(page.srcKey));
      const { at } = await detectSpine(page.srcKey, { ...paramsOf(page), book: null });
      setSpine(at, false);
      toast(`พบสันหนังสือที่ ${Math.round(at * 100)}%`, { kind: 'success' });
    } finally { setBookBusy(false); }
  };
  const unBook = () => {
    const keep = page.book!.side === 'L' ? page : pages.find((p) => isSibling(p, page)) || page;
    const next = pages.filter((p) => !(isSibling(p, page) || p.id === page.id) || p.id === keep.id).map((p) => (p.id === keep.id ? { ...p, book: null } : p));
    commit(next);
    setCur(Math.max(0, next.findIndex((p) => p.id === keep.id)));
    setSheet(null);
    toast('รวมกลับเป็นหน้าเดียวแล้ว', { action: { label: 'เลิกทำ', run: () => document.dispatchEvent(new CustomEvent('px-undo')) } });
  };
  const reorder = (from: number, to: number) => {
    const next = [...pages];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    commit(next);
    setCur(to);
  };
  const deletePage = (i: number) => {
    if (pages.length <= 1) return;
    commit(pages.filter((_, k) => k !== i));
    setCur((c) => Math.max(0, Math.min(c, pages.length - 2)));
    haptic('warn');
    toast(`ลบหน้า ${i + 1} แล้ว`, { action: { label: 'เลิกทำ', run: () => document.dispatchEvent(new CustomEvent('px-undo')) } });
  };
  useEffect(() => {
    const u = () => undo();
    document.addEventListener('px-undo', u);
    return () => document.removeEventListener('px-undo', u);
  });

  const save = async (silent = false): Promise<Doc | null> => {
    if (!doc) return null;
    setSaving(true);
    try {
      const out: Page[] = [];
      const todo = doc.pages.filter((p) => dirtyIds.has(p.id)).length;
      let n = 0;
      for (const p of doc.pages) {
        if (dirtyIds.has(p.id)) {
          n++;
          if (todo > 1) setBusy({ label: `กำลังบันทึกหน้า ${n}/${todo}`, progress: n / todo });
          out.push(await renderPage(p));
        } else out.push(p);
      }
      out.forEach((p) => [p.srcKey, p.outKey, p.thumbKey].forEach((k) => k && pendingKeys.delete(k)));
      const nd = await saveDoc({ ...doc, pages: out, updatedAt: Date.now() });
      setDoc(structuredClone(nd));
      setSaved(new Map(out.map((p) => [p.id, sig(p)])));
      if (!silent) { haptic('success'); toast('บันทึกแล้ว', { kind: 'success', action: { label: 'ส่งออก', run: () => navigate(`export/${nd.id}`) } }); }
      return nd;
    } catch (e: any) {
      toast('บันทึกไม่สำเร็จ: ' + (e?.message || e), { kind: 'error' });
      return null;
    } finally {
      setSaving(false);
      setBusy(null);
    }
  };

  const leave = async (to?: string) => {
    if (dirty) await save(true);
    if (to) navigate(to);
    else back('library');
  };

  const addFromGallery = async () => {
    setSheet(null);
    const files = await pickFiles();
    if (!files.length || !doc) return;
    if (dirty) await save(true);
    const nd = await importIntoDoc(doc.id, files);
    if (nd) { setDoc(structuredClone(nd)); setSaved(new Map(nd.pages.map((p) => [p.id, sig(p)]))); setCur(nd.pages.length - 1); }
  };
  const addFromCamera = async () => { setSheet(null); await leave(`camera?doc=${id}`); };

  const share = async () => {
    setSheet(null);
    const d = dirty ? await save(true) : doc;
    if (!d) return;
    setBusy({ label: 'กำลังเตรียมไฟล์…' });
    try {
      const s = getSettings();
      const files = await exportDoc(d, { format: 'pdf', paper: s.paper, quality: s.quality });
      await shareFiles(files, d.name);
    } catch (e: any) {
      if (e?.name !== 'AbortError') toast('แชร์ไม่สำเร็จ', { kind: 'error' });
    } finally { setBusy(null); }
  };
  const duplicate = async () => {
    setSheet(null);
    if (dirty) await save(true);
    const nd = await duplicateDoc(id);
    if (nd) toast('สร้างสำเนาแล้ว', { kind: 'success', action: { label: 'เปิด', run: () => navigate(`editor/${nd.id}`) } });
  };
  const removeDoc = async () => {
    setSheet(null);
    const removed = await deleteDocs([id]);
    toast('ลบเอกสารแล้ว', { action: { label: 'เลิกทำ', run: () => restoreDocs(removed) } });
    navigate('library', true);
  };

  // ---------- keyboard ----------
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range') return;
      if (t.tagName === 'TEXTAREA') return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && key === 'y') { e.preventDefault(); redo(); return; }
      if (mod && key === 's') { e.preventDefault(); save(); return; }
      if (mod || view === 'crop' || sheet) return;
      const modeKey = Number(e.key);
      if (modeKey >= 1 && modeKey <= MODES.length) setMode(MODES[modeKey - 1].id);
      else if (key === 'r') rotate();
      else if (key === 'c') setView('crop');
      else if (key === 'b') setView((v) => (v === 'compare' ? 'edit' : 'compare'));
      else if (e.key === '+' || e.key === '=') setZ(zoom * 1.25);
      else if (e.key === '-') setZ(zoom / 1.25);
      else if (e.key === '0') setZ(1);
      else if (e.key === 'ArrowRight') setCur((c) => Math.min(pages.length - 1, c + 1));
      else if (e.key === 'ArrowLeft') setCur((c) => Math.max(0, c - 1));
      else if (e.key === 'Escape') { if (view === 'compare') setView('edit'); else leave(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  // ---------- not found ----------
  if (!doc || !page) {
    return (
      <div className="fixed inset-0 bg-ink-900 text-white flex flex-col items-center justify-center gap-4" data-testid="editor-missing">
        {stored === undefined && docs.length === 0 ? <Spinner size={30} /> : <>
          <div>ไม่พบเอกสารนี้</div>
          <Button variant="lime" onClick={() => navigate('library', true)}>ไปที่คลังเอกสาร</Button>
        </>}
      </div>
    );
  }

  const modeList = (
    <div className="space-y-0.5" role="radiogroup" aria-label="โหมดเอกสาร">
      {MODES.map((m, i) => (
        <button key={m.id} role="radio" aria-checked={page.mode === m.id} data-testid={'mode-' + m.id} onClick={() => setMode(m.id)}
          className={cx('pressable w-full flex items-center gap-3 h-10 md:h-9 px-2 rounded-xl text-[14px] transition-colors', page.mode === m.id ? 'bg-white/5 text-white' : 'text-white/80 hover:bg-white/5')}>
          <span className={cx('h-5 w-5 rounded-full border-2 flex items-center justify-center shrink-0', page.mode === m.id ? 'bg-lime border-lime text-ink-900' : 'border-white/50')}>
            {page.mode === m.id && <Check size={12} strokeWidth={4} />}
          </span>
          <span className="flex-1 text-left">{m.label}</span>
          <kbd className="hidden lg:inline text-[10px] text-white/30">{i + 1}</kbd>
        </button>
      ))}
    </div>
  );
  const sliders = (
    <div className="space-y-2">
      <Slider dark id="sl-brightness" label="ความสว่าง" value={page.brightness} onChange={(v) => update({ brightness: v }, 'b')} />
      <Slider dark id="sl-contrast" label="ความคมชัด" value={page.contrast} onChange={(v) => update({ contrast: v }, 'c')} />
      <Slider dark id="sl-saturation" label="ความอิ่มตัว" value={page.saturation} onChange={(v) => update({ saturation: v }, 's')} />
    </div>
  );

  const tools: { id: string; label: string; icon: any; run: () => void; active?: boolean }[] = [
    { id: 'crop', label: 'ครอบตัด', icon: Crop, run: () => setView('crop'), active: view === 'crop' },
    { id: 'rotate', label: 'หมุน', icon: RotateCw, run: rotate },
    { id: 'angle', label: 'ปรับมุม', icon: SquareDashed, run: () => setSheet('angle'), active: sheet === 'angle' },
    { id: 'filters', label: 'ฟิลเตอร์', icon: Sparkles, run: () => setSheet('filters'), active: sheet === 'filters' },
    { id: 'adjust', label: 'ปรับแต่ง', icon: SlidersHorizontal, run: () => setSheet('adjust'), active: sheet === 'adjust' },
    { id: 'book', label: 'หนังสือ', icon: BookOpen, run: () => setSheet('book'), active: sheet === 'book' || !!page.book },
    { id: 'compare', label: 'เปรียบเทียบ', icon: Columns2, run: () => setView((v) => (v === 'compare' ? 'edit' : 'compare')), active: view === 'compare' },
  ];

  const imgStyle: React.CSSProperties = { transform: `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)`, transition: ptrs.current.size ? 'none' : 'transform .18s ease-out' };

  return (
    <div className="fixed inset-0 bg-ink-900 text-white flex flex-col" data-testid="editor">
      {/* top bar */}
      <header className="pt-safe bg-ink-900 border-b border-white/5 relative z-30">
        <div className="h-14 flex items-center gap-1 px-2 pl-safe pr-safe">
          <IconButton label="ย้อนกลับ" data-testid="ed-back" onClick={() => leave()} className="hover:bg-white/10"><ArrowLeft size={22} /></IconButton>
          <div className="min-w-0 flex-1 px-1">
            <button className="max-w-full text-left text-sm font-medium flex items-center" onClick={() => setEditingName(true)} data-testid="ed-name">
              <InlineName doc={doc} editing={editingName} setEditing={setEditingName} className="text-white bg-transparent [&]:text-sm" />
            </button>
            <div className="text-[11px] text-white/45 flex items-center gap-1.5">
              หน้า {cur + 1}/{pages.length}
              {dirty ? <span className="text-amber-300">· ยังไม่บันทึก</span> : <span className="text-lime">· บันทึกแล้ว</span>}
              {rendering && <Spinner size={10} className="text-white/50" />}
            </div>
          </div>
          <IconButton label="ย้อนกลับการแก้ไข (Ctrl+Z)" data-testid="ed-undo" disabled={!past.length} onClick={undo} className="hover:bg-white/10"><Undo2 size={21} /></IconButton>
          <IconButton label="ทำซ้ำ (Ctrl+Shift+Z)" data-testid="ed-redo" disabled={!future.length} onClick={redo} className="hover:bg-white/10"><Redo2 size={21} /></IconButton>
          <IconButton label="ซูมเข้า" data-testid="ed-zoomin" disabled={zoom >= 6 || view !== 'edit'} onClick={() => setZ(zoom * 1.4)} className="hover:bg-white/10 hidden sm:inline-flex"><ZoomIn size={21} /></IconButton>
          <IconButton label="ซูมออก" data-testid="ed-zoomout" disabled={zoom <= 1 || view !== 'edit'} onClick={() => setZ(zoom / 1.4)} className="hover:bg-white/10 hidden sm:inline-flex"><ZoomOut size={21} /></IconButton>
          <IconButton label="เมนูเพิ่มเติม" data-testid="ed-more" onClick={() => setSheet('more')} className="hover:bg-white/10"><MoreHorizontal size={21} /></IconButton>
          <Button variant="lime" size="sm" data-testid="ed-save" onClick={() => save()} disabled={saving} className="ml-1 px-4 h-10">
            {saving ? <Spinner size={14} /> : null}บันทึก
          </Button>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        {/* stage */}
        <div className="relative flex-1 min-w-0 flex flex-col">
          <div ref={stageRef} className="relative flex-1 min-h-0 overflow-hidden checker touch-none" onPointerDown={onPDown} onPointerMove={onPMove} onPointerUp={onPUp} onPointerCancel={onPUp} data-testid="ed-stage">
            <div ref={fitRef} className="absolute inset-0 p-4 sm:p-6 flex items-center justify-center">
              {bmp ? (
                <div className="relative shrink-0" style={{ ...imgStyle, ...fitSize(bmp, box) }}>
                  <BitmapCanvas bitmap={bmp} testId="ed-canvas" className="block w-full h-full paper-shadow bg-white" />
                  {view === 'compare' && rawBmp && (
                    <div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 ${100 - split * 100}% 0 0)` }} data-testid="ed-compare">
                      <BitmapCanvas bitmap={rawBmp} className="w-full h-full" />
                    </div>
                  )}
                  {sheet === 'angle' && <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(142,224,74,.35) 1px, transparent 1px), linear-gradient(90deg, rgba(142,224,74,.35) 1px, transparent 1px)', backgroundSize: '12.5% 12.5%' }} />}
                </div>
              ) : <Spinner size={30} className="text-white/50" />}
            </div>
            {view === 'compare' && (
              <>
                <input aria-label="ตำแหน่งเปรียบเทียบ" data-testid="ed-split" type="range" min={0} max={100} value={split * 100} onChange={(e) => setSplit(Number(e.target.value) / 100)}
                  className="px-range absolute bottom-3 left-1/2 -translate-x-1/2 w-[min(420px,80%)] z-10" style={{ ['--pct' as any]: split * 100 + '%' }} />
                <div className="absolute top-3 left-3 text-xs bg-black/60 rounded-full px-3 py-1">ก่อน</div>
                <div className="absolute top-3 right-3 text-xs bg-lime text-ink-900 font-semibold rounded-full px-3 py-1">หลัง</div>
              </>
            )}
            {view === 'edit' && (
              <button data-testid="ed-flatten-chip" aria-pressed={!!page.flatten} onClick={() => { haptic('tap'); update({ flatten: !page.flatten }); toast(page.flatten ? 'ปิด Auto Flatten' : 'เปิด Auto Flatten · คลี่หน้าโค้ง/ยับให้เรียบ', { ms: 1600 }); }}
                className={cx('pressable absolute top-3 left-3 z-10 h-9 px-3 rounded-full text-xs font-medium flex items-center gap-1.5 backdrop-blur', page.flatten ? 'bg-lime text-ink-900' : 'bg-black/60 text-white/85')}>
                <Waves size={15} />Auto Flatten {page.flatten ? 'เปิด' : 'ปิด'}
              </button>
            )}
            {page.book && view === 'edit' && (
              <div className="absolute top-3 right-3 z-10 h-9 px-3 rounded-full text-xs bg-black/60 flex items-center gap-1.5" data-testid="ed-book-badge"><BookOpen size={14} />หน้า{page.book.side === 'L' ? 'ซ้าย' : 'ขวา'}</div>
            )}
            {zoom > 1 && view === 'edit' && (
              <button onClick={() => setZ(1)} className="absolute bottom-3 left-3 text-xs bg-black/60 rounded-full px-3 h-8" data-testid="ed-zoom-reset">{Math.round(zoom * 100)}% · รีเซ็ต</button>
            )}
            {view === 'crop' && (
              <CropView srcKey={page.srcKey} corners={page.corners} mids={page.mids}
                onCancel={() => setView('edit')}
                onApply={(q, m) => { update({ corners: q, mids: m }); setView('edit'); haptic('success'); }} />
            )}
          </div>
          {view !== 'crop' && (
            <div className="bg-ink-800/60 border-t border-white/5">
              <PageStrip pages={pages} current={cur} onSelect={setCur} onReorder={reorder} onDelete={deletePage} onAdd={() => setSheet('add')} dirtyIds={dirtyIds} />
            </div>
          )}
        </div>

        {/* right panel (tablet / desktop) */}
        {view !== 'crop' && (
          <aside className="hidden md:flex flex-col w-[250px] lg:w-[270px] shrink-0 bg-ink-800 border-l border-white/5 overflow-y-auto pr-safe" data-testid="ed-panel">
            <div className="px-4 pt-3 pb-2">
              <h3 className="font-semibold mb-1.5">โหมดเอกสาร</h3>
              {modeList}
              <h3 className="font-semibold mt-4 mb-1 text-sm text-white/80">การปรับแต่ง</h3>
              {sliders}
              <div className="flex items-center justify-between mt-3 py-1"><div><div className="text-sm">Auto Flatten</div><div className="text-[11px] text-white/50">คลี่หน้าโค้ง/ยับให้เรียบ</div></div><Toggle id="pn-flatten" label="Auto Flatten" checked={!!page.flatten} onChange={(v) => update({ flatten: v })} /></div>
              <button data-testid="ed-applyall" onClick={applyAll} disabled={pages.length < 2} className="pressable mt-3 w-full h-10 rounded-xl bg-white/5 hover:bg-white/10 text-sm disabled:opacity-30">ใช้กับทุกหน้า</button>
            </div>
            <div className="mt-auto px-4 py-3 grid grid-cols-2 gap-2 border-t border-white/5">
              <Button variant="dark" size="sm" className="bg-white/10" data-testid="ed-ocr" onClick={() => leave(`ocr/${id}`)}><FileText size={16} />OCR</Button>
              <Button variant="soft" size="sm" data-testid="ed-export" onClick={() => leave(`export/${id}`)}><Download size={16} />ส่งออก</Button>
            </div>
          </aside>
        )}
      </div>

      {/* bottom toolbar */}
      {view !== 'crop' && (
        <nav className="bg-ink-900 border-t border-white/5 pb-safe-0 pl-safe pr-safe relative z-20" data-testid="ed-toolbar">
          <div className="flex max-w-3xl mx-auto">
            {tools.map((t) => (
              <button key={t.id} data-testid={'tool-' + t.id} onClick={() => { haptic('tap'); t.run(); }}
                className={cx('pressable flex-1 flex flex-col items-center justify-center gap-1 h-16 text-[11px] sm:text-xs', t.active ? 'text-lime' : 'text-white/85 hover:text-white')}>
                <t.icon size={22} />{t.label}
              </button>
            ))}
          </div>
        </nav>
      )}

      {/* sheets */}
      <Sheet open={sheet === 'filters'} onClose={() => setSheet(null)} title="ฟิลเตอร์" dark wide testId="sheet-filters">
        <ModeThumbs page={page} onPick={(m) => setMode(m)} />
        <div className="md:hidden mt-4">{sliders}</div>
        <button onClick={applyAll} disabled={pages.length < 2} data-testid="sheet-applyall" className="pressable mt-4 w-full h-11 rounded-xl bg-white/10 text-sm disabled:opacity-30">ใช้ฟิลเตอร์นี้กับทุกหน้า</button>
      </Sheet>

      <Sheet open={sheet === 'adjust'} onClose={() => setSheet(null)} title="ปรับแต่ง" dark testId="sheet-adjust">
        {sliders}
        <div className="mt-4 divide-y divide-white/5">
          <div className="flex items-center justify-between py-3"><div><div className="text-sm">Auto Flatten</div><div className="text-xs text-white/50">คลี่หน้าโค้ง/ยับให้เรียบจากแนวบรรทัด</div></div><Toggle id="tg-flatten" label="Auto Flatten" checked={!!page.flatten} onChange={(v) => update({ flatten: v })} /></div>
          <div className="flex items-center justify-between py-3"><div><div className="text-sm">Shadow Removal</div><div className="text-xs text-white/50">ลดเงาและแสงไม่สม่ำเสมอ</div></div><Toggle id="tg-shadow" label="ลดเงา" checked={page.shadow} onChange={(v) => update({ shadow: v })} /></div>
          <div className="flex items-center justify-between py-3"><div><div className="text-sm">Text Enhancement</div><div className="text-xs text-white/50">เพิ่มความคมชัดตัวอักษร</div></div><Toggle id="tg-sharpen" label="เพิ่มความคม" checked={page.sharpen} onChange={(v) => update({ sharpen: v })} /></div>
        </div>
        <div className="flex gap-2 mt-3">
          <Button variant="dark" size="sm" className="bg-white/10 flex-1" data-testid="adjust-reset" onClick={() => update({ brightness: 0, contrast: 0, saturation: 0 })}>รีเซ็ตค่า</Button>
          <Button variant="dark" size="sm" className="bg-white/10 flex-1" onClick={applyAll} disabled={pages.length < 2}>ใช้กับทุกหน้า</Button>
        </div>
      </Sheet>

      <Sheet open={sheet === 'angle'} onClose={() => setSheet(null)} title="ปรับมุม" dark testId="sheet-angle">
        <Slider dark id="sl-angle" label="มุมเอียง" unit="°" min={-15} max={15} value={page.angle} onChange={(v) => update({ angle: v }, 'a')} />
        <div className="flex gap-2 mt-4">
          <Button variant="lime" size="sm" className="flex-1" data-testid="angle-auto" onClick={autoStraighten} disabled={skewBusy}>{skewBusy ? <Spinner size={14} /> : <Wand2 size={16} />} ปรับอัตโนมัติ</Button>
          <Button variant="dark" size="sm" className="bg-white/10" onClick={() => update({ angle: Math.max(-15, page.angle - 0.5) }, 'a')}>−0.5°</Button>
          <Button variant="dark" size="sm" className="bg-white/10" onClick={() => update({ angle: Math.min(15, page.angle + 0.5) }, 'a')}>+0.5°</Button>
          <Button variant="dark" size="sm" className="bg-white/10" data-testid="angle-reset" onClick={() => update({ angle: 0 })}>0°</Button>
        </div>
      </Sheet>

      <Sheet open={sheet === 'book'} onClose={() => setSheet(null)} title="โหมดหนังสือ" dark testId="sheet-book">
        {page.book ? (
          <>
            <p className="text-sm text-white/60 mb-3">หน้านี้คือหน้า{page.book.side === 'L' ? 'ซ้าย' : 'ขวา'}ของหนังสือ เลื่อนเพื่อปรับตำแหน่งสัน (ใช้กับทั้งสองหน้า)</p>
            <Slider dark id="sl-spine" label="ตำแหน่งสันหนังสือ" unit="%" min={20} max={80} value={Math.round(page.book.at * 100)} onChange={(v) => setSpine(v / 100)} />
            <div className="flex gap-2 mt-4">
              <Button variant="lime" size="sm" className="flex-1" data-testid="book-auto" onClick={autoSpine} disabled={bookBusy}>{bookBusy ? <Spinner size={14} /> : <Wand2 size={16} />}หาสันอัตโนมัติ</Button>
              <Button variant="dark" size="sm" className="bg-white/10 flex-1" data-testid="book-merge" onClick={unBook}>รวมเป็นหน้าเดียว</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-white/60 mb-4">ถ่ายหนังสือที่เปิดอยู่ทั้ง 2 หน้าในภาพเดียว ระบบจะหาสันหนังสือ แยกเป็นหน้าซ้าย/ขวา และคลี่หน้าโค้งให้เรียบอัตโนมัติ</p>
            <Button variant="lime" className="w-full" data-testid="book-split" onClick={async () => { await toBook(); setSheet(null); }} disabled={bookBusy}>{bookBusy ? <Spinner size={14} /> : <BookOpen size={18} />}แยกเป็น 2 หน้า (ซ้าย / ขวา)</Button>
          </>
        )}
        <div className="flex items-center justify-between py-3 mt-3 border-t border-white/5"><div><div className="text-sm">Auto Flatten</div><div className="text-xs text-white/50">คลี่หน้าโค้งของหนังสือให้เรียบ</div></div><Toggle id="bk-flatten" label="Auto Flatten" checked={!!page.flatten} onChange={(v) => update({ flatten: v })} /></div>
      </Sheet>

      <Sheet open={sheet === 'add'} onClose={() => setSheet(null)} title="เพิ่มหน้า" testId="sheet-add">
        <div className="grid grid-cols-2 gap-3">
          <Button variant="lime" size="lg" onClick={addFromCamera} data-testid="add-camera"><Camera size={20} />สแกนเพิ่ม</Button>
          <Button size="lg" onClick={addFromGallery} data-testid="add-gallery"><ImageIcon size={20} />จากแกลเลอรี</Button>
        </div>
      </Sheet>

      <Sheet open={sheet === 'more'} onClose={() => setSheet(null)} title="เพิ่มเติม" testId="sheet-more">
        <div className="grid grid-cols-1 gap-1">
          {[
            { t: 'ส่งออก PDF / JPG / PNG', i: Download, run: () => leave(`export/${id}`), id: 'more-export' },
            { t: 'ดึงข้อความ (OCR)', i: FileText, run: () => leave(`ocr/${id}`), id: 'more-ocr' },
            ...(canShareFiles() ? [{ t: 'แชร์เป็น PDF', i: Share2, run: share, id: 'more-share' }] : []),
            { t: 'เพิ่มหน้า', i: ImageIcon, run: () => setSheet('add'), id: 'more-add' },
            { t: 'ทำสำเนาเอกสาร', i: Copy, run: duplicate, id: 'more-dup' },
            { t: 'คีย์ลัด', i: Keyboard, run: () => { setSheet(null); window.dispatchEvent(new Event('px-shortcuts')); }, id: 'more-keys' },
            { t: 'ลบเอกสารนี้', i: Trash2, run: removeDoc, id: 'more-delete', danger: true },
          ].map((a: any) => (
            <button key={a.id} data-testid={a.id} onClick={a.run} className={cx('pressable flex items-center gap-3 h-12 px-3 rounded-xl hover:bg-ink/5 text-left', a.danger && 'text-red-600')}>
              <a.i size={19} /> {a.t}
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}

/** explicit contain-fit size (px): avoids intrinsic-size canvas layout quirks in WebKit */
function fitSize(b: ImageBitmap, box: { w: number; h: number }): React.CSSProperties {
  if (!b.width || !box.w || !box.h) return { width: 0, height: 0 };
  const k = Math.min(box.w / b.width, box.h / b.height);
  return { width: Math.floor(b.width * k), height: Math.floor(b.height * k) };
}

function ModeThumbs({ page, onPick }: { page: Page; onPick: (m: Mode) => void }) {
  const [thumbs, setThumbs] = useState<Partial<Record<Mode, ImageBitmap>>>({});
  const geo = JSON.stringify([page.corners, page.mids, page.rotation, page.angle, page.shadow, page.sharpen, page.srcKey, page.flatten, page.book]);
  useEffect(() => {
    let alive = true;
    (async () => {
      await ensureSource(page.srcKey, () => getBlob(page.srcKey));
      for (const m of MODES) {
        const r = await renderBitmap(page.srcKey, { ...paramsOf(page), mode: m.id, brightness: 0, contrast: 0, saturation: 0 }, 'modeThumb');
        if (!alive) { r.bitmap.close(); return; }
        setThumbs((t) => ({ ...t, [m.id]: r.bitmap }));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo]);
  return (
    <div className="grid grid-cols-4 sm:grid-cols-7 gap-2" data-testid="mode-thumbs">
      {MODES.map((m) => (
        <button key={m.id} data-testid={'thumb-' + m.id} onClick={() => onPick(m.id)} className="pressable flex flex-col items-center gap-1.5">
          <div className={cx('w-full aspect-[3/4] rounded-xl overflow-hidden bg-white/10 border-2 flex items-center justify-center', page.mode === m.id ? 'border-lime' : 'border-transparent')}>
            {thumbs[m.id] ? <BitmapCanvas bitmap={thumbs[m.id]!} className="w-full h-full object-cover" /> : <Spinner size={14} className="text-white/40" />}
          </div>
          <span className={cx('text-[11px] leading-tight text-center', page.mode === m.id ? 'text-lime font-semibold' : 'text-white/75')}>{m.label}</span>
        </button>
      ))}
    </div>
  );
}
