import { useSyncExternalStore } from 'react';

export interface Toast { id: number; text: string; kind: 'info' | 'success' | 'error'; action?: { label: string; run: () => void }; ms: number }
let toasts: Toast[] = [];
let seq = 0;
const subs = new Set<() => void>();
const emit = () => { toasts = [...toasts]; subs.forEach((f) => f()); };

export function toast(text: string, opts: Partial<Omit<Toast, 'id' | 'text'>> = {}) {
  const t: Toast = { id: ++seq, text, kind: opts.kind || 'info', action: opts.action, ms: opts.ms ?? (opts.action ? 6000 : 2800) };
  toasts.push(t);
  if (toasts.length > 3) toasts.shift();
  emit();
  setTimeout(() => dismiss(t.id), t.ms);
  return t.id;
}
export function dismiss(id: number) {
  const n = toasts.length;
  toasts = toasts.filter((t) => t.id !== id);
  if (toasts.length !== n) emit();
}
export function useToasts() {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => toasts);
}
