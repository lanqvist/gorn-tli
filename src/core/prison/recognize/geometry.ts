/**
 * Калибровка: где доска тюрьмы на кадре. Ищем масштаб и сдвиг опорной
 * разметки 1920×1080 в два шага:
 *
 * 1. Грубо — сравнение карты перепадов яркости (стены, решётки, рамка доски)
 *    с усреднённой картой своих кадров, ячейка 8 опорных px, несколько
 *    масштабов вокруг «по высоте кадра».
 * 2. Точно — подписи номеров камер 1–16: каждую ищем рядом с грубым местом,
 *    по найденным точкам считаем масштаб и сдвиг наименьшими квадратами.
 *
 * На следующих кадрах калибровка не нужна: `boardScore` за доли
 * миллисекунды проверяет подписи в известном месте.
 */
import { NUMBER } from './layout.js';
import { dot, normalize, sample } from './sample.js';
import type { Frame, Geometry } from './types.js';
import type { BoardTemplate } from './templates.js';
import { boardTemplate, decodeU8 } from './templates.js';

/** Подпись номера: рамка вокруг центра, опорные px. */
export const NUMBER_RX = 10;
export const NUMBER_RY = 9;

/** Геометрия по умолчанию: масштаб по высоте, по ширине по центру. */
export function defaultGeometry(frame: Frame): Geometry {
  const s = Math.min(frame.height / 1080, frame.width / 1920);
  return {
    width: frame.width,
    height: frame.height,
    s,
    tx: (frame.width - 1920 * s) / 2,
    ty: (frame.height - 1080 * s) / 2,
    score: 0,
  };
}

const numberBuf = new Float32Array(NUMBER_RX * 2 * NUMBER_RY * 2);

/** Сходство подписи номера i с эталоном, если подпись стоит в (x, y) опорных. */
function numberAt(frame: Frame, geo: Geometry, tpl: BoardTemplate, i: number, x: number, y: number): number {
  sample(frame, geo, [x - NUMBER_RX, y - NUMBER_RY, x + NUMBER_RX, y + NUMBER_RY], NUMBER_RX * 2, NUMBER_RY * 2, 1, numberBuf);
  if (normalize(numberBuf) < 3) return 0;
  return dot(numberBuf, tpl.numbers[i]!);
}

/**
 * Доля подписей номеров, найденных на своих местах (0…1). Подписи видны на
 * всех экранах доски, в том числе на затемнённом экране цепочки.
 */
export function boardScore(frame: Frame, geo: Geometry, tpl: BoardTemplate = boardTemplate()): number {
  let ok = 0;
  for (let i = 0; i < NUMBER.length; i++) {
    const [x, y] = NUMBER[i]!;
    if (numberAt(frame, geo, tpl, i, x, y) > 0.6) ok++;
  }
  return ok / NUMBER.length;
}

/** Карта перепадов яркости кадра: ячейка cell опорных px при масштабе s. */
function gradientMap(frame: Frame, s: number, cell: number): { w: number; h: number; g: Float32Array } {
  const step = cell * s;
  const w = Math.floor(frame.width / step);
  const h = Math.floor(frame.height / step);
  const lum = sample(frame, { width: frame.width, height: frame.height, s: 1, tx: 0, ty: 0, score: 0 }, [0, 0, w * step, h * step], w, h);
  return { w, h, g: gradient(lum, w, h) };
}

export function gradient(lum: Float32Array, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = lum[i + 1]! - lum[i - 1]!;
      const gy = lum[i + w]! - lum[i - w]!;
      g[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return g;
}

/** Уменьшить карту вдвое (среднее 2×2). */
export function pool2(src: Float32Array, w: number, h: number): { w: number; h: number; g: Float32Array } {
  const w2 = w >> 1;
  const h2 = h >> 1;
  const g = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const i = 2 * y * w + 2 * x;
      g[y * w2 + x] = (src[i]! + src[i + 1]! + src[i + w]! + src[i + w + 1]!) / 4;
    }
  }
  return { w: w2, h: h2, g };
}

interface Level {
  w: number;
  h: number;
  cell: number;
  x0: number;
  y0: number;
  t: Float32Array; // нормированный шаблон
}

let levelCache: { tpl: BoardTemplate; levels: [Level, Level] } | null = null;

/** Шаблон карты перепадов на ячейках 8 и 16 опорных px. */
function levels(tpl: BoardTemplate): [Level, Level] {
  if (levelCache?.tpl === tpl) return levelCache.levels;
  const { grad } = tpl;
  const raw = decodeU8(grad.data);
  const src = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) src[i] = raw[i]!;
  const p8 = pool2(src, grad.w, grad.h);
  const p16 = pool2(p8.g, p8.w, p8.h);
  const make = (p: { w: number; h: number; g: Float32Array }, cell: number): Level => {
    const t = Float32Array.from(p.g);
    normalize(t);
    return { w: p.w, h: p.h, cell, x0: grad.x0, y0: grad.y0, t };
  };
  const out: [Level, Level] = [make(p8, grad.cell * 2), make(p16, grad.cell * 4)];
  levelCache = { tpl, levels: out };
  return out;
}

