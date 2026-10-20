/**
 * Выборка пикселей в опорных координатах: маленькие картинки из областей
 * кадра (среднее по ячейке, чтобы 4K и 1080p давали одно и то же),
 * нормировка и сравнение. Всё без копий кадра целиком.
 */
import type { Frame, Geometry } from './types.js';

export type Box = [number, number, number, number];

/** Сколько точек на сторону ячейки брать при усреднении (не больше 4). */
function steps(span: number): number {
  return Math.max(1, Math.min(4, Math.round(span)));
}

/**
 * Область (x0, y0)–(x1, y1) опорных координат → картинка w×h.
 * channels 1: яркость (R+G+B)/3; 3: R, G, B подряд по точкам.
 */
export function sample(
  frame: Frame,
  geo: Geometry,
  box: Box,
  w: number,
  h: number,
  channels: 1 | 3 = 1,
  out: Float32Array = new Float32Array(w * h * channels),
): Float32Array {
  const { data, width, height } = frame;
  const [x0, y0, x1, y1] = box;
  const cw = ((x1 - x0) / w) * geo.s;
  const ch = ((y1 - y0) / h) * geo.s;
  const nx = steps(cw);
  const ny = steps(ch);
  const fx0 = x0 * geo.s + geo.tx;
  const fy0 = y0 * geo.s + geo.ty;
  const inv = 1 / (nx * ny);
  let o = 0;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let v = 0; v < ny; v++) {
        let py = Math.floor(fy0 + (j + (v + 0.5) / ny) * ch);
        if (py < 0) py = 0;
        else if (py >= height) py = height - 1;
        const row = py * width;
        for (let u = 0; u < nx; u++) {
          let px = Math.floor(fx0 + (i + (u + 0.5) / nx) * cw);
          if (px < 0) px = 0;
          else if (px >= width) px = width - 1;
          const k = (row + px) * 4;
          r += data[k]!;
          g += data[k + 1]!;
          b += data[k + 2]!;
        }
      }
      if (channels === 1) out[o++] = (r + g + b) * inv * (1 / 3);
      else {
        out[o++] = r * inv;
        out[o++] = g * inv;
        out[o++] = b * inv;
      }
    }
  }
  return out;
}

/** Вычесть среднее и привести к единичной длине; вернуть разброс до нормировки. */
export function normalize(v: Float32Array): number {
  let m = 0;
  for (let i = 0; i < v.length; i++) m += v[i]!;
  m /= v.length;
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const d = v[i]! - m;
    v[i] = d;
    s += d * d;
  }
  const n = Math.sqrt(s);
  if (n > 1e-6) for (let i = 0; i < v.length; i++) v[i]! /= n;
  return Math.sqrt(s / v.length);
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Перевод опорных координат в пиксели кадра. */
export function toFrame(geo: Geometry, x: number, y: number): [number, number] {
  return [x * geo.s + geo.tx, y * geo.s + geo.ty];
}

export function boxToFrame(geo: Geometry, b: Box): Box {
  return [b[0] * geo.s + geo.tx, b[1] * geo.s + geo.ty, b[2] * geo.s + geo.tx, b[3] * geo.s + geo.ty];
}

/** Оттенок (0…360), насыщенность и яркость (0…1) цвета. */
export function hsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, max > 0 ? d / max : 0, max / 255];
}
