import { ArrowRight, BookOpen, Camera, Image as ImageIcon, Lightbulb, Waves, X } from 'lucide-react';
import { useDocs } from '../lib/docs';
import { navigate } from '../lib/router';
import { importToNewDoc, pickFiles } from '../lib/actions';
import { setSettings, useSettings } from '../lib/settings';
import { Button, Logo, Wordmark } from '../components/ui';
import DocCard from '../components/DocCard';
import AdvancedPanel from '../components/Advanced';

function HeroArt() {
  return (
    <div className="relative w-[210px] h-[200px] lg:w-[250px] lg:h-[230px]" aria-hidden>
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 250 230" fill="none">
        <g stroke="#8ee04a" strokeWidth="5" strokeLinecap="round">
          <path d="M14 46V18a6 6 0 0 1 6-6h28M202 12h28a6 6 0 0 1 6 6v28M236 184v28a6 6 0 0 1-6 6h-28M48 218H20a6 6 0 0 1-6-6v-28" />
        </g>
      </svg>
      <div className="absolute left-[72px] top-[44px] w-[120px] h-[150px] lg:w-[140px] lg:h-[172px] bg-white rounded-md paper-shadow rotate-[8deg] opacity-80" />
      <div className="absolute left-[44px] top-[26px] w-[128px] h-[160px] lg:w-[148px] lg:h-[184px] bg-white rounded-md paper-shadow -rotate-[5deg] p-3 lg:p-4">
        <div className="h-2 w-16 bg-ink/70 rounded mb-1.5" />
        <div className="h-1.5 w-10 bg-ink/30 rounded mb-3" />
        {[90, 80, 86, 60, 84, 72].map((w, i) => <div key={i} className="h-1 bg-ink/20 rounded mb-1.5" style={{ width: w + '%' }} />)}
        <div className="flex items-end gap-1 h-9 mt-2 ml-auto w-14">
          {[14, 22, 30, 36].map((h, i) => <div key={i} className="w-2.5 bg-ink/45 rounded-sm" style={{ height: h }} />)}
        </div>
      </div>
    </div>
  );
}

function FlattenArt() {
  // before (curved lines) -> after (straight lines)
  const curved = [0, 1, 2, 3, 4, 5].map((i) => `M10 ${22 + i * 14} Q 40 ${30 + i * 14 + i * 1.5}, 70 ${22 + i * 14}`);
  return (
    <div className="flex items-center gap-2 shrink-0" aria-hidden>
      <svg width="84" height="112" viewBox="0 0 80 112" className="bg-white/95 rounded-lg -rotate-3"><g stroke="#1f2a1f" strokeOpacity=".55" strokeWidth="3" fill="none" strokeLinecap="round">{curved.map((d, i) => <path key={i} d={d} />)}</g></svg>
      <ArrowRight className="text-lime" size={22} />
      <svg width="84" height="112" viewBox="0 0 80 112" className="bg-white rounded-lg ring-2 ring-lime"><g stroke="#1f2a1f" strokeOpacity=".7" strokeWidth="3" strokeLinecap="round">{[0, 1, 2, 3, 4, 5].map((i) => <line key={i} x1="10" x2={i % 3 === 2 ? 52 : 70} y1={22 + i * 14} y2={22 + i * 14} />)}</g></svg>
    </div>
  );
}

