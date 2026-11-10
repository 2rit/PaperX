import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Copy, FileDown, RefreshCw, ScanText } from 'lucide-react';
import { getBlob, saveDoc, useDocs } from '../lib/docs';
import { ensureSource, renderBlob } from '../lib/engine';
import { recognize } from '../lib/ocr';
import { navigate } from '../lib/router';
import { setSettings, useSettings } from '../lib/settings';
import { toast } from '../lib/toast';
import { haptic } from '../lib/haptics';
import { downloadBlob } from '../lib/exporter';
import { importToNewDoc, pickFiles } from '../lib/actions';
import { Button, Spinner, Thumb, cx } from '../components/ui';
import DocCard from '../components/DocCard';
import { safeFileName } from '../lib/util';
import type { Page } from '../lib/types';

export default function OcrScreen({ id }: { id?: string }) {
  const docs = useDocs();
  const s = useSettings();
  const doc = id ? docs.find((d) => d.id === id) : undefined;
  const [pi, setPi] = useState(0);
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [prog, setProg] = useState({ p: 0, label: '' });
  const [copied, setCopied] = useState(false);
  const runId = useRef(0);
  const page = doc?.pages[pi];

  const run = async (force = false, lang: string = s.ocrLang) => {
    if (!doc || !page) return;
    if (!force && page.ocr !== undefined) { setText(page.ocr); setState('done'); return; }
    const my = ++runId.current;
    setState('running');
    setProg({ p: 0, label: 'กำลังเตรียมภาพ' });
    try {
      await ensureSource(page.srcKey, () => getBlob(page.srcKey));
      // OCR-optimised render: shadow-free, sharp grayscale text
      const ocrParams: Page = { ...page, mode: page.mode === 'photo' || page.mode === 'color' || page.mode === 'original' ? 'bw' : page.mode === 'highContrast' ? 'bw' : page.mode, shadow: true, sharpen: true, brightness: 0, contrast: 0, saturation: 0 };
      const img = await renderBlob(page.srcKey, ocrParams, 'ocr', 'image/png');
      const r = await recognize(img.blob, lang, (p, label) => my === runId.current && setProg({ p, label }));
      if (my !== runId.current) return;
      setText(r.text);
      setState('done');
      haptic('success');
      const pages = doc.pages.map((x, i) => (i === pi ? { ...x, ocr: r.text } : x));
      await saveDoc({ ...doc, pages });
    } catch (e: any) {
      console.error(e);
      if (my !== runId.current) return;
      setState('error');
      toast('OCR ไม่สำเร็จ: ' + (e?.message || e), { kind: 'error' });
    }
  };

  useEffect(() => { setCopied(false); if (doc && page) run(); else setState('idle'); /* eslint-disable-next-line */ }, [id, pi, !!doc]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    setCopied(true);
    haptic('success');
    toast('คัดลอกข้อความแล้ว', { kind: 'success' });
    setTimeout(() => setCopied(false), 2000);
  };
  const saveTxt = () => {
    if (!doc) return;
    downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), safeFileName(doc.name) + (doc.pages.length > 1 ? `_หน้า${pi + 1}` : '') + '.txt');
  };
  const saveEdits = async () => {
    if (!doc) return;
    await saveDoc({ ...doc, pages: doc.pages.map((x, i) => (i === pi ? { ...x, ocr: text } : x)) });
  };

  // ---------- picker ----------
  if (!doc) {
    const list = [...docs].sort((a, b) => b.updatedAt - a.updatedAt);
    return (
      <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-10 pt-safe pb-10">
        <div className="pt-5 md:pt-8">
          <h1 className="text-2xl font-semibold">OCR – ดึงข้อความจากเอกสาร</h1>
          <p className="text-ink/60 mt-1 text-sm">รองรับภาษาไทยและอังกฤษ ประมวลผลในเครื่อง ไม่ต้องใช้อินเทอร์เน็ต</p>
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button variant="lime" onClick={() => navigate('camera')} data-testid="ocr-scan">สแกนเอกสารใหม่</Button>
          <Button onClick={() => pickFiles().then(importToNewDoc)} data-testid="ocr-import">นำเข้ารูปภาพ/PDF</Button>
        </div>
        <h2 className="mt-7 mb-4 font-semibold">เลือกเอกสารที่ต้องการดึงข้อความ</h2>
        {list.length ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-5" data-testid="ocr-picker">
            {list.map((d) => <DocCard key={d.id} doc={d} onOpen={() => navigate(`ocr/${d.id}`)} />)}
          </div>
        ) : (
          <div className="rounded-3xl border-2 border-dashed border-ink/10 bg-white/60 p-10 text-center text-ink/60" data-testid="ocr-empty">
            <ScanText size={36} className="mx-auto mb-3 text-lime-600" />ยังไม่มีเอกสาร สแกนหรือนำเข้าเอกสารก่อน
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-10 pt-safe pb-10">
      <div className="pt-4 md:pt-8 flex items-center gap-2">
        <button aria-label="ย้อนกลับ" data-testid="ocr-back" onClick={() => navigate('ocr')} className="pressable h-11 w-11 -ml-2 rounded-xl hover:bg-ink/5 flex items-center justify-center"><ArrowLeft size={22} /></button>
        <h1 className="text-xl sm:text-2xl font-semibold truncate">OCR – ดึงข้อความจากเอกสาร</h1>
      </div>
      <div className="mt-4 bg-white rounded-[28px] shadow-card p-5 sm:p-7 grid md:grid-cols-[minmax(0,300px)_1fr] gap-6" data-testid="ocr-card">
        <div>
          <div className="relative aspect-[3/4] max-w-[300px] mx-auto rounded-xl overflow-hidden paper-shadow bg-white">
            <Thumb k={page?.thumbKey} className="absolute inset-0 w-full h-full object-cover" />
            {state === 'running' && <div className="absolute inset-x-0 h-1/4 bg-gradient-to-b from-transparent via-lime/40 to-transparent animate-[scan_1.6s_ease-in-out_infinite]" />}
          </div>
          {doc.pages.length > 1 && (
            <div className="mt-3 flex items-center justify-center gap-2">
              <button aria-label="หน้าก่อน" data-testid="ocr-prev" disabled={pi === 0} onClick={() => setPi(pi - 1)} className="pressable h-10 w-10 rounded-xl border border-ink/10 flex items-center justify-center disabled:opacity-30"><ChevronLeft size={18} /></button>
              <span className="text-sm w-20 text-center">หน้า {pi + 1}/{doc.pages.length}</span>
              <button aria-label="หน้าถัดไป" data-testid="ocr-next" disabled={pi >= doc.pages.length - 1} onClick={() => setPi(pi + 1)} className="pressable h-10 w-10 rounded-xl border border-ink/10 flex items-center justify-center disabled:opacity-30"><ChevronRight size={18} /></button>
            </div>
          )}
          <div className="mt-4 text-sm">
            <div className="font-semibold mb-2">ภาษา</div>
            <div className="flex gap-2">
              {([['tha+eng', 'ไทย + อังกฤษ'], ['tha', 'ไทย'], ['eng', 'English']] as const).map(([v, l]) => (
                <button key={v} data-testid={'lang-' + v} onClick={() => { if (s.ocrLang === v) return; setSettings({ ocrLang: v }); run(true, v); }} disabled={state === 'running'} className={cx('pressable h-9 px-3 rounded-xl border text-xs', s.ocrLang === v ? 'bg-lime-200/70 border-lime-500' : 'border-ink/10')}>{l}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="min-w-0 flex flex-col">
          <div className="flex items-center gap-2 mb-3">
            <h2 className="font-semibold text-lg flex-1">ข้อความที่ตรวจพบ</h2>
            <Button size="sm" data-testid="ocr-copy" onClick={copy} disabled={state !== 'done' || !text}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'คัดลอกแล้ว' : 'คัดลอก'}</Button>
          </div>
          {state === 'running' ? (
            <div className="flex-1 min-h-[260px] rounded-2xl bg-paper-100 border border-ink/5 p-6 flex flex-col items-center justify-center text-center" data-testid="ocr-progress">
              <Spinner size={28} className="text-lime-600 mb-3" />
              <div className="font-medium">{prog.label || 'กำลังอ่านข้อความ'}</div>
              <div className="mt-3 h-2 w-full max-w-xs rounded-full bg-paper-200 overflow-hidden"><div className="h-full bg-lime transition-all" style={{ width: `${Math.round(prog.p * 100)}%` }} /></div>
              <div className="mt-2 text-xs text-ink/50">ครั้งแรกอาจใช้เวลาโหลดข้อมูลภาษาสักครู่ หลังจากนั้นใช้งานออฟไลน์ได้</div>
            </div>
          ) : (
            <textarea data-testid="ocr-text" value={text} onChange={(e) => setText(e.target.value)} onBlur={saveEdits}
              placeholder={state === 'done' ? 'ไม่พบข้อความในหน้านี้' : ''}
              className="flex-1 min-h-[260px] w-full rounded-2xl bg-paper-100 border border-ink/5 p-4 leading-7 text-[15px] outline-none focus:border-lime-500 resize-y" />
          )}
          {state === 'done' && (
            <div className="mt-3 flex items-center gap-2 rounded-2xl bg-lime-50 border border-lime-200 px-3 py-2 text-sm animate-fadeUp" data-testid="ocr-success">
              <span className="h-6 w-6 rounded-full bg-lime-500 text-white flex items-center justify-center"><Check size={14} strokeWidth={3} /></span>
              ตรวจจับข้อความเรียบร้อย <span className="text-ink/50 text-xs">· {text.length} ตัวอักษร</span>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" data-testid="ocr-rerun" onClick={() => run(true)} disabled={state === 'running'}><RefreshCw size={16} /> อ่านใหม่</Button>
            <Button size="sm" data-testid="ocr-txt" onClick={saveTxt} disabled={state !== 'done' || !text}><FileDown size={16} /> บันทึกเป็น .txt</Button>
            <Button size="sm" variant="ghost" onClick={() => navigate(`editor/${doc.id}?p=${pi}`)}>แก้ไขภาพ</Button>
          </div>
        </div>
      </div>
      <style>{`@keyframes scan { 0% { top: -25% } 100% { top: 100% } }`}</style>
    </div>
  );
}
