import { useEffect, useState } from 'react';
import { Download, HardDrive, Keyboard, Shield, Smartphone, Trash2, RotateCcw, Share } from 'lucide-react';
import { setSettings, resetSettings, useSettings } from '../lib/settings';
import { clearAllData, useDocs } from '../lib/docs';
import { MODES } from '../lib/types';
import { Button, Confirm, Toggle, cx } from '../components/ui';
import AdvancedPanel from '../components/Advanced';
import { promptInstall, useInstallPrompt } from '../lib/install';
import { formatBytes, isIOS, isStandalone } from '../lib/util';
import { toast } from '../lib/toast';

function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-3">
      <div className="flex-1 min-w-0"><div className="text-sm font-medium">{title}</div>{desc && <div className="text-xs text-ink/50">{desc}</div>}</div>
      {children}
    </div>
  );
}

export default function SettingsScreen() {
  const s = useSettings();
  const docs = useDocs();
  const install = useInstallPrompt();
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [confirm, setConfirm] = useState(false);
  const canVibrate = typeof navigator.vibrate === 'function';
  const finePointer = matchMedia('(pointer: fine)').matches;

  const refresh = () => {
    navigator.storage?.estimate?.().then((e) => setUsage({ used: e.usage || 0, quota: e.quota || 0 })).catch(() => {});
    navigator.storage?.persisted?.().then(setPersisted).catch(() => {});
  };
  useEffect(refresh, [docs.length]);

  return (
    <div className="w-full max-w-3xl mx-auto px-4 sm:px-6 lg:px-10 pt-safe pb-10">
      <h1 className="pt-5 md:pt-8 text-2xl font-semibold">ตั้งค่า</h1>

      <section className="mt-5 bg-white rounded-3xl shadow-card px-5 py-2 divide-y divide-ink/5">
        <Row title="โหมดเอกสารเริ่มต้น" desc="ใช้กับทุกการสแกนใหม่">
          <select data-testid="set-mode" value={s.defaultMode} onChange={(e) => setSettings({ defaultMode: e.target.value as any })} className="h-10 rounded-xl border border-ink/10 px-3 bg-white text-sm">
            {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </Row>
        <Row title="ถ่ายอัตโนมัติ" desc="ถ่ายให้เองเมื่อเอกสารอยู่ในกรอบและกล้องนิ่ง">
          <Toggle id="set-auto" label="ถ่ายอัตโนมัติ" checked={s.autoCapture} onChange={(v) => setSettings({ autoCapture: v })} />
        </Row>
        {canVibrate && (
          <Row title="การสั่นตอบสนอง" desc="สั่นเบาๆ เมื่อแตะหรือถ่ายภาพ">
            <Toggle id="set-haptics" label="การสั่น" checked={s.haptics} onChange={(v) => setSettings({ haptics: v })} />
          </Row>
        )}
        <Row title="ภาษา OCR">
          <select data-testid="set-ocr" value={s.ocrLang} onChange={(e) => setSettings({ ocrLang: e.target.value as any })} className="h-10 rounded-xl border border-ink/10 px-3 bg-white text-sm">
            <option value="tha+eng">ไทย + อังกฤษ</option><option value="tha">ไทย</option><option value="eng">English</option>
          </select>
        </Row>
        <Row title="ส่งออกเริ่มต้น" desc="รูปแบบ · ขนาด · คุณภาพ">
          <div className="flex gap-1.5">
            <select data-testid="set-format" value={s.format} onChange={(e) => setSettings({ format: e.target.value as any })} className="h-10 rounded-xl border border-ink/10 px-2 bg-white text-sm"><option value="pdf">PDF</option><option value="jpg">JPG</option><option value="png">PNG</option></select>
            <select data-testid="set-paper" value={s.paper} onChange={(e) => setSettings({ paper: e.target.value as any })} className="h-10 rounded-xl border border-ink/10 px-2 bg-white text-sm"><option value="a4">A4</option><option value="original">ต้นฉบับ</option></select>
            <select data-testid="set-quality" value={s.quality} onChange={(e) => setSettings({ quality: e.target.value as any })} className="h-10 rounded-xl border border-ink/10 px-2 bg-white text-sm"><option value="high">สูง</option><option value="standard">มาตรฐาน</option></select>
          </div>
        </Row>
      </section>

      <div className="mt-5"><AdvancedPanel /></div>

      <section className="mt-5 bg-white rounded-3xl shadow-card p-5" data-testid="install-section">
        <h2 className="font-semibold flex items-center gap-2"><Smartphone size={18} /> ติดตั้งแอป</h2>
        {isStandalone() ? (
          <p className="text-sm text-ink/60 mt-2">ติดตั้งแล้ว ✓ เปิดจากหน้าจอโฮมได้เลย ใช้งานออฟไลน์ได้</p>
        ) : install ? (
          <div className="mt-3 flex items-center gap-3">
            <p className="text-sm text-ink/60 flex-1">ติดตั้ง PAPERX ไว้บนหน้าจอโฮม เปิดได้เร็ว ใช้งานออฟไลน์</p>
            <Button variant="lime" data-testid="install-btn" onClick={() => promptInstall().then((ok) => ok && toast('ติดตั้งแล้ว', { kind: 'success' }))}><Download size={18} /> ติดตั้ง</Button>
          </div>
        ) : isIOS() ? (
          <ol className="mt-3 text-sm text-ink/70 space-y-1.5 list-decimal pl-5">
            <li>เปิดหน้านี้ใน Safari</li>
            <li>แตะปุ่มแชร์ <Share size={14} className="inline -mt-1" /> ที่แถบด้านล่าง</li>
            <li>เลือก “เพิ่มไปยังหน้าจอโฮม” แล้วแตะ “เพิ่ม”</li>
          </ol>
        ) : (
          <p className="text-sm text-ink/60 mt-2">เปิดเมนูเบราว์เซอร์แล้วเลือก “ติดตั้งแอป” หรือ “เพิ่มไปยังหน้าจอหลัก” · ใช้งานออฟไลน์ได้หลังเปิดครั้งแรก</p>
        )}
      </section>

      <section className="mt-5 bg-white rounded-3xl shadow-card px-5 py-2 divide-y divide-ink/5">
        <Row title="พื้นที่จัดเก็บในเครื่อง" desc={usage ? `ใช้ไป ${formatBytes(usage.used)} จาก ${formatBytes(usage.quota)} · ${docs.length} เอกสาร` : `${docs.length} เอกสาร`}>
          <HardDrive size={20} className="text-ink/40" />
        </Row>
        <Row title="ป้องกันข้อมูลถูกลบอัตโนมัติ" desc={persisted ? 'เปิดใช้งานแล้ว เบราว์เซอร์จะไม่ล้างเอกสารของคุณ' : 'ขอให้เบราว์เซอร์เก็บข้อมูลแบบถาวร'}>
          {persisted ? <span className="text-lime-700 text-sm font-medium">✓ เปิดแล้ว</span> :
            <Button size="sm" data-testid="persist-btn" onClick={async () => { const ok = await navigator.storage?.persist?.(); refresh(); toast(ok ? 'เปิดการจัดเก็บถาวรแล้ว' : 'เบราว์เซอร์ไม่อนุญาตในตอนนี้ (ติดตั้งแอปเพื่อเพิ่มโอกาส)', { kind: ok ? 'success' : 'info' }); }}>เปิด</Button>}
        </Row>
        {finePointer && (
          <Row title="คีย์ลัด" desc="ใช้คีย์บอร์ดเพื่อทำงานได้เร็วขึ้น">
            <Button size="sm" data-testid="shortcuts-btn" onClick={() => window.dispatchEvent(new Event('px-shortcuts'))}><Keyboard size={16} /> ดูคีย์ลัด</Button>
          </Row>
        )}
        <Row title="คืนค่าการตั้งค่าเริ่มต้น">
          <Button size="sm" data-testid="reset-settings" onClick={() => { resetSettings(); toast('คืนค่าเริ่มต้นแล้ว', { kind: 'success' }); }}><RotateCcw size={16} /> คืนค่า</Button>
        </Row>
        <Row title="ลบเอกสารทั้งหมด" desc="ลบทุกเอกสารออกจากเครื่องนี้ กู้คืนไม่ได้">
          <Button size="sm" variant="danger" data-testid="clear-all" disabled={!docs.length} onClick={() => setConfirm(true)}><Trash2 size={16} /> ลบทั้งหมด</Button>
        </Row>
      </section>

      <section className="mt-5 rounded-3xl bg-ink-900 text-white p-5 flex gap-4 items-start">
        <Shield className="text-lime shrink-0" size={26} />
        <div className="text-sm text-white/75 leading-relaxed">
          <div className="text-white font-semibold mb-1">ประมวลผลในเครื่อง ปลอดภัยเป็นส่วนตัว</div>
          ภาพ เอกสาร และข้อความ OCR ทั้งหมดถูกประมวลผลและเก็บไว้ในอุปกรณ์ของคุณเท่านั้น ไม่มีการอัปโหลดไปยังเซิร์ฟเวอร์ใดๆ
          <div className="mt-2 text-white/40 text-xs">PAPERX v1.0.0 · Smart Document Scanner</div>
        </div>
      </section>

      <Confirm open={confirm} onClose={() => setConfirm(false)} danger title="ลบเอกสารทั้งหมด?" text={`เอกสาร ${docs.length} รายการจะถูกลบออกจากเครื่องนี้ถาวร`} okLabel="ลบทั้งหมด"
        onOk={async () => { await clearAllData(); toast('ลบเอกสารทั้งหมดแล้ว'); refresh(); }} />
      <span className={cx('hidden')} />
    </div>
  );
}
