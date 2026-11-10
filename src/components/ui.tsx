import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { blobUrl } from '../lib/docs';
import { haptic } from '../lib/haptics';
import { X } from 'lucide-react';

export function cx(...a: (string | false | null | undefined)[]) {
  return a.filter(Boolean).join(' ');
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'lime' | 'outline' | 'ghost' | 'dark' | 'danger' | 'soft'; size?: 'sm' | 'md' | 'lg' };
export function Button({ variant = 'outline', size = 'md', className, onClick, ...rest }: BtnProps) {
  const v = {
    lime: 'bg-lime text-ink-900 shadow-lime hover:bg-lime-400 active:bg-lime-500 font-semibold',
    outline: 'bg-white text-ink-900 border border-ink/15 hover:border-ink/30 hover:bg-paper-100',
    ghost: 'text-ink-900 hover:bg-ink/5',
    dark: 'bg-ink-800 text-white hover:bg-ink-700',
    danger: 'bg-white text-red-600 border border-red-200 hover:bg-red-50',
    soft: 'bg-lime-100 text-ink-900 hover:bg-lime-200',
  }[variant];
  const s = { sm: 'h-9 px-3 text-sm rounded-xl gap-1.5', md: 'h-11 px-4 rounded-xl gap-2', lg: 'h-14 px-6 text-lg rounded-2xl gap-3' }[size];
  return (
    <button
      {...rest}
      onClick={(e) => { haptic('tap'); onClick?.(e); }}
      className={cx('pressable inline-flex items-center justify-center select-none transition disabled:opacity-40 disabled:pointer-events-none', v, s, className)}
    />
  );
}

export function IconButton({ label, className, onClick, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      {...rest}
      onClick={(e) => { haptic('tap'); onClick?.(e); }}
      className={cx('pressable inline-flex items-center justify-center rounded-xl h-11 w-11 transition disabled:opacity-30 disabled:pointer-events-none', className)}
    >
      {children}
    </button>
  );
}

export function Toggle({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; id?: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={id}
      onClick={() => { haptic('tap'); onChange(!checked); }}
      className="relative h-11 w-14 -my-2 -mr-1 shrink-0 flex items-center justify-center"
    >
      <span className={cx('relative block h-7 w-12 rounded-full transition-colors', checked ? 'bg-lime-500' : 'bg-ink/20')}>
        <span className={cx('absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
      </span>
    </button>
  );
}

export function Slider({ label, value, onChange, min = -100, max = 100, dark, id, unit = '' }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; dark?: boolean; id?: string; unit?: string }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <label className="block">
      <div className={cx('flex justify-between text-[13px] mb-0', dark ? 'text-white/80' : 'text-ink/70')}>
        <span>{label}</span>
        <span className="tabular-nums" data-testid={id ? id + '-value' : undefined}>{value}{unit}</span>
      </div>
      <input
        type="range"
        data-testid={id}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(0)}
        className="px-range w-full"
        style={{ ['--pct' as any]: pct + '%' }}
      />
    </label>
  );
}

export function Thumb({ k, className, alt = '' }: { k?: string; className?: string; alt?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    blobUrl(k).then((u) => alive && setUrl(u));
    return () => { alive = false; };
  }, [k]);
  if (!url) return <div className={cx('skeleton', className)} />;
  return <img src={url} alt={alt} draggable={false} className={cx('animate-fadeIn', className)} />;
}

export function Sheet({ open, onClose, title, children, dark, wide, testId }: { open: boolean; onClose: () => void; title?: string; children: ReactNode; dark?: boolean; wide?: boolean; testId?: string }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" data-testid={testId}>
      <div className="absolute inset-0 bg-black/40 animate-fadeIn" onClick={onClose} />
      <div
        className={cx(
          'relative w-full max-h-[88vh] overflow-auto rounded-t-3xl sm:rounded-3xl p-5 pb-safe animate-sheetUp sm:animate-pop shadow-2xl',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-md',
          dark ? 'bg-ink-800 text-white' : 'bg-white text-ink-900',
        )}
      >
        <div className="sm:hidden mx-auto -mt-2 mb-3 h-1.5 w-10 rounded-full bg-current opacity-20" />
        {title && (
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">{title}</h3>
            <IconButton label="ปิด" onClick={onClose} className="h-9 w-9 -mr-2 opacity-70 hover:opacity-100"><X size={20} /></IconButton>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function Logo({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
      <path d="M4 16V8a4 4 0 0 1 4-4h8M48 4h8a4 4 0 0 1 4 4v8M60 48v8a4 4 0 0 1-4 4h-8M16 60H8a4 4 0 0 1-4-4v-8" fill="none" stroke="#8ee04a" strokeWidth="3.5" strokeLinecap="round" />
      <rect x="13" y="10" width="38" height="44" rx="9" fill="#8ee04a" />
      <path d="M25 18h10l8 8v18a3 3 0 0 1-3 3H25a3 3 0 0 1-3-3V21a3 3 0 0 1 3-3z M35 18v8h8" fill="none" stroke="#16181b" strokeWidth="3.2" strokeLinejoin="round" />
      <path d="M27 31h10M27 36.5h10M27 42h6" stroke="#16181b" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return <span className={cx('font-bold tracking-tight', className)}>PAPER<span className="text-lime-500">X</span></span>;
}

export function Spinner({ size = 18, className }: { size?: number; className?: string }) {
  return <span className={cx('inline-block rounded-full border-2 border-current border-r-transparent animate-spin', className)} style={{ width: size, height: size }} />;
}

export function useLatest<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

export function Confirm({ open, title, text, okLabel = 'ยืนยัน', danger, onOk, onClose }: { open: boolean; title: string; text?: string; okLabel?: string; danger?: boolean; onOk: () => void; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title={title} testId="confirm">
      {text && <p className="text-ink/70 mb-5">{text}</p>}
      <div className="flex gap-3 justify-end">
        <Button onClick={onClose}>ยกเลิก</Button>
        <Button variant={danger ? 'danger' : 'lime'} data-testid="confirm-ok" onClick={() => { onOk(); onClose(); }}>{okLabel}</Button>
      </div>
    </Sheet>
  );
}
