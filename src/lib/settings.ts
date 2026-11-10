import { useSyncExternalStore } from 'react';
import type { Settings } from './types';

const KEY = 'paperx.settings.v1';
const DEFAULTS: Settings = {
  defaultMode: 'textBoost',
  autoCapture: true,
  autoCrop: true,
  perspective: true,
  dewarp: true,
  shadow: true,
  sharpen: true,
  haptics: true,
  format: 'pdf',
  paper: 'a4',
  quality: 'high',
  openAfter: true,
  ocrLang: 'tha+eng',
  onboarded: false,
  captureMode: 'doc',
};

let state: Settings = load();
const subs = new Set<() => void>();

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getSettings() {
  return state;
}

export function setSettings(patch: Partial<Settings>) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {}
  subs.forEach((f) => f());
}

export function resetSettings() {
  setSettings({ ...DEFAULTS, onboarded: true });
}

export function useSettings() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
}
