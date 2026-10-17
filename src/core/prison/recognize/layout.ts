/**
 * Места на экране тюрьмы в опорных координатах (кадр 1920×1080, обычный
 * масштаб интерфейса). Измерены по своим кадрам «Горн — тюрьма».
 * Камеры здесь с индексом 0–15 (0 — допросная), как в view.ts.
 */
import type { Box } from './sample.js';

/** Замок на двери камеры (центр значка). У допросной замка нет. */
export const LOCK: readonly (readonly [number, number])[] = [
  [518, 192], // 1 — допросная, место условное
  [698, 192],
  [870, 192],
  [1044, 192],
  [1220, 192],
  [1393, 192],
  [1400, 327],
  [1408, 468],
  [1416, 617],
  [1233, 617],
  [1052, 617],
  [868, 617],
  [686, 616],
  [503, 616],
  [512, 471],
  [515, 330],
];

/** Центр портрета узника: над замком. */
export const PORTRAIT_DY = -52;

export function portrait(cell: number): [number, number] {
  const [x, y] = LOCK[cell]!;
  return [x, y + PORTRAIT_DY];
}

/** Центр камеры для меток и радиус кольца. */
export const CELL_R = 70;

/** Номера камер на доске (подписи 1–16): их видно на всех экранах доски. */
export const NUMBER: readonly (readonly [number, number])[] = [
  [538, 52],
  [698, 70],
  [871, 70],
  [1045, 70],
  [1219, 70],
  [1394, 70],
  [1492, 277],
  [1499, 418],
  [1416, 653],
  [1233, 653],
  [1053, 653],
  [869, 653],
  [686, 653],
  [503, 653],
  [414, 421],
  [424, 280],
];

/** Золотая стрелка надзирателя: центр стрелки у каждой камеры (на внутренней стороне кольца). */
export const WARDEN: readonly (readonly [number, number])[] = [
  [615, 223],
  [694, 230],
  [864, 232],
  [1041, 229],
  [1216, 230],
  [1291, 223],
  [1287, 275],
  [1295, 416],
  [1304, 473],
  [1232, 464],
  [1053, 467],
  [867, 468],
  [686, 466],
  [608, 473],
  [613, 422],
  [619, 279],
];

/** Надпись над карточками: «Выберите пункт назначения», «Примите решение», «Выберите цель». */
export const HEADER: Box = [700, 682, 1220, 718];
export const HEADER_W = 104;
export const HEADER_H = 12;

/** Красная полоса «Выберите узника для пожирания» (экран цепочки). */
export const CHAIN_BANNER: Box = [700, 815, 1220, 852];
/** Кнопка «Отменить» на экране цепочки. */
export const CANCEL: Box = [1655, 735, 1795, 875];

/** Дни до бунта: крупные цифры в строке сверху. */
export const DAYS: Box = [700, 8, 1220, 52];

/** Панель орудий: места слева направо, сверху вниз (третий ряд и ниже — по шагу, не проверено). */
export const TOOL_SLOT_W = 76;
export const TOOL_SLOT_H = 120;
export function toolSlot(i: number): Box {
  const x = i % 2 === 0 ? 123 : 212;
  const y = 389 + Math.floor(i / 2) * 130;
  return [x - TOOL_SLOT_W / 2, y - TOOL_SLOT_H / 2, x + TOOL_SLOT_W / 2, y + TOOL_SLOT_H / 2];
}
export const TOOL_SLOTS = 4;

/** Хранилище призматических: 2 столбца × 5 рядов, заполняется по строкам. */
export function chromaticSlot(i: number): Box {
  const x = i % 2 === 0 ? 1719 : 1805;
  const y = [237, 337, 433, 533, 633][i >> 1]!;
  return [x - 36, y - 46, x + 36, y + 46];
}

/** Заголовок «Призматический узник» над хранилищем. */
export const CHROMATIC_HEADER: Box = [1600, 98, 1830, 150];

/** Цель: заголовок «Цель: …» (одна или две строки). */
export const OBJECTIVE: Box = [75, 120, 395, 180];

/** Выбор орудий: заголовок, три карты, кнопка «Обновить случ.». */
export const PICK_HEADER: Box = [560, 92, 1360, 126];
export const PICK_CARDS = [477, 957, 1437];
export function pickArt(cx: number): Box {
  return [cx - 100, 270, cx + 100, 470];
}
export function pickTitle(cx: number): Box {
  return [cx - 215, 478, cx + 215, 532];
}
export function pickCard(cx: number): Box {
  return [cx - 228, 182, cx + 228, 869];
}
export const PICK_REROLL: Box = [680, 935, 900, 985];

/** Сокровищница: четыре подарка. */
export const TREASURE_CARDS = [307, 747, 1186, 1622];
export function treasureArt(cx: number): Box {
  return [cx - 110, 250, cx + 110, 450];
}
export function treasureCard(cx: number): Box {
  return [cx - 206, 192, cx + 206, 854];
}

export type { Box };
