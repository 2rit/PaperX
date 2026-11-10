import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCheck, Copy, FolderOpen, Layers, Plus, Search, Share2, Trash2, X } from 'lucide-react';
import { deleteDocs, duplicateDoc, restoreDocs, saveDoc, useDocs } from '../lib/docs';
import { navigate } from '../lib/router';
import { toast } from '../lib/toast';
import { haptic } from '../lib/haptics';
import { importToNewDoc, pickFiles } from '../lib/actions';
import { Button, cx } from '../components/ui';
import DocCard from '../components/DocCard';
import type { Doc } from '../lib/types';
import { uid } from '../lib/util';

type Sort = 'recent' | 'oldest' | 'name' | 'pages';
const SORTS: [Sort, string][] = [['recent', 'วันที่ล่าสุด'], ['oldest', 'วันที่เก่าสุด'], ['name', 'ชื่อ (ก-ฮ, A-Z)'], ['pages', 'จำนวนหน้า']];

export default function LibraryScreen() {
  const docs = useDocs();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>(() => (localStorage.getItem('paperx.sort') as Sort) || 'recent');
  const [sel, setSel] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => localStorage.setItem('paperx.sort', sort), [sort]);
  useEffect(() => setSel((s) => s.filter((id) => docs.some((d) => d.id === id))), [docs]);

  const list = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const f = docs.filter((d) => !qq || d.name.toLowerCase().includes(qq) || d.pages.some((p) => p.ocr?.toLowerCase().includes(qq)));
    const cmp: Record<Sort, (a: Doc, b: Doc) => number> = {
      recent: (a, b) => b.updatedAt - a.updatedAt,
      oldest: (a, b) => a.updatedAt - b.updatedAt,
      name: (a, b) => a.name.localeCompare(b.name, 'th'),
      pages: (a, b) => b.pages.length - a.pages.length,
    };
    return f.sort(cmp[sort]);
  }, [docs, q, sort]);

  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const del = async () => {
    if (!sel.length) return;
    const removed = await deleteDocs(sel);
    setSel([]);
    haptic('warn');
    toast(`ลบแล้ว ${removed.length} รายการ`, { action: { label: 'เลิกทำ', run: () => restoreDocs(removed).then(() => toast('กู้คืนแล้ว', { kind: 'success' })) } });
  };
  const copy = async () => {
    for (const id of sel) await duplicateDoc(id);
    toast(`คัดลอกแล้ว ${sel.length} รายการ`, { kind: 'success' });
    setSel([]);
  };
  const open = () => sel[0] && navigate(`editor/${sel[0]}`);
  const merge = async () => {
    const chosen = list.filter((d) => sel.includes(d.id));
    const now = Date.now();
    const pages = chosen.flatMap((d) => d.pages.map((p) => ({ ...p, id: uid() })));
    const d = await saveDoc({ id: uid(), name: 'รวม_' + chosen[0].name, createdAt: now, updatedAt: now, pages });
    setSel([]);
    toast(`รวม ${chosen.length} เอกสารเป็น ${pages.length} หน้าแล้ว`, { kind: 'success', action: { label: 'เปิด', run: () => navigate(`editor/${d.id}`) } });
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement;
      const inInput = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
      if (e.key === '/' && !inInput) { e.preventDefault(); searchRef.current?.focus(); }
      if (inInput) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) { e.preventDefault(); del(); }
      if (e.key === 'Escape') setSel([]);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); setSel(list.map((d) => d.id)); }
      if (e.key === 'Enter' && sel.length === 1) open();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  return (
    <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-10 pt-safe pb-28 flex-1 flex flex-col">
      <div className="pt-5 md:pt-8 flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold flex-1">คลังเอกสาร</h1>
        <label className="flex items-center gap-2 text-sm bg-white border border-ink/10 rounded-xl h-10 pl-3 pr-1">
          <span className="text-ink/60">เรียงตาม:</span>
          <select data-testid="sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="bg-transparent outline-none h-full pr-1 font-medium">
            {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      <div className="mt-4 relative">
        <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink/40" />
        <input
          ref={searchRef}
          data-testid="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="ค้นหาเอกสาร…"
          type="search"
          enterKeyHint="search"
          className="w-full h-12 rounded-2xl bg-white border border-ink/10 pl-10 pr-10 outline-none focus:border-lime-500 focus:ring-4 focus:ring-lime/20 transition"
        />
        {q && <button aria-label="ล้างคำค้น" onClick={() => setQ('')} className="absolute right-1 top-1/2 -translate-y-1/2 h-10 w-10 flex items-center justify-center text-ink/40"><X size={18} /></button>}
      </div>

      {docs.length > 0 && (
        <div className="mt-3 flex items-center gap-2 text-sm text-ink/55">
          <span>{list.length} เอกสาร</span>
          <span className="flex-1" />
          <button data-testid="select-all" className="pressable h-9 px-3 rounded-xl hover:bg-ink/5 flex items-center gap-1.5" onClick={() => setSel(sel.length === list.length ? [] : list.map((d) => d.id))}>
            <CheckCheck size={16} /> {sel.length === list.length && list.length ? 'ยกเลิกทั้งหมด' : 'เลือกทั้งหมด'}
          </button>
          <button data-testid="lib-import" className="pressable h-9 px-3 rounded-xl hover:bg-ink/5 flex items-center gap-1.5" onClick={() => pickFiles().then(importToNewDoc)}>
            <Plus size={16} /> นำเข้า
          </button>
        </div>
      )}

      {list.length ? (
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-4 gap-y-5 sm:gap-x-6" data-testid="lib-grid">
          {list.map((d) => (
            <DocCard key={d.id} doc={d} selected={sel.includes(d.id)} selectable={sel.length > 0} onToggle={() => toggle(d.id)} onLongPress={() => toggle(d.id)} onOpen={() => navigate(`editor/${d.id}`)} />
          ))}
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-center py-16" data-testid="lib-empty">
          <div className="h-20 w-20 rounded-3xl bg-white shadow-card flex items-center justify-center text-lime-600 mb-4"><FolderOpen size={36} /></div>
          {docs.length ? (
            <><div className="font-semibold text-lg">ไม่พบเอกสารที่ตรงกับ “{q}”</div><div className="text-ink/55 mt-1">ลองค้นด้วยคำอื่น หรือค้นจากข้อความที่ OCR แล้ว</div></>
          ) : (
            <>
              <div className="font-semibold text-lg">คลังเอกสารยังว่างอยู่</div>
              <div className="text-ink/55 mt-1 mb-5">เอกสารที่สแกนจะถูกเก็บไว้ในเครื่องนี้อย่างปลอดภัย</div>
              <div className="flex gap-3">
                <Button variant="lime" onClick={() => navigate('camera')}>สแกนเอกสาร</Button>
                <Button onClick={() => pickFiles().then(importToNewDoc)}>นำเข้าไฟล์</Button>
              </div>
            </>
          )}
        </div>
      )}

      <div className={cx('fixed z-40 left-0 right-0 md:left-[180px] lg:left-[210px] bottom-[calc(72px+var(--sab))] md:bottom-4 px-3 md:px-6 transition-all duration-300', sel.length ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0 pointer-events-none')} data-testid="selection-bar">
        <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-2xl border border-ink/5 p-2 pl-4 flex items-center gap-1 sm:gap-2">
          <span className="text-sm flex-1 whitespace-nowrap" data-testid="sel-count">เลือกแล้ว {sel.length} รายการ</span>
          <Button variant="ghost" size="sm" data-testid="act-delete" onClick={del} className="text-red-600"><Trash2 size={18} /><span>ลบ</span></Button>
          <Button variant="ghost" size="sm" data-testid="act-copy" onClick={copy}><Copy size={18} /><span className="hidden sm:inline">คัดลอก</span></Button>
          {sel.length > 1 && <Button variant="ghost" size="sm" data-testid="act-merge" onClick={merge}><Layers size={18} /><span className="hidden sm:inline">รวม</span></Button>}
          {sel.length === 1 && <Button variant="ghost" size="sm" data-testid="act-export" onClick={() => navigate(`export/${sel[0]}`)}><Share2 size={18} /><span className="hidden sm:inline">ส่งออก</span></Button>}
          <Button variant="lime" size="sm" data-testid="act-open" disabled={sel.length !== 1} onClick={open} className="px-4"><FolderOpen size={18} />เปิด</Button>
        </div>
      </div>
    </div>
  );
}
