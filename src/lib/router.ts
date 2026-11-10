import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'library' }
  | { name: 'ocr'; id?: string }
  | { name: 'settings' }
  | { name: 'camera'; id?: string }
  | { name: 'editor'; id: string; page?: number }
  | { name: 'export'; id: string };

function parse(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, q] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  const qs = new URLSearchParams(q || '');
  switch (parts[0]) {
    case 'library': return { name: 'library' };
    case 'ocr': return { name: 'ocr', id: parts[1] };
    case 'settings': return { name: 'settings' };
    case 'camera': return { name: 'camera', id: qs.get('doc') || undefined };
    case 'editor': return parts[1] ? { name: 'editor', id: parts[1], page: Number(qs.get('p') || 0) } : { name: 'home' };
    case 'export': return parts[1] ? { name: 'export', id: parts[1] } : { name: 'library' };
    default: return { name: 'home' };
  }
}

let current = parse();
let key = location.hash;
const subs = new Set<() => void>();
window.addEventListener('hashchange', () => {
  if (location.hash === key) return;
  key = location.hash;
  current = parse();
  subs.forEach((f) => f());
});

export function useRoute() {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => current);
}

export function navigate(path: string, replace = false) {
  const h = '#/' + path.replace(/^#?\/?/, '');
  const d = ((history.state as any)?.d as number) || 0;
  if (replace) history.replaceState({ d }, '', h);
  else history.pushState({ d: d + 1 }, '', h);
  key = location.hash;
  current = parse();
  subs.forEach((f) => f());
}

export function back(fallback = 'home') {
  if (((history.state as any)?.d || 0) > 0) history.back();
  else navigate(fallback, true);
}
