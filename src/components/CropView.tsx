import { useEffect, useRef, useState } from 'react';
import { Maximize, ScanLine, Wand2 } from 'lucide-react';
import type { Pt, Quad } from '../lib/types';
import { blobUrl, getBlob } from '../lib/docs';
import { detectDocument, downscale } from '../lib/engine';
import { straightMids } from '../lib/pages';
import { Button, Spinner, cx } from './ui';
import { haptic } from '../lib/haptics';
import { toast } from '../lib/toast';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export default function CropView({ srcKey, corners, mids, onCancel, onApply }: {
  srcKey: string; corners: Quad; mids: Quad | null; onCancel: () => void; onApply: (q: Quad, m: Quad | null) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [q, setQ] = useState<Quad>(corners);
  const [m, setM] = useState<Quad | null>(mids);
  const [rect, setRect] = useState<{ w: number; h: number } | null>(null);
  const [drag, setDrag] = useState<{ kind: 'c' | 'm'; i: number; p: Pt } | null>(null);
  const [detecting, setDetecting] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => { blobUrl(srcKey).then(setUrl); }, [srcKey]);

  // fit image inside wrapper (contain), track its rendered size
  useEffect(() => {
    const upd = () => {
      const img = imgRef.current, w = wrapRef.current;
      if (!img || !w || !img.naturalWidth) return;
      const pad = 28;
      const k = Math.min((w.clientWidth - pad * 2) / img.naturalWidth, (w.clientHeight - pad * 2) / img.naturalHeight);
      setRect({ w: img.naturalWidth * k, h: img.naturalHeight * k });
    };
    const ro = new ResizeObserver(upd);
    wrapRef.current && ro.observe(wrapRef.current);
    imgRef.current?.addEventListener('load', upd);
    upd();
    return () => ro.disconnect();
  }, [url]);

  const mids4 = m ?? straightMids(q);
  const toPx = (p: Pt) => ({ x: p.x * (rect?.w || 0), y: p.y * (rect?.h || 0) });

  const pointerToNorm = (e: React.PointerEvent | PointerEvent): Pt => {
    const r = imgRef.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };

  const onDown = (kind: 'c' | 'm', i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    haptic('tap');
    setDrag({ kind, i, p: kind === 'c' ? q[i] : mids4[i] });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = pointerToNorm(e);
    if (drag.kind === 'c') {
      const i = drag.i;
      const old = q[i];
      const nq = q.map((c, k) => (k === i ? p : c)) as Quad;
      if (m) {
        // edges adjacent to the corner: i is start of edge i, end of edge i-1
        const dx = p.x - old.x, dy = p.y - old.y;
        const nm = m.map((mm, k) => (k === i || k === (i + 3) % 4 ? { x: clamp01(mm.x + dx / 2), y: clamp01(mm.y + dy / 2) } : mm)) as Quad;
        setM(nm);
      }
      setQ(nq);
    } else {
      const nm = (m ?? straightMids(q)).map((mm, k) => (k === drag.i ? p : mm)) as Quad;
      setM(nm);
    }
    setDrag({ ...drag, p });
    drawLoupe(p);
  };
  const onUp = () => setDrag(null);

  const drawLoupe = (p: Pt) => {
    const c = loupeRef.current, img = imgRef.current;
    if (!c || !img) return;
    const ctx = c.getContext('2d')!;
    const S = c.width, zoomSrc = Math.max(img.naturalWidth, img.naturalHeight) * 0.06;
    const sx = p.x * img.naturalWidth - zoomSrc / 2, sy = p.y * img.naturalHeight - zoomSrc / 2;
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, S, S);
    ctx.drawImage(img, sx, sy, zoomSrc, zoomSrc, 0, 0, S, S);
    ctx.strokeStyle = '#8ee04a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(S / 2, S / 2 - 14); ctx.lineTo(S / 2, S / 2 + 14);
    ctx.moveTo(S / 2 - 14, S / 2); ctx.lineTo(S / 2 + 14, S / 2);
    ctx.stroke();
  };

  const auto = async () => {
    setDetecting(true);
    try {
      const b = await getBlob(srcKey);
      const { small } = await downscale(b!, 640);
      const d = await detectDocument(small);
      if (d.found && d.corners) {
        setQ(d.corners);
        setM(d.curved && d.mids ? d.mids : null);
        haptic('success');
        toast(d.curved ? 'ตรวจพบขอบเอกสาร (หน้าโค้ง) แล้ว' : 'ตรวจพบขอบเอกสารแล้ว', { kind: 'success' });
      } else {
        haptic('warn');
        toast('ไม่พบขอบเอกสาร ลองลากมุมด้วยตนเอง', { kind: 'error' });
      }
    } finally {
      setDetecting(false);
    }
  };

  const full: Quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const qp = q.map(toPx), mp = mids4.map(toPx);
  const path = rect
    ? `M${qp[0].x},${qp[0].y} Q${2 * mp[0].x - (qp[0].x + qp[1].x) / 2},${2 * mp[0].y - (qp[0].y + qp[1].y) / 2} ${qp[1].x},${qp[1].y}` +
      ` Q${2 * mp[1].x - (qp[1].x + qp[2].x) / 2},${2 * mp[1].y - (qp[1].y + qp[2].y) / 2} ${qp[2].x},${qp[2].y}` +
      ` Q${2 * mp[2].x - (qp[2].x + qp[3].x) / 2},${2 * mp[2].y - (qp[2].y + qp[3].y) / 2} ${qp[3].x},${qp[3].y}` +
      ` Q${2 * mp[3].x - (qp[3].x + qp[0].x) / 2},${2 * mp[3].y - (qp[3].y + qp[0].y) / 2} ${qp[0].x},${qp[0].y} Z`
    : '';
  const loupeLeft = drag && drag.p.x < 0.5;

  return (
    <div className="absolute inset-0 flex flex-col bg-ink-900 z-20" data-testid="crop-view">
      <div ref={wrapRef} className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden touch-none" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {!url && <Spinner className="text-white/50" size={28} />}
        {url && (
          <div className="relative" style={{ width: rect?.w, height: rect?.h }}>
            <img ref={imgRef} src={url} className="absolute inset-0 w-full h-full select-none" draggable={false} alt="" />
            {rect && (
              <svg className="absolute overflow-visible" width={rect.w + 60} height={rect.h + 60} style={{ left: -30, top: -30 }}>
                <g transform="translate(30 30)">
                  <path d={`M-30,-30 H${rect.w + 30} V${rect.h + 30} H-30 Z ${path}`} fill="rgba(0,0,0,.5)" fillRule="evenodd" />
                  <path d={path} fill="none" stroke="#8ee04a" strokeWidth="2.5" data-testid="crop-path" />
                  {mp.map((p, i) => (
                    <g key={'m' + i} onPointerDown={onDown('m', i)} className="cursor-grab" data-testid={'crop-mid-' + i}>
                      <circle cx={p.x} cy={p.y} r="24" fill="transparent" />
                      <rect x={p.x - 9} y={p.y - 9} width="18" height="18" rx="5" fill={m ? '#8ee04a' : '#fff'} stroke="#1c1f22" strokeWidth="1.5" opacity=".95" />
                    </g>
                  ))}
                  {qp.map((p, i) => (
                    <g key={'c' + i} onPointerDown={onDown('c', i)} className="cursor-grab" data-testid={'crop-corner-' + i}>
                      <circle cx={p.x} cy={p.y} r="28" fill="transparent" />
                      <circle cx={p.x} cy={p.y} r={drag?.kind === 'c' && drag.i === i ? 16 : 13} fill="rgba(142,224,74,.35)" stroke="#8ee04a" strokeWidth="3" />
                      <circle cx={p.x} cy={p.y} r="4" fill="#fff" />
                    </g>
                  ))}
                </g>
              </svg>
            )}
          </div>
        )}
        <canvas ref={loupeRef} width={140} height={140} className={cx('absolute top-3 h-[120px] w-[120px] rounded-full border-4 border-lime shadow-2xl pointer-events-none transition-opacity', drag ? 'opacity-100' : 'opacity-0', loupeLeft ? 'right-3' : 'left-3')} />
      </div>
      <div className="bg-ink-800 text-white px-3 pt-3 pb-safe">
        <div className="text-center text-xs text-white/55 mb-2">ลากจุดมุมเพื่อครอบตัด · ลากจุดกลางขอบเพื่อคลี่หน้ากระดาษที่โค้ง</div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant="dark" size="sm" className="bg-white/10" onClick={auto} data-testid="crop-auto" disabled={detecting}>{detecting ? <Spinner size={14} /> : <Wand2 size={16} />} ตรวจจับอัตโนมัติ</Button>
          <Button variant="dark" size="sm" className="bg-white/10" onClick={() => { setQ(full); setM(null); }} data-testid="crop-full"><Maximize size={16} /> ทั้งภาพ</Button>
          {m && <Button variant="dark" size="sm" className="bg-white/10" onClick={() => setM(null)} data-testid="crop-straight"><ScanLine size={16} /> ขอบตรง</Button>}
          <span className="hidden sm:block flex-1" />
          <Button variant="ghost" size="sm" className="text-white hover:bg-white/10" onClick={onCancel} data-testid="crop-cancel">ยกเลิก</Button>
          <Button variant="lime" size="sm" className="px-5" onClick={() => onApply(q, m)} data-testid="crop-apply">ตกลง</Button>
        </div>
      </div>
    </div>
  );
}
