/**
 * Признаки одной камеры: замок, портрет узника, свечение редкости, значки
 * («!», клыки, гнездо). Только выборка и числа; решения — в board.ts.
 */
import { LOCK, portrait } from './layout.js';
import { dot, normalize, sample } from './sample.js';
import type { Frame, Geometry } from './types.js';

/** Замок: рамка вокруг центра значка, опорные px. */
export const LOCK_RX = 9;
export const LOCK_RY = 13.5;
const lockBuf = new Float32Array(18 * 27);

/** Сходство места замка камеры с эталоном замка (−1…1), лучшее в ±1 px. */
export function lockScore(frame: Frame, geo: Geometry, cell: number, tpl: Float32Array): number {
  const [x, y] = LOCK[cell]!;
  let best = -1;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      sample(frame, geo, [x + dx - LOCK_RX, y + dy - LOCK_RY, x + dx + LOCK_RX, y + dy + LOCK_RY], 18, 27, 1, lockBuf);
      if (normalize(lockBuf) < 4) continue;
      const s = dot(lockBuf, tpl);
      if (s > best) best = s;
    }
  }
  return best;
}

/** Лицо на портрете: без клыков сверху и без рамки по бокам. */
export const FACE = { x0: -22, y0: -20, x1: 22, y1: 30, w: 11, h: 12 };
export const FACE_LEN = FACE.w * FACE.h * 3;

/** Нормированная цветная картинка лица на портрете камеры. */
export function faceVec(frame: Frame, geo: Geometry, cell: number, out: Float32Array = new Float32Array(FACE_LEN)): Float32Array {
  const [x, y] = portrait(cell);
  sample(frame, geo, [x + FACE.x0, y + FACE.y0, x + FACE.x1, y + FACE.y1], FACE.w, FACE.h, 3, out);
  normalize(out);
  return out;
}

/**
 * Корзины цвета свечения. Пиксель «цветной», если насыщенность > 0,4 и
 * яркость > 0,15 (на экране цепочки доска затемнена); «белый» —
 * насыщенность < 0,18 и яркость > 0,5.
 */
