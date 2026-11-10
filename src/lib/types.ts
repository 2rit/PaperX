export type Pt = { x: number; y: number };
export type Quad = [Pt, Pt, Pt, Pt]; // TL, TR, BR, BL (normalized 0..1)

export type Mode = 'original' | 'color' | 'bw' | 'textBoost' | 'cleanPaper' | 'highContrast' | 'photo';

export const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'original', label: 'ต้นฉบับ', hint: 'ไม่ปรับสีภาพ' },
  { id: 'color', label: 'สี', hint: 'สีสด พื้นขาวสะอาด' },
  { id: 'bw', label: 'ขาวดำ', hint: 'โทนเทา อ่านง่าย' },
  { id: 'textBoost', label: 'Text Boost', hint: 'ตัวอักษรเข้ม คมชัด' },
  { id: 'cleanPaper', label: 'Clean Paper', hint: 'พื้นกระดาษขาวล้วน' },
  { id: 'highContrast', label: 'High Contrast', hint: 'ขาว-ดำ 100% สำหรับพิมพ์' },
  { id: 'photo', label: 'เอกสารภาพถ่าย', hint: 'รักษารายละเอียดภาพ' },
];

export interface PageParams {
  corners: Quad; // crop quad in source image (normalized)
  mids: Quad | null; // edge mid handles for curved page dewarping (top, right, bottom, left) or null = straight
  rotation: 0 | 90 | 180 | 270;
  angle: number; // fine straighten, degrees
  mode: Mode;
  brightness: number; // -100..100
  contrast: number; // -100..100
  saturation: number; // -100..100
  shadow: boolean; // shadow removal
  sharpen: boolean; // text enhancement
  flatten?: boolean; // text-line based auto flatten of curved / wrinkled paper
  book?: { side: 'L' | 'R'; at: number } | null; // book mode: this page is one half of a two-page spread split at `at` (0..1)
}

export interface Page extends PageParams {
  id: string;
  srcKey: string; // blob key of source (downscaled original) image
  srcW: number;
  srcH: number;
  outKey?: string; // processed full image
  thumbKey?: string;
  outW?: number;
  outH?: number;
  rev: number; // increments when processed output changes
  dirty?: boolean; // params changed since last render to outKey
  ocr?: string;
}

export interface Doc {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  pages: Page[];
}

export interface Settings {
  defaultMode: Mode;
  autoCapture: boolean;
  autoCrop: boolean;
  perspective: boolean;
  dewarp: boolean;
  shadow: boolean;
  sharpen: boolean;
  haptics: boolean;
  format: 'pdf' | 'jpg' | 'png';
  paper: 'a4' | 'original';
  quality: 'high' | 'standard';
  openAfter: boolean;
  ocrLang: 'tha+eng' | 'tha' | 'eng';
  onboarded: boolean;
  captureMode: 'doc' | 'book';
}

export const FULL_QUAD: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
