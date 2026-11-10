import { useEffect, useRef, useState } from 'react';
import { Check, Pencil } from 'lucide-react';
import type { Doc } from '../lib/types';
import { renameDoc } from '../lib/docs';
import { thaiDate } from '../lib/util';
import { cx, Thumb } from './ui';
import { haptic } from '../lib/haptics';

export function InlineName({ doc, className, editing, setEditing }: { doc: Doc; className?: string; editing: boolean; setEditing: (v: boolean) => void }) {
  const [v, setV] = useState(doc.name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) { setV(doc.name); setTimeout(() => ref.current?.select(), 0); } }, [editing, doc.name]);
  const commit = () => { setEditing(false); if (v.trim() && v.trim() !== doc.name) renameDoc(doc.id, v); };
  if (!editing) return <span className={cx('truncate', className)} title={doc.name}>{doc.name}</span>;
  return (
    <input
      ref={ref}
      data-testid="rename-input"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
      className={cx('w-full min-w-0 rounded-lg border border-lime-500 px-1.5 py-0.5 outline-none bg-white', className)}
      maxLength={80}
      autoFocus
    />
  );
}

export default function DocCard({ doc, selected, selectable, onToggle, onOpen, onLongPress }: {
  doc: Doc; selected?: boolean; selectable?: boolean; onToggle?: () => void; onOpen: () => void; onLongPress?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const timer = useRef<number>();
  const longFired = useRef(false);
  const first = doc.pages[0];
  const start = () => {
    longFired.current = false;
    if (!onLongPress) return;
    timer.current = window.setTimeout(() => { longFired.current = true; haptic('tap'); onLongPress(); }, 480);
  };
  const cancel = () => clearTimeout(timer.current);
  return (
    <div
      data-testid="doc-card"
      data-name={doc.name}
      className={cx('group relative text-left rounded-2xl p-2 -m-2 transition', selected && 'bg-lime-50')}
    >
      <button
        className={cx('pressable relative block w-full aspect-[3/4] rounded-xl bg-white overflow-hidden paper-shadow border-2 transition', selected ? 'border-lime-500' : 'border-transparent')}
        onPointerDown={start} onPointerUp={cancel} onPointerLeave={cancel} onContextMenu={(e) => onLongPress && e.preventDefault()}
        onClick={() => { if (longFired.current) return; selectable ? onToggle?.() : onOpen(); }}
        aria-label={'เปิด ' + doc.name}
      >
        <Thumb k={first?.thumbKey} className="absolute inset-0 w-full h-full object-cover object-top" alt={doc.name} />
        {doc.pages.length > 1 && (
          <span className="absolute bottom-1.5 right-1.5 rounded-full bg-ink-900/80 text-white text-[11px] px-2 py-0.5">{doc.pages.length} หน้า</span>
        )}
      </button>
      {onToggle && (
        <button
          data-testid="doc-select"
          aria-label={selected ? 'ยกเลิกการเลือก' : 'เลือก'}
          onClick={(e) => { e.stopPropagation(); haptic('tap'); onToggle(); }}
          className={cx('absolute top-0 right-0 h-11 w-11 flex items-center justify-center', !selected && !selectable && 'md:opacity-0 md:group-hover:opacity-100 transition-opacity')}
        >
          <span className={cx('h-7 w-7 rounded-full flex items-center justify-center border-2 transition', selected ? 'bg-lime-500 border-lime-500 text-white animate-pop' : 'bg-white/90 border-ink/25')}>
            {selected && <Check size={16} strokeWidth={3} />}
          </span>
        </button>
      )}
      <div className="mt-2 px-0.5 flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium leading-5 flex" onDoubleClick={() => setEditing(true)}>
            <InlineName doc={doc} editing={editing} setEditing={setEditing} className="block" />
          </div>
          <div className="text-[11px] text-ink/50">{thaiDate(doc.updatedAt)}</div>
        </div>
        {!editing && (
          <button data-testid="rename-btn" aria-label="เปลี่ยนชื่อ" onClick={() => setEditing(true)} className="h-8 w-8 -mr-1 shrink-0 flex items-center justify-center rounded-lg text-ink/40 hover:text-ink hover:bg-ink/5 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100">
            <Pencil size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