export default function Home() {
  const docs = useDocs();
  const s = useSettings();
  const recent = [...docs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);

  return (
    <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-10 pt-safe pb-8">
      <div className="md:hidden flex items-center gap-2 pt-4 pb-2">
        <Logo size={32} /><Wordmark className="text-xl" />
      </div>
      <section className="mt-3 md:mt-8 bg-white rounded-[28px] shadow-card p-6 sm:p-8 lg:p-10 flex items-center gap-6 overflow-hidden" data-testid="hero">
        <div className="flex-1 min-w-0">
          <h1 className="text-[40px] sm:text-5xl lg:text-6xl font-bold tracking-tight leading-none">PAPERX</h1>
          <p className="mt-2 text-lg sm:text-xl font-semibold">Scan. Enhance. Save.</p>
          <p className="mt-3 text-ink/70 text-[15px] leading-relaxed max-w-sm">เปลี่ยนเอกสารของคุณให้เป็นไฟล์ดิจิทัล<br className="hidden sm:block" />ด้วยคุณภาพระดับมืออาชีพ</p>
          <div className="mt-6 flex flex-col gap-3 max-w-xs">
            <Button variant="lime" size="lg" data-testid="home-scan" onClick={() => { setSettings({ captureMode: 'doc' }); navigate('camera'); }}>
              <Camera size={22} /> สแกนเอกสาร
            </Button>
            <Button variant="outline" size="lg" className="text-base font-medium" data-testid="home-import" onClick={() => pickFiles().then(importToNewDoc)}>
              <ImageIcon size={20} /> นำเข้าจากแกลเลอรี
            </Button>
          </div>
          <p className="hidden md:block mt-4 text-xs text-ink/45">หรือลากไฟล์รูป/PDF มาวางที่หน้านี้ได้เลย · กด <kbd className="px-1 rounded bg-paper-200">?</kbd> ดูคีย์ลัด</p>
        </div>
        <div className="hidden sm:block shrink-0"><HeroArt /></div>
      </section>

      <section className="mt-5 rounded-3xl bg-ink-900 text-white p-5 sm:p-6 flex flex-col sm:flex-row items-center gap-5 overflow-hidden" data-testid="flatten-spotlight">
        <FlattenArt />
        <div className="flex-1 min-w-0 text-center sm:text-left">
          <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-ink-900 bg-lime rounded-full px-2.5 h-6 mb-2"><Waves size={13} />AUTO FLATTEN</div>
          <h2 className="text-xl font-bold leading-snug">หน้าโค้ง หน้ายับ ก็เรียบเหมือนสแกนเนอร์</h2>
          <p className="text-sm text-white/65 mt-1.5 leading-relaxed">ระบบวัดแนวบรรทัดข้อความแล้วคลี่หน้ากระดาษให้ตรงอัตโนมัติ · โหมดหนังสือถ่ายครั้งเดียวได้ 2 หน้า แยกซ้าย/ขวาให้เอง · ประมวลผลในเครื่อง 100%</p>
          <div className="mt-4 flex flex-col sm:flex-row gap-2.5 justify-center sm:justify-start">
            <Button variant="lime" data-testid="home-book" onClick={() => { setSettings({ captureMode: 'book' }); navigate('camera'); }}><BookOpen size={18} />สแกนหนังสือ (2 หน้า)</Button>
          </div>
        </div>
      </section>

      {!s.onboarded && (
        <section className="mt-5 rounded-3xl bg-ink-900 text-white p-5 relative animate-fadeUp" data-testid="onboarding">
          <button aria-label="ปิดคำแนะนำ" data-testid="onboarding-close" onClick={() => setSettings({ onboarded: true })} className="absolute top-2 right-2 h-10 w-10 flex items-center justify-center text-white/60 hover:text-white"><X size={18} /></button>
          <div className="flex items-center gap-2 text-lime font-semibold mb-3"><Lightbulb size={18} /> เริ่มต้นใช้งานใน 3 ขั้นตอน</div>
          <ol className="grid sm:grid-cols-3 gap-3 text-sm">
            {[
              ['1', 'วางเอกสารบนพื้นสีเข้ม', 'แอปจะตรวจจับมุมและถ่ายให้อัตโนมัติเมื่อกล้องนิ่ง'],
              ['2', 'ถ่ายต่อได้หลายหน้า', 'พลิกหน้าถัดไปแล้วถ่ายต่อ กด “เสร็จสิ้น” เมื่อครบ'],
              ['3', 'ส่งออกหรือดึงข้อความ', 'บันทึกเป็น PDF/JPG/PNG หรือใช้ OCR ไทย-อังกฤษ'],
            ].map(([n, t, d]) => (
              <li key={n} className="flex gap-3 bg-white/5 rounded-2xl p-3">
                <span className="h-7 w-7 rounded-full bg-lime text-ink-900 font-bold flex items-center justify-center shrink-0">{n}</span>
                <span><span className="block font-medium">{t}</span><span className="text-white/60 text-xs">{d}</span></span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="mt-6 grid lg:grid-cols-[1fr_320px] gap-6">
        <section data-testid="recent">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">เอกสารล่าสุด</h2>
            <button data-testid="see-all" onClick={() => navigate('library')} className="pressable text-sm text-ink/70 hover:text-ink flex items-center gap-1 h-10 px-2 -mr-2">
              ดูทั้งหมด <ArrowRight size={16} />
            </button>
          </div>
          {recent.length ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-5">
              {recent.map((d) => <DocCard key={d.id} doc={d} onOpen={() => navigate(`editor/${d.id}`)} />)}
            </div>
          ) : (
            <div className="rounded-3xl border-2 border-dashed border-ink/10 bg-white/60 p-8 text-center" data-testid="recent-empty">
              <div className="mx-auto mb-3 h-14 w-14 rounded-2xl bg-lime-100 flex items-center justify-center text-lime-700"><Camera size={26} /></div>
              <div className="font-medium">ยังไม่มีเอกสาร</div>
              <div className="text-sm text-ink/55 mt-1">เริ่มสแกนเอกสารแรกของคุณ หรือนำเข้ารูปจากแกลเลอรี</div>
            </div>
          )}
        </section>
        <AdvancedPanel />
      </div>
    </div>
  );
}
