import { useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { Page } from '../lib/types';
import { Thumb, cx } from './ui';
import { haptic } from '../lib/haptics';

/** Horizontal page tray with drag-to-reorder (mouse drag or touch long-press). */
export default function PageStrip({ pages, current, onSelect, onReorder, onDelete, onAdd, dirtyIds }: {
  pages: Page[]; current: number; onSelect: (i: number) => void; onReorder: (from: number, to: number) => void;
  onDelete: (i: number) => void; onAdd: () => void; dirtyIds: Set<string>;
}) {
  const [drag, setDrag] = useState<{ from: number; to: number; dx: number } | null>(null);
  const st = useRef<{ x: number; y: number; id: number; t: number; active: boolean; timer?: number; from: number } | null>(null);
  const refs = useRef<(HTMLDivElement | null)[]>([]);

  const indexAt = (x: number) => {
    let idx = pages.length - 1;
    for (let i = 0; i < refs.current.length; i++) {
      const r = refs.current[i]?.getBoundingClientRect();
      if (r && x < r.left + r.width / 2) { idx = i; break; }
    }
    return idx;
  };

  const down = (i: number) => (e: React.PointerEvent) => {
    const touch = e.pointerType !== 'mouse';
    st.current = { x: e.clientX, y: e.clientY, id: e.pointerId, t: Date.now(), active: false, from: i };
    if (touch) {
      st.current.timer = window.setTimeout(() => {
        if (!st.current) return;
        st.current.active = true;
        haptic('tap');
        setDrag({ from: i, to: i, dx: 0 });
      }, 260);
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    const s = st.current;
    if (!s) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (!s.active) {
      if (e.pointerType === 'mouse' && Math.abs(dx) > 6) { s.active = true; setDrag({ from: s.from, to: s.from, dx }); }
      else if (Math.hypot(dx, dy) > 10) { clearTimeout(s.timer); st.current = null; }
      return;
    }
    e.preventDefault();
    setDrag({ from: s.from, to: indexAt(e.clientX), dx });
  };
  const up = (i: number) => () => {
    const s = st.current;
    st.current = null;
    if (!s) return;
    clearTimeout(s.timer);
    if (s.active && drag) {
      if (drag.to !== drag.from) { onReorder(drag.from, drag.to); haptic('success'); }
      setDrag(null);
    } else {
      onSelect(i);
    }
  };

  return (
    <div className="flex items-center gap-2 overflow-x-auto no-scrollbar px-3 py-2" data-testid="page-strip">
      {pages.map((p, i) => {
        let shift = 0;
        if (drag && i !== drag.from) {
          if (drag.from < drag.to && i > drag.from && i <= drag.to) shift = -1;
          if (drag.from > drag.to && i < drag.from && i >= drag.to) shift = 1;
        }
        const dragging = drag?.from === i;
        return (
          <div
            key={p.id}
            ref={(el) => (refs.current[i] = el)}
            data-testid="strip-page"
            onPointerDown={down(i)} onPointerMove={move} onPointerUp={up(i)} onPointerCancel={() => { st.current = null; setDrag(null); }}
            onContextMenu={(e) => e.preventDefault()}
            className={cx('relative shrink-0 h-[68px] w-[50px] rounded-lg overflow-hidden bg-white/10 cursor-pointer select-none touch-pan-x border-2 transition-[border-color,box-shadow]',
              i === current ? 'border-lime shadow-lime' : 'border-transparent', dragging && 'z-10 scale-110 shadow-2xl')}
            style={{ transform: dragging ? `translateX(${drag!.dx}px) scale(1.1)` : `translateX(${shift * 58}px)`, transition: dragging ? 'none' : 'transform .2s' }}
          >
            <Thumb k={p.thumbKey} className={cx('h-full w-full object-cover pointer-events-none', dirtyIds.has(p.id) && 'opacity-70')} />
            <span className="absolute bottom-0 left-0 text-[10px] bg-black/70 text-white px-1 rounded-tr">{i + 1}</span>
            {i === current && pages.length > 1 && (
              <button aria-label={`ลบหน้า ${i + 1}`} data-testid="strip-delete" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onDelete(i); }}
                className="absolute top-0 right-0 h-6 w-6 flex items-center justify-center bg-black/70 text-white rounded-bl-lg"><X size={13} /></button>
            )}
          </div>
        );
      })}
      <button data-testid="strip-add" aria-label="เพิ่มหน้า" onClick={onAdd} className="pressable shrink-0 h-[68px] w-[50px] rounded-lg border-2 border-dashed border-white/25 text-white/70 flex flex-col items-center justify-center text-[10px] gap-0.5 hover:border-lime hover:text-lime">
        <Plus size={18} /> เพิ่ม
      </button>
    </div>
  );
}
