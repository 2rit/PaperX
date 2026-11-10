import { useSyncExternalStore } from 'react';
let deferred: any = null;
const subs = new Set<() => void>();
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; subs.forEach((f) => f()); });
window.addEventListener('appinstalled', () => { deferred = null; subs.forEach((f) => f()); });
export function useInstallPrompt() {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => deferred);
}
export async function promptInstall() {
  if (!deferred) return false;
  deferred.prompt();
  const r = await deferred.userChoice.catch(() => null);
  deferred = null;
  subs.forEach((f) => f());
  return r?.outcome === 'accepted';
}
