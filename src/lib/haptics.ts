import { getSettings } from './settings';

type Kind = 'tap' | 'success' | 'warn' | 'capture';
const PATTERN: Record<Kind, number | number[]> = { tap: 8, success: [12, 40, 18], warn: [30, 50, 30], capture: 25 };

export function haptic(kind: Kind = 'tap') {
  if (!getSettings().haptics) return;
  try {
    navigator.vibrate?.(PATTERN[kind]);
  } catch {}
}