export const GLOW_BINS = ['white', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'] as const;
const NB = GLOW_BINS.length;

function bin(r: number, g: number, b: number): number {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  const v = max / 255;
  const s = max > 0 ? (max - min) / max : 0;
  if (s < 0.18) return v > 0.5 ? 0 : -1;
  if (s < 0.4 || v < 0.15) return -1;
  const d = max - min;
  let h: number;
  if (max === r) h = (((g - b) / d + 6) % 6) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  if (h < 15 || h >= 335) return 1;
  if (h < 45) return 2;
  if (h < 70) return 3;
  if (h < 170) return 4;
  if (h < 248) return 5;
  if (h < 300) return 6;
  return 7;
}

/**
 * Области свечения вокруг портрета (опорные px от центра портрета):
 * левая и правая полосы вдоль рамки, верх без середины (там клыки).
 */
export const GLOW_REGIONS: readonly (readonly [number, number, number, number])[] = [
  [-44, -36, -30, 20],
  [30, -36, 44, 20],
  [-36, -58, -18, -40],
  [18, -58, 36, -40],
];
const GLOW_CELL = 2;
const glowBuf = new Float32Array(32 * 32 * 3);

/** Доли пикселей каждой корзины цвета: [область × корзина], области — бока и верх. */
export function glow(frame: Frame, geo: Geometry, cell: number, out: Float32Array = new Float32Array(3 * NB)): Float32Array {
  out.fill(0);
  const [px, py] = portrait(cell);
  for (let r = 0; r < GLOW_REGIONS.length; r++) {
    const [x0, y0, x1, y1] = GLOW_REGIONS[r]!;
    const w = (x1 - x0) / GLOW_CELL;
    const h = (y1 - y0) / GLOW_CELL;
    const buf = sample(frame, geo, [px + x0, py + y0, px + x1, py + y1], w, h, 3, glowBuf);
    const slot = r < 2 ? 0 : 1; // бока вместе, верх вместе
    const base = slot * NB;
    for (let i = 0; i < w * h; i++) {
      const k = bin(buf[i * 3]!, buf[i * 3 + 1]!, buf[i * 3 + 2]!);
      if (k >= 0) out[base + k]! += 1;
    }
  }
  // Нормировка на число пикселей каждой пары областей.
  const side = 2 * ((14 * 56) / (GLOW_CELL * GLOW_CELL));
  const top = 2 * ((18 * 18) / (GLOW_CELL * GLOW_CELL));
  for (let k = 0; k < NB; k++) {
    out[k]! /= side;
    out[NB + k]! /= top;
  }
  // Третья часть — бока и верх вместе.
  for (let k = 0; k < NB; k++) out[2 * NB + k] = (out[k]! * side + out[NB + k]! * top) / (side + top);
  return out;
}

/** Доля пикселей области, подходящих под условие на цвет (выборка с шагом cell опорных px). */
export function colorShare(
  frame: Frame,
  geo: Geometry,
  box: readonly [number, number, number, number],
  cell: number,
  test: (r: number, g: number, b: number) => boolean,
): number {
  const w = Math.max(1, Math.round((box[2] - box[0]) / cell));
  const h = Math.max(1, Math.round((box[3] - box[1]) / cell));
  const buf = sample(frame, geo, [box[0], box[1], box[2], box[3]], w, h, 3, shareBuf.length >= w * h * 3 ? shareBuf : new Float32Array(w * h * 3));
  let n = 0;
  for (let i = 0; i < w * h; i++) if (test(buf[i * 3]!, buf[i * 3 + 1]!, buf[i * 3 + 2]!)) n++;
  return n / (w * h);
}
const shareBuf = new Float32Array(64 * 64 * 3);

/** Оранжевый «!» события: ярко, насыщенно, оттенок 20–50°. */
export function isEventOrange(r: number, g: number, b: number): boolean {
  return r > 170 && r > g && g > b && (r - b) / r > 0.55 && g - b > 0.35 * (r - b) && g - b < 0.85 * (r - b);
}

/** Красно-розовые клыки над портретом. */
export function isJawRed(r: number, g: number, b: number): boolean {
  return r > 140 && r > g * 1.6 && r > b * 1.5;
}

/** Золото стрелки надзирателя. */
export function isGold(r: number, g: number, b: number): boolean {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  return max > 120 && (max - min) / max > 0.45 && r >= g && g > b * 1.3 && r - g < 100;
}

/** «!» события: правее камеры, чуть выше замка. */
export const EVENT_DX = 69;
export const EVENT_DY = -22;

export function eventShare(frame: Frame, geo: Geometry, cell: number): number {
  const [x, y] = LOCK[cell]!;
  return colorShare(frame, geo, [x + EVENT_DX - 6, y + EVENT_DY - 15, x + EVENT_DX + 6, y + EVENT_DY + 15], 2, isEventOrange);
}

/** Клыки над портретом: серая картинка 22×15 области (−22…+22, −46…−16 от центра портрета). */
export const JAW = { x0: -22, y0: -46, x1: 22, y1: -16, w: 22, h: 15 };

export function jawVec(frame: Frame, geo: Geometry, cell: number, out: Float32Array = new Float32Array(JAW.w * JAW.h)): Float32Array {
  const [x, y] = portrait(cell);
  sample(frame, geo, [x + JAW.x0, y + JAW.y0, x + JAW.x1, y + JAW.y1], JAW.w, JAW.h, 1, out);
  normalize(out);
  return out;
}

/** Пламенные клыки цепочки вокруг портрета-цели: красное по бокам и снизу. */
export function chainJawShare(frame: Frame, geo: Geometry, cell: number): number {
  const [x, y] = portrait(cell);
  const a = colorShare(frame, geo, [x - 30, y + 46, x + 30, y + 64], 2, isJawRed);
  const b = colorShare(frame, geo, [x - 30, y - 70, x + 30, y - 50], 2, isJawRed);
  return Math.min(a, b);
}

/** Средний цвет рамки портрета (узкие полосы по бокам), R, G, B. */
export function borderColor(frame: Frame, geo: Geometry, cell: number): [number, number, number] {
  const [x, y] = portrait(cell);
  const a = sample(frame, geo, [x - 32, y - 24, x - 29, y + 24], 1, 1, 3);
  const b = sample(frame, geo, [x + 29, y - 24, x + 32, y + 24], 1, 1, 3);
  return [(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2, (a[2]! + b[2]!) / 2];
}
