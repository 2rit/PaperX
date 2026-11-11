import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Camera as CamIcon, Check, FileText, Image as ImageIcon, RefreshCw, X, Zap, ZapOff } from 'lucide-react';
import { detectDocument, paperLabel, warmupDetector, detectorState, type Detection } from '../lib/engine';
import { importFiles, pageFromBlob, renderPage, splitBook } from '../lib/pages';
import { createDocFromPages, pickFiles } from '../lib/actions';
import { getDoc, pendingKeys, saveDoc } from '../lib/docs';
import { navigate, back } from '../lib/router';
import { setSettings, useSettings } from '../lib/settings';
import { haptic } from '../lib/haptics';
import { toast } from '../lib/toast';
import { setBusy } from '../lib/busy';
import type { Page, Pt, Quad } from '../lib/types';
import { cx, Sheet, Button, Spinner, Thumb } from '../components/ui';

type TrayItem = { id: string; status: 'processing' | 'ready' | 'error'; page?: Page; pages?: Page[]; preview: string; book?: boolean };
type CamState = 'starting' | 'live' | 'denied' | 'unavailable';

const STABLE_MS = 800;
const MOVE_TOL = 0.012;

export default function CameraScreen({ docId }: { docId?: string }) {
  const s = useSettings();
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cam, setCam] = useState<CamState>('starting');
  const [errMsg, setErrMsg] = useState('');
  const [torch, setTorch] = useState<boolean | null>(null); // null = unsupported
  const [det, setDet] = useState<Detection | null>(null);
  const [stableP, setStableP] = useState(0);
  const [flash, setFlash] = useState(0);
  const [tray, setTray] = useState<TrayItem[]>([]);
  const [confirmClose, setConfirmClose] = useState(false);
  const [cvReady, setCvReady] = useState(detectorState() === 'ready');
  const [dims, setDims] = useState({ vw: 0, vh: 0, cw: 0, ch: 0 });
  const trayRef = useRef<TrayItem[]>([]);
  trayRef.current = tray;
  const procQueue = useRef<Promise<void>>(Promise.resolve());
  const lastQuad = useRef<Quad | null>(null);
  const lastMids = useRef<Quad | null>(null);
  const stableSince = useRef(0);
  const armed = useRef(true);
  const capturing = useRef(false);
  const lostSince = useRef(0);
  const autoRef = useRef(s.autoCapture);
  autoRef.current = s.autoCapture;
  const bookRef = useRef(s.captureMode === 'book');
  bookRef.current = s.captureMode === 'book';

  // ---------- camera lifecycle ----------
  const stop = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };
  const start = useCallback(async () => {
    setCam('starting');
    stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      setCam('unavailable');
      setErrMsg(window.isSecureContext ? 'อุปกรณ์หรือเบราว์เซอร์นี้ไม่รองรับกล้อง' : 'ต้องเปิดผ่าน HTTPS เพื่อใช้กล้อง');
      return;
    }
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } },
        });
      } catch (e: any) {
        if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') throw e;
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      }
      streamRef.current = stream;
      const v = videoRef.current!;
      v.srcObject = stream;
      v.muted = true;
      v.setAttribute('playsinline', '');
      await v.play().catch(() => {});
      const track = stream.getVideoTracks()[0];
      const caps: any = track.getCapabilities?.() || {};
      setTorch(caps.torch ? false : null);
      setCam('live');
    } catch (e: any) {
      console.warn('camera error', e);
      const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
      setCam(denied ? 'denied' : 'unavailable');
      setErrMsg(denied ? 'ไม่ได้รับอนุญาตให้ใช้กล้อง กรุณาอนุญาตในการตั้งค่าเบราว์เซอร์' : 'ไม่พบกล้องบนอุปกรณ์นี้');
    }
  }, []);

  useEffect(() => {
    warmupDetector();
    start();
    const vis = () => { if (document.hidden) stop(); else if (!streamRef.current) start(); };
    document.addEventListener('visibilitychange', vis);
    return () => { document.removeEventListener('visibilitychange', vis); stop(); };
  }, [start]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || torch === null) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch } as any] });
      setTorch(!torch);
    } catch {
      setTorch(null);
      toast('อุปกรณ์นี้ไม่รองรับไฟแฟลช', { kind: 'error' });
    }
  };

  // ---------- layout mapping ----------
  useEffect(() => {
    const upd = () => {
      const v = videoRef.current, b = boxRef.current;
      if (!v || !b) return;
      setDims({ vw: v.videoWidth, vh: v.videoHeight, cw: b.clientWidth, ch: b.clientHeight });
    };
    const ro = new ResizeObserver(upd);
    if (boxRef.current) ro.observe(boxRef.current);
    const v = videoRef.current;
    v?.addEventListener('loadedmetadata', upd);
    v?.addEventListener('resize', upd);
    return () => { ro.disconnect(); v?.removeEventListener('loadedmetadata', upd); v?.removeEventListener('resize', upd); };
  }, []);
  const map = (p: Pt) => {
    const { vw, vh, cw, ch } = dims;
    if (!vw) return { x: 0, y: 0 };
    const k = Math.max(cw / vw, ch / vh);
    return { x: (p.x * vw) * k + (cw - vw * k) / 2, y: (p.y * vh) * k + (ch - vh * k) / 2 };
  };

  // ---------- detection loop ----------
  useEffect(() => {
    if (cam !== 'live') return;
    let alive = true;
    const small = document.createElement('canvas');
    const ctx = small.getContext('2d', { willReadFrequently: true })!;
    const loop = async () => {
      while (alive) {
        const v = videoRef.current;
        if (!v || !v.videoWidth || document.hidden || capturing.current) { await new Promise((r) => setTimeout(r, 120)); continue; }
        const k = 400 / Math.max(v.videoWidth, v.videoHeight);
        small.width = Math.round(v.videoWidth * k);
        small.height = Math.round(v.videoHeight * k);
        ctx.drawImage(v, 0, 0, small.width, small.height);
        const img = ctx.getImageData(0, 0, small.width, small.height);
        const d = await detectDocument(img);
        if (!alive) break;
        setCvReady(detectorState() === 'ready');
        onDetection(d);
        await new Promise((r) => setTimeout(r, 60));
      }
    };
    loop();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cam]);

  const onDetection = (d: Detection) => {
    const now = performance.now();
    const ok = d.found && d.corners && (d.areaRatio ?? 0) > 0.15;
    if (!ok) {
      if (!lostSince.current) lostSince.current = now;
      if (now - lostSince.current > 400) { setDet(null); lastQuad.current = null; lastMids.current = null; armed.current = true; }
      stableSince.current = 0;
      setStableP(0);
      return;
    }
    lostSince.current = 0;
    const q = d.corners!;
    const prev = lastQuad.current;
    const move = prev ? Math.max(...q.map((p, i) => Math.hypot(p.x - prev[i].x, p.y - prev[i].y))) : 1;
    // One-euro-style: nearly still frames are heavily smoothed so the overlay does not jitter;
    // a real movement snaps instead of lagging behind the page.
    const alpha = !prev || move > 0.05 ? 1 : move > 0.02 ? 0.62 : 0.28;
    const mix = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: a.x * (1 - alpha) + b.x * alpha, y: a.y * (1 - alpha) + b.y * alpha });
    const sm = (prev && alpha < 1 ? q.map((p, i) => mix(prev[i], p)) : q) as Quad;
    const pm = lastMids.current;
    const mids = d.mids ? (pm && alpha < 1 ? d.mids.map((p, i) => mix(pm[i], p)) as Quad : d.mids) : null;
    lastQuad.current = sm;
    lastMids.current = mids;
    setDet({ ...d, corners: sm, mids: mids ?? undefined });
    if (!armed.current) {
      if (move > 0.08) armed.current = true; // page changed / moved → allow next auto capture
      stableSince.current = 0;
      setStableP(0);
      return;
    }
    if (move < MOVE_TOL) {
      if (!stableSince.current) stableSince.current = now;
      const p = Math.min(1, (now - stableSince.current) / STABLE_MS);
      setStableP(p);
      if (p >= 1 && autoRef.current && !capturing.current) capture('auto');
    } else {
      stableSince.current = 0;
      setStableP(0);
    }
  };

  // ---------- capture ----------
  const enqueue = (item: TrayItem, work: () => Promise<Page>) => {
    const book = bookRef.current; // mode at shutter time
    setTray((t) => [...t, { ...item, book }]);
    procQueue.current = procQueue.current.then(async () => {
      try {
        const base = await work();
        const parts = book ? await splitBook(base) : [base];
        const pages: Page[] = [];
        for (const p of parts) pages.push(await renderPage(p));
        setTray((t) => t.map((x) => (x.id === item.id ? { ...x, status: 'ready', page: pages[0], pages } : x)));
      } catch (e) {
        console.error(e);
        setTray((t) => t.map((x) => (x.id === item.id ? { ...x, status: 'error' } : x)));
        toast('ประมวลผลภาพไม่สำเร็จ', { kind: 'error' });
      }
    });
  };

  const capture = async (why: 'auto' | 'manual') => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || capturing.current) return;
    capturing.current = true;
    try {
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d')!.drawImage(v, 0, 0);
      setFlash((f) => f + 1);
      haptic('capture');
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.93));
      const pk = 220 / Math.max(c.width, c.height);
      const pc = document.createElement('canvas');
      pc.width = Math.round(c.width * pk); pc.height = Math.round(c.height * pk);
      pc.getContext('2d')!.drawImage(c, 0, 0, pc.width, pc.height);
      const preview = pc.toDataURL('image/jpeg', 0.7);
      c.width = c.height = 0;
      const corners = det?.found ? det.corners : undefined;
      const mids = det?.found && s.dewarp && det.curved ? det.mids : null;
      armed.current = false;
      stableSince.current = 0;
      setStableP(0);
      const track = streamRef.current?.getVideoTracks()[0];
      const frameRatio = v.videoWidth / v.videoHeight;
      const hiRes = highResPhoto(track, frameRatio); // start immediately, at shutter time
      enqueue({ id: Math.random().toString(36).slice(2), status: 'processing', preview }, async () => {
        const src = (await hiRes) || blob;
        if (!s.autoCrop) return pageFromBlob(src, { flat: false });
        // re-detect on the full-resolution frame for precise corners; fall back to the live overlay quad
        const p = await pageFromBlob(src);
        const full = p.corners.every((c, i) => Math.abs(c.x - [0, 1, 1, 0][i]) < 1e-6 && Math.abs(c.y - [0, 0, 1, 1][i]) < 1e-6);
        return full && corners ? { ...p, corners, mids: mids ?? null } : p;
      });
      if (why === 'auto') toast(bookRef.current ? 'ถ่ายอัตโนมัติแล้ว · แยกเป็น 2 หน้า · พลิกหน้าถัดไปได้เลย' : 'ถ่ายอัตโนมัติแล้ว · พลิกหน้าถัดไปได้เลย', { ms: 1600 });
    } finally {
      setTimeout(() => (capturing.current = false), 350);
    }
  };

  const fromGallery = async () => {
    const files = await pickFiles();
    if (!files.length) return;
    setBusy({ label: 'กำลังนำเข้า…' });
    try {
      const { pages, failed } = await importFiles(files);
      if (failed.length) toast(`เปิดไฟล์ไม่ได้: ${failed.join(', ')}`, { kind: 'error' });
      for (const p of pages) enqueue({ id: p.id, status: 'processing', preview: '' }, async () => p);
    } finally {
      setBusy(null);
    }
  };

  const fromCameraApp = async () => {
    const files = await pickFiles({ capture: true });
    for (const f of files) enqueue({ id: Math.random().toString(36).slice(2), status: 'processing', preview: URL.createObjectURL(f) }, () => pageFromBlob(f));
  };

  const removeItem = (id: string) => {
    haptic('tap');
    setTray((t) => t.filter((x) => x.id !== id));
  };

  const finish = async () => {
    if (!trayRef.current.length) return;
    setBusy({ label: 'กำลังสร้างเอกสาร…' });
    try {
      await procQueue.current;
      const pages = trayRef.current.filter((x) => x.status === 'ready' && x.page).flatMap((x) => x.pages || [x.page!]);
      if (!pages.length) { toast('ไม่มีหน้าที่พร้อมใช้งาน', { kind: 'error' }); return; }
      stop();
      let id: string;
      const existing = docId ? getDoc(docId) : undefined;
      if (existing) {
        pages.forEach((p) => [p.srcKey, p.outKey, p.thumbKey].forEach((k) => k && pendingKeys.delete(k)));
        await saveDoc({ ...existing, pages: [...existing.pages, ...pages], updatedAt: Date.now() });
        id = existing.id;
      } else {
        id = (await createDocFromPages(pages)).id;
      }
      haptic('success');
      navigate(`editor/${id}`, true);
    } finally {
      setBusy(null);
    }
  };

  const close = () => {
    if (tray.length) setConfirmClose(true);
    else { stop(); back(docId ? `editor/${docId}` : 'home'); }
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); capture('manual'); }
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  // ---------- render ----------
  const found = !!det?.found;
  const stable = found && stableP > 0.35;
  const q = det?.corners?.map(map);
  const qm = det?.mids?.map(map);
  const readyCount = tray.filter((t) => t.status === 'ready').length;
  const pageCount = tray.reduce((n, t) => n + (t.book ? 2 : 1), 0);

  return (
    <div className="fixed inset-0 bg-black text-white flex flex-col select-none" data-testid="camera">
      {/* top bar */}
      <div className="relative z-20 flex items-center justify-between px-3 pt-safe">
        <div className="h-16 flex items-center w-24">
          {torch !== null && (
            <button data-testid="cam-torch" aria-label="แฟลช" onClick={toggleTorch} className={cx('pressable h-12 w-12 rounded-full flex items-center justify-center', torch ? 'bg-lime text-ink-900' : 'bg-white/10')}>
              {torch ? <Zap size={22} /> : <ZapOff size={22} />}
            </button>
          )}
        </div>
        <div data-testid="cam-status" className={cx('px-4 h-9 rounded-full flex items-center gap-2 text-sm backdrop-blur transition-colors', found ? 'bg-black/55' : 'bg-black/40 text-white/80')}>
          <span className={cx('h-2.5 w-2.5 rounded-full', found ? 'bg-lime animate-pulseRing' : 'bg-white/40')} />
          {cam !== 'live' ? 'กล้อง' : !cvReady && !found ? 'กำลังเตรียมระบบตรวจจับ…' : found ? (s.captureMode === 'book' ? 'ตรวจพบหนังสือ · 2 หน้า' : paperLabel(det?.ratio)) : s.captureMode === 'book' ? 'กำลังค้นหาหนังสือ…' : 'กำลังค้นหาเอกสาร…'}
        </div>
        <div className="h-16 w-24 flex items-center justify-end">
          <button data-testid="cam-close" aria-label="ปิดกล้อง" onClick={close} className="pressable h-12 w-12 rounded-full bg-white/10 flex items-center justify-center"><X size={24} /></button>
        </div>
      </div>

      {/* viewfinder */}
      <div ref={boxRef} className="relative flex-1 min-h-0 overflow-hidden -mt-16">
        <video ref={videoRef} playsInline muted autoPlay className="absolute inset-0 w-full h-full object-cover" data-testid="cam-video" />
        {cam === 'live' && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none" data-testid="cam-overlay">
            {!found && <FrameGuides w={dims.cw} h={dims.ch} />}
            {q && (
              <g className="transition-all">
                <path d={overlayPath(q, qm)} fill="rgba(142,224,74,0.14)" stroke="#8ee04a" strokeWidth="2.5" strokeLinejoin="round" data-testid="cam-quad" />
                {s.captureMode === 'book' && <line data-testid="cam-spine" x1={(q[0].x + q[1].x) / 2} y1={(q[0].y + q[1].y) / 2} x2={(q[3].x + q[2].x) / 2} y2={(q[3].y + q[2].y) / 2} stroke="#8ee04a" strokeWidth="2" strokeDasharray="8 7" />}
                {q.map((p, i) => {
                  const a = q[(i + 1) % 4], b = q[(i + 3) % 4];
                  const L = 26;
                  const ua = norm(a.x - p.x, a.y - p.y), ub = norm(b.x - p.x, b.y - p.y);
                  return <path key={i} d={`M${p.x + ua.x * L},${p.y + ua.y * L} L${p.x},${p.y} L${p.x + ub.x * L},${p.y + ub.y * L}`} stroke="#8ee04a" strokeWidth="6" fill="none" strokeLinecap="round" strokeLinejoin="round" />;
                })}
              </g>
            )}
          </svg>
        )}
        {flash > 0 && <div key={flash} className="absolute inset-0 bg-white animate-flash pointer-events-none" />}
        {cam === 'live' && (
          <div className="absolute inset-x-0 bottom-4 flex justify-center pointer-events-none" data-testid="cam-hint">
            <div className={cx('flex items-center gap-2.5 rounded-2xl px-4 py-2 text-sm backdrop-blur transition-all', found ? 'bg-black/60' : 'bg-black/40')}>
              {found ? <span className="h-6 w-6 rounded-full bg-lime text-ink-900 flex items-center justify-center"><Check size={15} strokeWidth={3} /></span> : <Spinner size={16} className="text-white/60" />}
              <span className="leading-tight">
                {found ? (
                  s.autoCapture ? (stable ? <>ถือนิ่งๆ ไว้<br /><span className="text-white/70 text-xs">กำลังถ่ายอัตโนมัติ…</span></> : <>เอกสารอยู่ในกรอบแล้ว<br /><span className="text-white/70 text-xs">ถือนิ่งเพื่อถ่ายอัตโนมัติ หรือกดถ่ายได้เลย</span></>)
                    : <>เอกสารอยู่ในกรอบแล้ว<br /><span className="text-white/70 text-xs">กดถ่ายภาพได้เลย</span></>
                ) : <>วางเอกสารให้อยู่ในกรอบ<br /><span className="text-white/70 text-xs">วางบนพื้นสีเข้ม แสงสว่างเพียงพอ</span></>}
              </span>
            </div>
          </div>
        )}
        {cam !== 'live' && (
          <div className="absolute inset-0 flex items-center justify-center p-6" data-testid="cam-fallback">
            {cam === 'starting' ? (
              <div className="text-center text-white/70"><Spinner size={34} className="mb-3" /><div>กำลังเปิดกล้อง…</div></div>
            ) : (
              <div className="max-w-sm text-center bg-white/5 rounded-3xl p-6">
                <div className="mx-auto h-16 w-16 rounded-2xl bg-white/10 flex items-center justify-center mb-4"><CamIcon size={30} /></div>
                <div className="font-semibold text-lg mb-1">ใช้กล้องสดไม่ได้</div>
                <div className="text-white/60 text-sm mb-5" data-testid="cam-error">{errMsg}</div>
                <div className="flex flex-col gap-2.5">
                  <Button variant="lime" onClick={fromCameraApp} data-testid="cam-native">ถ่ายภาพด้วยแอปกล้อง</Button>
                  <Button variant="dark" onClick={fromGallery} className="bg-white/10">เลือกจากแกลเลอรี</Button>
                  <Button variant="ghost" onClick={start} className="text-white/80 hover:bg-white/10" data-testid="cam-retry"><RefreshCw size={16} /> ลองเปิดกล้องอีกครั้ง</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* tray */}
      {tray.length > 0 && (
        <div className="relative z-10 bg-black/80 px-3 pt-2" data-testid="tray">
          <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
            {tray.map((t, i) => (
              <div key={t.id} className="relative shrink-0 h-16 w-12 rounded-md overflow-hidden bg-white/10 animate-pop" data-testid="tray-item">
                {t.page?.thumbKey ? <Thumb k={t.page.thumbKey} className="h-full w-full object-cover" /> : t.preview ? <img src={t.preview} className="h-full w-full object-cover opacity-60" /> : null}
                {t.status === 'processing' && <div className="absolute inset-0 flex items-center justify-center bg-black/30"><Spinner size={16} /></div>}
                {t.status === 'error' && <div className="absolute inset-0 flex items-center justify-center bg-red-600/60 text-xs">ผิดพลาด</div>}
                <span className="absolute bottom-0 left-0 text-[10px] bg-black/60 px-1 rounded-tr">{i + 1}</span>
                {t.book && <span className="absolute top-0 left-0 text-[9px] bg-lime text-ink-900 font-bold px-1 rounded-br" data-testid="tray-book">2 หน้า</span>}
                <button aria-label={`ลบหน้า ${i + 1}`} data-testid="tray-remove" onClick={() => removeItem(t.id)} className="absolute -top-0 -right-0 h-6 w-6 flex items-center justify-center bg-black/60 rounded-bl-md"><X size={13} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* bottom controls */}
      <div className="relative z-10 bg-black px-4 pt-3 pb-safe">
        <div className="flex justify-center mb-3" role="radiogroup" aria-label="โหมดการสแกน">
          <div className="flex p-1 rounded-full bg-white/10 text-[13px]">
            {([['doc', 'เอกสาร', FileText], ['book', 'หนังสือ', BookOpen]] as const).map(([m, label, Icon]) => (
              <button key={m} role="radio" aria-checked={s.captureMode === m} data-testid={'cam-mode-' + m}
                onClick={() => { haptic('tap'); setSettings({ captureMode: m }); if (m === 'book') toast('โหมดหนังสือ: ถ่ายทีละ 2 หน้า ระบบแยกหน้าซ้าย/ขวาและคลี่หน้าโค้งให้อัตโนมัติ', { ms: 2600 }); }}
                className={cx('pressable h-9 px-4 rounded-full flex items-center gap-1.5 transition-colors', s.captureMode === m ? 'bg-lime text-ink-900 font-semibold' : 'text-white/80')}>
                <Icon size={15} />{label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between max-w-md mx-auto">
          <button data-testid="cam-gallery" onClick={fromGallery} className="pressable w-20 flex flex-col items-center gap-1 text-xs text-white/85">
            <span className="h-12 w-12 rounded-xl bg-white/10 flex items-center justify-center"><ImageIcon size={22} /></span>แกลเลอรี
          </button>
          <div className="flex flex-col items-center gap-2">
            <button data-testid="cam-shutter" aria-label="ถ่ายภาพ" disabled={cam !== 'live'} onClick={() => capture('manual')} className="pressable relative h-[78px] w-[78px] rounded-full disabled:opacity-40">
              <svg className="absolute inset-0 -rotate-90" viewBox="0 0 80 80">
                <circle cx="40" cy="40" r="36" stroke="rgba(255,255,255,.35)" strokeWidth="5" fill="none" />
                <circle cx="40" cy="40" r="36" stroke="#8ee04a" strokeWidth="5" fill="none" strokeDasharray={226} strokeDashoffset={226 * (1 - (s.autoCapture ? stableP : found ? 1 : 0))} style={{ transition: 'stroke-dashoffset .12s linear' }} />
              </svg>
              <span className={cx('absolute inset-[10px] rounded-full transition-colors', found ? 'bg-white' : 'bg-white/90')} />
            </button>
            <button data-testid="cam-auto" onClick={() => setSettings({ autoCapture: !s.autoCapture })} className={cx('pressable text-[11px] px-3 h-7 rounded-full', s.autoCapture ? 'bg-lime text-ink-900 font-semibold' : 'bg-white/10 text-white/80')}>
              {s.autoCapture ? 'ถ่ายอัตโนมัติ: เปิด' : 'ถ่ายอัตโนมัติ: ปิด'}
            </button>
          </div>
          {tray.length ? (
            <button data-testid="cam-done" onClick={finish} className="pressable w-20 flex flex-col items-center gap-1 text-xs">
              <span className="h-12 min-w-12 px-3 rounded-xl bg-lime text-ink-900 font-bold flex items-center justify-center gap-1"><Check size={18} strokeWidth={3} />{pageCount}</span>
              เสร็จสิ้น{readyCount < tray.length ? '…' : ''}
            </button>
          ) : (
            <button data-testid="cam-close2" onClick={close} className="pressable w-20 flex flex-col items-center gap-1 text-xs text-white/85">
              <span className="h-12 w-12 rounded-xl bg-white/10 flex items-center justify-center"><X size={22} /></span>ปิดกล้อง
            </button>
          )}
        </div>
      </div>

      <Sheet open={confirmClose} onClose={() => setConfirmClose(false)} title={`มี ${pageCount} หน้าที่ถ่ายไว้`} testId="cam-confirm">
        <p className="text-ink/65 mb-5">ต้องการบันทึกเป็นเอกสาร หรือทิ้งหน้าที่ถ่ายไว้?</p>
        <div className="flex gap-3 justify-end">
          <Button variant="danger" data-testid="cam-discard" onClick={() => { setConfirmClose(false); setTray([]); stop(); back('home'); }}>ทิ้ง</Button>
          <Button variant="lime" onClick={() => { setConfirmClose(false); finish(); }}>บันทึกเอกสาร</Button>
        </div>
      </Sheet>
    </div>
  );
}

function overlayPath(q: { x: number; y: number }[], mids?: { x: number; y: number }[] | null) {
  if (!mids) return `M${q.map((p) => `${p.x},${p.y}`).join('L')}Z`;
  let d = `M${q[0].x},${q[0].y}`;
  for (let i = 0; i < 4; i++) {
    const a = q[(i + 1) % 4], m = mids[i];
    d += ` Q${m.x},${m.y} ${a.x},${a.y}`;
  }
  return d + 'Z';
}

function norm(x: number, y: number) {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}

function FrameGuides({ w, h }: { w: number; h: number }) {
  if (!w) return null;
  const mw = w * 0.12, mh = h * 0.16, L = 34;
  const pts = [[mw, mh, 1, 1], [w - mw, mh, -1, 1], [w - mw, h - mh, -1, -1], [mw, h - mh, 1, -1]];
  return (
    <g stroke="rgba(142,224,74,.9)" strokeWidth="5" fill="none" strokeLinecap="round">
      {pts.map(([x, y, dx, dy], i) => <path key={i} d={`M${x},${y + dy * L} L${x},${y} L${x + dx * L},${y}`} />)}
    </g>
  );
}

/** Android Chrome: grab a full-sensor still via ImageCapture when its framing matches the preview. */
async function highResPhoto(track: MediaStreamTrack | undefined, ratio: number): Promise<Blob | null> {
  const IC = (window as any).ImageCapture;
  if (!IC || !track || track.readyState !== 'live') return null;
  try {
    const ic = new IC(track);
    const blob: Blob = await Promise.race([ic.takePhoto(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500))]);
    const bmp = await createImageBitmap(blob);
    const r = bmp.width / bmp.height;
    const big = Math.max(bmp.width, bmp.height);
    bmp.close();
    if (Math.abs(r - ratio) / ratio > 0.03 || big < 1000) return null;
    return blob;
  } catch {
    return null;
  }
}
