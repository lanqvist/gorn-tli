/**
 * Светлый текст на тёмном фоне: разбивка строки на знаки по столбцам и
 * распознавание цифр по эталонам. Работает в пикселях кадра (без
 * пересэмплирования строки), пороги масштабируются по geo.s.
 */
import { normalize } from './sample.js';
import type { Box } from './sample.js';
import type { Frame, Geometry } from './types.js';

export interface Glyph {
  /** Рамка знака в пикселях кадра. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Размер нормированной картинки знака. */
export const GLYPH_W = 8;
export const GLYPH_H = 12;

let lumBuf = new Float32Array(0);
let inkBuf = new Uint8Array(0);

export interface InkOptions {
  /** Насколько текст ярче медианы строки. */
  contrast: number;
  /**
   * Бледный текст (карточки проявляются): порог снижается до 45 % разницы
   * между медианой и самыми яркими пикселями, но не ниже 25.
   */
  faint?: boolean;
  /** Насыщенность текста не выше (белый и серый текст). */
  maxSat: number;
}

/**
 * Знаки строки: области (в опорных координатах) → рамки знаков слева
 * направо. Знак — столбцы подряд, где есть «чернила» (светлые пиксели).
 */
export function glyphs(frame: Frame, geo: Geometry, box: Box, opt: InkOptions): Glyph[] {
  const fx0 = Math.max(0, Math.round(box[0] * geo.s + geo.tx));
  const fy0 = Math.max(0, Math.round(box[1] * geo.s + geo.ty));
  const fx1 = Math.min(frame.width, Math.round(box[2] * geo.s + geo.tx));
  const fy1 = Math.min(frame.height, Math.round(box[3] * geo.s + geo.ty));
  const w = fx1 - fx0;
  const h = fy1 - fy0;
  if (w <= 0 || h <= 0) return [];
  if (lumBuf.length < w * h) {
    lumBuf = new Float32Array(w * h);
    inkBuf = new Uint8Array(w * h);
  }
  const { data, width } = frame;
  const hist = new Uint32Array(256);
  for (let y = 0; y < h; y++) {
    let k = ((fy0 + y) * width + fx0) * 4;
    for (let x = 0; x < w; x++, k += 4) {
      const l = (data[k]! + data[k + 1]! + data[k + 2]!) / 3;
      lumBuf[y * w + x] = l;
      hist[l | 0]!++;
    }
  }
  let acc = 0;
  let median = 0;
  for (; median < 256; median++) {
    acc += hist[median]!;
    if (acc * 2 >= w * h) break;
  }
  let top = 255;
  acc = 0;
  for (; top > 0; top--) {
    acc += hist[top]!;
    if (acc >= w * h * 0.01) break;
  }
  const thr = median + (opt.faint ? Math.max(25, Math.min(opt.contrast, 0.45 * (top - median))) : opt.contrast);
  for (let y = 0; y < h; y++) {
    let k = ((fy0 + y) * width + fx0) * 4;
    for (let x = 0; x < w; x++, k += 4) {
      const r = data[k]!;
      const g = data[k + 1]!;
      const b = data[k + 2]!;
      const max = r > g ? (r > b ? r : b) : g > b ? g : b;
      const min = r < g ? (r < b ? r : b) : g < b ? g : b;
      inkBuf[y * w + x] = lumBuf[y * w + x]! > thr && max > 0 && (max - min) / max <= opt.maxSat ? 1 : 0;
    }
  }
  const out: Glyph[] = [];
  let start = -1;
  for (let x = 0; x <= w; x++) {
    let ink = false;
    if (x < w) {
      for (let y = 0; y < h; y++) {
        if (inkBuf[y * w + x]) {
          ink = true;
          break;
        }
      }
    }
    if (ink && start < 0) start = x;
    if (!ink && start >= 0) {
      let y0 = h;
      let y1 = -1;
      for (let xx = start; xx < x; xx++) {
        for (let y = 0; y < h; y++) {
          if (inkBuf[y * w + xx]) {
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      out.push({ x0: fx0 + start, y0: fy0 + y0, x1: fx0 + x, y1: fy0 + y1 + 1 });
      start = -1;
    }
  }
  return out;
}

/** Картинка знака GLYPH_W×GLYPH_H по его рамке (среднее по ячейкам), нормированная. */
export function glyphVec(frame: Frame, g: Glyph, out: Float32Array = new Float32Array(GLYPH_W * GLYPH_H)): Float32Array {
  const { data, width } = frame;
  const cw = (g.x1 - g.x0) / GLYPH_W;
  const ch = (g.y1 - g.y0) / GLYPH_H;
  const nx = Math.max(1, Math.min(4, Math.round(cw)));
  const ny = Math.max(1, Math.min(4, Math.round(ch)));
  let o = 0;
  for (let j = 0; j < GLYPH_H; j++) {
    for (let i = 0; i < GLYPH_W; i++) {
      let s = 0;
      for (let v = 0; v < ny; v++) {
        const py = Math.floor(g.y0 + (j + (v + 0.5) / ny) * ch);
        for (let u = 0; u < nx; u++) {
          const px = Math.floor(g.x0 + (i + (u + 0.5) / nx) * cw);
          const k = (py * width + px) * 4;
          s += data[k]! + data[k + 1]! + data[k + 2]!;
        }
      }
      out[o++] = s / (3 * nx * ny);
    }
  }
  normalize(out);
  return out;
}

/** Эталоны цифр: для каждой цифры несколько нормированных картинок и среднее отношение сторон. */
export interface DigitSet {
  protos: { d: number; v: Float32Array }[];
  /** Ширина/высота знака для цифр 0–9 (у «1» узкая). */
  aspect: number[];
}

const gBuf = new Float32Array(GLYPH_W * GLYPH_H);

/** Цифра знака и сходство; −1, если знак не похож ни на одну цифру. */
export function readDigit(frame: Frame, g: Glyph, set: DigitSet, min: number): { d: number; score: number } {
  glyphVec(frame, g, gBuf);
  const aspect = (g.x1 - g.x0) / Math.max(1, g.y1 - g.y0);
  let d = -1;
  let score = min;
  for (const p of set.protos) {
    // Отношение сторон отсекает буквы и «№» с похожим рисунком.
    if (Math.abs(aspect - set.aspect[p.d]!) > 0.22) continue;
    let s = 0;
    for (let i = 0; i < gBuf.length; i++) s += gBuf[i]! * p.v[i]!;
    if (s > score) {
      score = s;
      d = p.d;
    }
  }
  return { d, score };
}
