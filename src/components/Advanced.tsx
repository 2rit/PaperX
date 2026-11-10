import { Crop, Eraser, Frame, ScanLine, Type } from 'lucide-react';
import { setSettings, useSettings } from '../lib/settings';
import type { Settings } from '../lib/types';
import { Toggle } from './ui';

export const ADVANCED: { key: keyof Settings; icon: any; title: string; desc: string }[] = [
  { key: 'perspective', icon: Crop, title: 'Perspective Correction', desc: 'แก้เอกสารที่เอียงให้ตรง' },
  { key: 'dewarp', icon: ScanLine, title: 'Curved Page Dewarping', desc: 'คลี่หน้าโค้ง/ยับให้เรียบอัตโนมัติ (Auto Flatten)' },
  { key: 'autoCrop', icon: Frame, title: 'Four-Corner Detection', desc: 'ตรวจจับมุมทั้ง 4 จุด' },
  { key: 'sharpen', icon: Type, title: 'Text Enhancement', desc: 'เพิ่มความคมชัดตัวอักษร' },
  { key: 'shadow', icon: Eraser, title: 'Shadow Removal', desc: 'ลดเงาและแสงไม่สม่ำเสมอ' },
];

export default function AdvancedPanel({ compact }: { compact?: boolean }) {
  const s = useSettings();
  return (
    <section className="bg-white rounded-3xl shadow-card p-5" data-testid="advanced-panel">
      <h2 className="font-semibold mb-1">ระบบประมวลผลเอกสารขั้นสูง</h2>
      {!compact && <p className="text-xs text-ink/50 mb-3">ทำงานอัตโนมัติกับทุกการสแกนใหม่ เปิด/ปิดได้ตามต้องการ</p>}
      <div className="divide-y divide-ink/5">
        {ADVANCED.map((a) => (
          <div key={a.key} className="flex items-center gap-3 py-2.5">
            <span className="h-9 w-9 rounded-xl bg-lime-100 text-lime-700 flex items-center justify-center shrink-0"><a.icon size={18} /></span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium leading-5">{a.title}</div>
              <div className="text-xs text-ink/50">{a.desc}</div>
            </div>
            <Toggle id={'adv-' + a.key} label={a.title} checked={!!s[a.key]} onChange={(v) => setSettings({ [a.key]: v } as any)} />
          </div>
        ))}
      </div>
    </section>
  );
}
