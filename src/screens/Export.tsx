import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Download, Share2 } from 'lucide-react';
import { useDocs } from '../lib/docs';
import { back, navigate } from '../lib/router';
import { setSettings, useSettings } from '../lib/settings';
import { canShareFiles, downloadBlob, exportDoc, shareFiles, type ExportFile } from '../lib/exporter';
import { toast } from '../lib/toast';
import { haptic } from '../lib/haptics';
import { Button, Spinner, Thumb, cx } from '../components/ui';
import { formatBytes } from '../lib/util';

function Choice<T extends string>({ value, options, onChange, id }: { value: T; options: [T, string][]; onChange: (v: T) => void; id: string }) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup">
      {options.map(([v, l]) => (
        <button key={v} role="radio" aria-checked={value === v} data-testid={`${id}-${v}`} onClick={() => { haptic('tap'); onChange(v); }}
          className={cx('pressable h-11 min-w-[72px] px-4 rounded-xl text-sm font-medium border transition-colors',
            value === v ? 'bg-lime-200/70 border-lime-500 text-ink-900' : 'bg-white border-ink/10 text-ink/75 hover:border-ink/25')}>
          {l}
        </button>
      ))}
    </div>
  );
}

export default function ExportScreen({ id }: { id: string }) {
  const docs = useDocs();
  const doc = docs.find((d) => d.id === id);
  const s = useSettings();
  const [busy, setBusy] = useState<{ d: number; n: number } | null>(null);
  const [last, setLast] = useState<ExportFile[] | null>(null);
  const [name, setName] = useState(doc?.name || '');
  useEffect(() => { if (doc && !name) setName(doc.name); }, [doc]); // eslint-disable-line
  useEffect(() => setLast(null), [s.format, s.paper, s.quality]);
  const shareOk = canShareFiles();

  if (!doc) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8">
        {docs.length === 0 ? <Spinner /> : <><div>ไม่พบเอกสาร</div><Button variant="lime" onClick={() => navigate('library')}>ไปที่คลังเอกสาร</Button></>}
      </div>
    );
  }

  const run = async (mode: 'download' | 'share') => {
    // open target window synchronously (popup blockers / iOS need a user gesture)
    const win = mode === 'download' && s.openAfter ? window.open('', '_blank') : null;
    try {
      setBusy({ d: 0, n: doc.pages.length });
      const files = await exportDoc({ ...doc, name: name.trim() || doc.name }, { format: s.format, paper: s.paper, quality: s.quality }, (d, n) => setBusy({ d, n }));
      setLast(files);
      if (mode === 'share') {
        await shareFiles(files, doc.name);
      } else {
        for (const f of files) { downloadBlob(f.blob, f.name); await new Promise((r) => setTimeout(r, 250)); }
        if (s.openAfter) {
          const url = URL.createObjectURL(files[0].blob);
          if (win && !win.closed) {
            win.location.href = url;
            // browsers without a built-in viewer download the file instead and leave the tab blank: close it
            setTimeout(() => {
              try {
                if (!win.closed && win.location.href === 'about:blank') { win.close(); toast('เบราว์เซอร์นี้เปิดไฟล์ในแท็บใหม่ไม่ได้ · ไฟล์อยู่ในโฟลเดอร์ดาวน์โหลดแล้ว', { ms: 3500 }); }
              } catch { /* navigated cross-origin = opened in a viewer */ }
            }, 2500);
          } else toast('เบราว์เซอร์บล็อกหน้าต่างใหม่ ไฟล์ถูกดาวน์โหลดแล้ว', { ms: 3500 });
        } else win?.close();
      }
      haptic('success');
      toast(mode === 'share' ? 'แชร์เรียบร้อย' : `ดาวน์โหลดแล้ว ${files.length > 1 ? files.length + ' ไฟล์' : files[0].name}`, { kind: 'success' });
    } catch (e: any) {
      win?.close();
      if (e?.name !== 'AbortError') toast('ส่งออกไม่สำเร็จ: ' + (e?.message || e), { kind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-10 pt-safe pb-10">
      <div className="pt-4 md:pt-8 flex items-center gap-2">
        <button aria-label="ย้อนกลับ" data-testid="exp-back" onClick={() => back(`editor/${id}`)} className="pressable h-11 w-11 -ml-2 rounded-xl hover:bg-ink/5 flex items-center justify-center"><ArrowLeft size={22} /></button>
        <h1 className="text-2xl font-semibold">ส่งออกเอกสาร</h1>
      </div>
      <div className="mt-4 bg-white rounded-[28px] shadow-card p-5 sm:p-7 grid sm:grid-cols-[minmax(0,240px)_1fr] gap-6 sm:gap-8" data-testid="export-card">
        <div>
          <div className="relative aspect-[3/4] w-[150px] sm:w-auto sm:max-w-[240px] mx-auto rounded-xl overflow-hidden paper-shadow bg-white">
            <Thumb k={doc.pages[0]?.thumbKey} className="absolute inset-0 w-full h-full object-cover" />
            {doc.pages.length > 1 && <span className="absolute bottom-2 right-2 rounded-full bg-ink-900/80 text-white text-xs px-2.5 py-1">{doc.pages.length} หน้า</span>}
          </div>
          <button onClick={() => navigate(`editor/${id}`)} className="mt-3 w-full text-sm text-ink/60 hover:text-ink h-9">แก้ไขเอกสาร</button>
        </div>
        <div className="space-y-5 min-w-0">
          <label className="block">
            <div className="text-sm font-semibold mb-2">ชื่อไฟล์</div>
            <input data-testid="exp-name" value={name} onChange={(e) => setName(e.target.value)} className="w-full h-11 rounded-xl border border-ink/10 px-3 outline-none focus:border-lime-500 focus:ring-4 focus:ring-lime/20" />
          </label>
          <div><div className="text-sm font-semibold mb-2">รูปแบบไฟล์</div>
            <Choice id="fmt" value={s.format} onChange={(v) => setSettings({ format: v })} options={[['pdf', 'PDF'], ['jpg', 'JPG'], ['png', 'PNG']]} /></div>
          <div><div className="text-sm font-semibold mb-2">ขนาดกระดาษ</div>
            <Choice id="paper" value={s.paper} onChange={(v) => setSettings({ paper: v })} options={[['a4', 'A4'], ['original', 'ขนาดต้นฉบับ']]} /></div>
          <div><div className="text-sm font-semibold mb-2">คุณภาพ</div>
            <Choice id="quality" value={s.quality} onChange={(v) => setSettings({ quality: v })} options={[['high', 'สูง'], ['standard', 'มาตรฐาน']]} /></div>
          <label className="flex items-center gap-3 cursor-pointer select-none" data-testid="exp-open-label">
            <input type="checkbox" data-testid="exp-open" checked={s.openAfter} onChange={(e) => setSettings({ openAfter: e.target.checked })} className="peer sr-only" />
            <span className={cx('h-6 w-6 rounded-md border-2 flex items-center justify-center transition', s.openAfter ? 'bg-lime-500 border-lime-500 text-white' : 'border-ink/25 bg-white')}>{s.openAfter && <Check size={15} strokeWidth={3.5} />}</span>
            <span className="text-sm">เปิดด้วยแอปพลิเคชันหลังดาวน์โหลด</span>
          </label>
          {s.format !== 'pdf' && doc.pages.length > 1 && <p className="text-xs text-ink/55">ไฟล์รูปภาพจะถูกบันทึกแยกหน้าละ 1 ไฟล์ ({doc.pages.length} ไฟล์)</p>}
          <div className="flex flex-col sm:flex-row gap-3 pt-1">
            <Button variant="lime" size="lg" className="flex-1" data-testid="exp-download" disabled={!!busy} onClick={() => run('download')}>
              {busy ? <><Spinner size={18} /> กำลังสร้าง {Math.min(busy.d + 1, busy.n)}/{busy.n}</> : <><Download size={22} /> ดาวน์โหลด</>}
            </Button>
            {shareOk && (
              <Button size="lg" data-testid="exp-share" disabled={!!busy} onClick={() => run('share')}><Share2 size={20} /> แชร์</Button>
            )}
          </div>
          {last && (
            <div className="text-xs text-ink/55 animate-fadeUp" data-testid="exp-result">
              ไฟล์ล่าสุด: {last.map((f) => `${f.name} (${formatBytes(f.blob.size)})`).join(', ')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