/** Лучший сдвиг шаблона на карте (ячейки), NCC. */
function bestShift(
  map: { w: number; h: number; g: Float32Array },
  c: Level,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): { score: number; x: number; y: number } {
  let best = { score: -1, x: cx, y: cy };
  const n = c.w * c.h;
  for (let oy = cy - ry; oy <= cy + ry; oy++) {
    if (oy < 0 || oy + c.h > map.h) continue;
    for (let ox = cx - rx; ox <= cx + rx; ox++) {
      if (ox < 0 || ox + c.w > map.w) continue;
      let sum = 0;
      let sq = 0;
      let cross = 0;
      for (let y = 0; y < c.h; y++) {
        let k = (oy + y) * map.w + ox;
        let t = y * c.w;
        for (let x = 0; x < c.w; x++, k++, t++) {
          const v = map.g[k]!;
          sum += v;
          sq += v * v;
          cross += v * c.t[t]!;
        }
      }
      const varSum = sq - (sum * sum) / n;
      if (varSum <= 0) continue;
      // Шаблон с нулевым средним: вычитать среднее из окна не нужно.
      const score = cross / Math.sqrt(varSum);
      if (score > best.score) best = { score, x: ox, y: oy };
    }
  }
  return best;
}

/** Масштабы относительно «по высоте кадра», которые пробует калибровка. */
const SCALES = [1, 0.95, 1.05, 0.9, 1.1, 0.85, 0.8, 0.75, 0.7];

/** Ниже этого сходства карты перепадов доски на кадре нет. */
const COARSE_MIN = 0.35;

/**
 * Найти доску на кадре. null — доски на кадре нет (или она не узнаётся).
 * Порядок: сперва место по умолчанию, затем поиск.
 */
export function calibrate(frame: Frame, tpl: BoardTemplate = boardTemplate()): Geometry | null {
  const base = defaultGeometry(frame);
  const quick = refine(frame, base, tpl, 6);
  if (quick && quick.score >= 0.85) return quick;

  const [l8, l16] = levels(tpl);
  // Грубо: ячейка 16 px, все масштабы, сдвиг до ±15 % кадра.
  const cands: { score: number; s: number; x: number; y: number }[] = [];
  for (const k of SCALES) {
    const s = base.s * k;
    const map = gradientMap(frame, s, l16.cell);
    const cx = Math.round((l16.x0 * s + (frame.width - 1920 * s) / 2) / (l16.cell * s));
    const cy = Math.round((l16.y0 * s + (frame.height - 1080 * s) / 2) / (l16.cell * s));
    const r = bestShift(map, l16, cx, cy, Math.ceil(map.w * 0.15), Math.ceil(map.h * 0.15));
    cands.push({ score: r.score, s, x: r.x, y: r.y });
  }
  cands.sort((a, b) => b.score - a.score);
  for (const c of cands.slice(0, 2)) {
    if (c.score < COARSE_MIN) break;
    // Точнее: ячейка 8 px рядом с найденным местом.
    const map = gradientMap(frame, c.s, l8.cell);
    const r = bestShift(map, l8, c.x * 2, c.y * 2, 2, 2);
    const geo: Geometry = {
      width: frame.width,
      height: frame.height,
      s: c.s,
      tx: (r.x * l8.cell - l8.x0) * c.s,
      ty: (r.y * l8.cell - l8.y0) * c.s,
      score: 0,
    };
    const fine = refine(frame, geo, tpl, 8);
    if (fine && fine.score >= 0.6) return fine;
  }
  return null;
}

/**
 * Уточнить геометрию по подписям номеров: каждую ищем в радиусе r опорных
 * px от ожидаемого места, по найденным считаем масштаб и сдвиг.
 */
function refine(frame: Frame, geo: Geometry, tpl: BoardTemplate, r: number): Geometry | null {
  const pts: { x: number; y: number; fx: number; fy: number }[] = [];
  for (let i = 0; i < NUMBER.length; i++) {
    const [nx, ny] = NUMBER[i]!;
    let best = 0.6;
    let bx = 0;
    let by = 0;
    let found = false;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const s = numberAt(frame, geo, tpl, i, nx + dx, ny + dy);
        if (s > best) {
          best = s;
          bx = dx;
          by = dy;
          found = true;
        }
      }
    }
    if (found) {
      pts.push({ x: nx, y: ny, fx: (nx + bx) * geo.s + geo.tx, fy: (ny + by) * geo.s + geo.ty });
    }
  }
  if (pts.length < 6) return null;
  // fx = s·x + tx, fy = s·y + ty — общий масштаб, наименьшие квадраты.
  let mx = 0;
  let my = 0;
  let mfx = 0;
  let mfy = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
    mfx += p.fx;
    mfy += p.fy;
  }
  const n = pts.length;
  mx /= n;
  my /= n;
  mfx /= n;
  mfy /= n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.x - mx) * (p.fx - mfx) + (p.y - my) * (p.fy - mfy);
    den += (p.x - mx) ** 2 + (p.y - my) ** 2;
  }
  const s = num / den;
  const out: Geometry = { width: frame.width, height: frame.height, s, tx: mfx - s * mx, ty: mfy - s * my, score: 0 };
  out.score = boardScore(frame, out, tpl);
  return out;
}
