import { useSyncExternalStore } from 'react';
export interface Busy { label: string; progress?: number }
let state: Busy | null = null;
const subs = new Set<() => void>();
export function setBusy(b: Busy | null) { state = b; subs.forEach((f) => f()); }
export function useBusy() { return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state); }
