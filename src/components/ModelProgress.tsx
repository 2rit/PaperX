import { useEffect, useState } from 'react';
import { onModelProgress, type ModelProgress as Progress } from '../lib/learned';

/** First-download progress for the on-device models. Hidden once they are cached. */
export default function ModelProgress({ className = '' }: { className?: string }) {
  const [p, setP] = useState<Progress | null>(null);
  useEffect(() => onModelProgress((next) => setP(next)), []);
  if (!p || p.phase !== 'download' || !p.total || p.loaded >= p.total) return null;
  const pct = Math.max(2, Math.min(99, Math.round((100 * p.loaded) / p.total)));
  const label = p.name === 'dewarp' ? 'กำลังโหลดระบบคลี่หน้า' : 'กำลังโหลดระบบตรวจจับ';
  return (
    <div className={className} data-testid="model-progress">
      <div className="h-1 rounded-full bg-white/20 overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full bg-lime transition-[width] duration-150" style={{ width: pct + '%' }} />
      </div>
      <div className="mt-1 text-[11px] text-white/80">{label} {pct}%</div>
    </div>
  );
}
