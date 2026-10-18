/**
 * Веса мгновенной стратегии тюрьмы.
 *
 * В горячем цикле веса — Float64Array с индексами W_*, в файле —
 * именованный JSON (weights.json), который пишет src/cli/prison-tune.ts.
 * Все ценности — в долях призматического узника (он стоит 1).
 */

import { TOOL_IDS, type ToolId } from '../model.js';
import tuned from './weights.json';

/** Ценность узника по редкости 0…4 в начале забега. */
export const W_VAL0 = 0;
/** То же к концу забега (между ними — линейно по оставшимся дням). */
export const W_VAL1 = 5;
/** Неиспользованный подарок сокровищницы. */
export const W_GIFT = 10;
/** Запертая дверь: будущий узник за ней. */
export const W_DOOR = 11;
/** Событие «!» на поле. */
export const W_EVENT = 12;
/** Узник, у которого сейчас есть еда. */
export const W_FED = 13;
/** Сдвиг ценности Замены. */
export const W_SWAP = 14;
/** «Подстрекнуть»: за каждое поставленное событие. */
export const W_INSTIGATE = 15;
/** Обновить выбор, если лучшая карта стоит меньше. */
export const W_REROLL = 16;
/** Сдвиг решения «есть дальше» в цепочке. */
export const W_CHAIN = 17;
/** Ожидающий выбор орудия. */
export const W_TOOLPICK = 18;
/** Предпочтение дальнего хода, за шаг. */
export const W_FAR = 19;
/** «Клеймо первородного греха»: за узника, которому оно даст еду. */
export const W_BRAND = 20;
/** Обход: ценность камер впереди двери (1–6 шагов за ней, среднее). */
export const W_AHEAD = 21;
/** Обход: потеря от камер, которые ход проскакивает (сумма). */
export const W_SKIP = 22;
/** «Трёхглавое кольцо»: добавка за каждую открытую дверь (сверх нового узника). */
export const W_RING = 23;
/** Ценность орудия при выборе, по TOOL. */
export const W_TOOL = 24;
export const W_SIZE = W_TOOL + TOOL_IDS.length;

export interface WeightsJson {
  val0: number[];
  val1: number[];
  gift: number;
  door: number;
  event: number;
  fed: number;
  swap: number;
  instigate: number;
  reroll: number;
  chain: number;
  toolPick: number;
  far: number;
  brand?: number;
  ahead?: number;
  skip?: number;
  ring?: number;
  tools: Partial<Record<ToolId, number>>;
}

const SCALARS = [
  ['gift', W_GIFT], ['door', W_DOOR], ['event', W_EVENT], ['fed', W_FED], ['swap', W_SWAP],
  ['instigate', W_INSTIGATE], ['reroll', W_REROLL], ['chain', W_CHAIN], ['toolPick', W_TOOLPICK], ['far', W_FAR], ['brand', W_BRAND], ['ahead', W_AHEAD], ['skip', W_SKIP], ['ring', W_RING],
] as const;

/** Имя веса по индексу (для отчётов настройки). */
export function weightName(i: number): string {
  if (i < W_VAL1) return `val0[${i}]`;
  if (i < W_GIFT) return `val1[${i - W_VAL1}]`;
  if (i >= W_TOOL) return `tools.${TOOL_IDS[i - W_TOOL]}`;
  return SCALARS.find(([, k]) => k === i)?.[0] ?? `w${i}`;
}

export function fromJson(j: WeightsJson): Float64Array {
  const w = new Float64Array(W_SIZE);
  for (let t = 0; t < 5; t++) {
    w[W_VAL0 + t] = j.val0[t] ?? 0;
    w[W_VAL1 + t] = j.val1[t] ?? 0;
  }
  for (const [name, k] of SCALARS) w[k] = j[name] ?? (name === 'brand' ? 0.05 : 0);
  TOOL_IDS.forEach((id, i) => (w[W_TOOL + i] = j.tools[id] ?? 0));
  return w;
}

export function toJson(w: Float64Array): WeightsJson {
  const r = (x: number) => Math.round(x * 10000) / 10000;
  const j = {
    val0: Array.from(w.subarray(W_VAL0, W_VAL0 + 5), r),
    val1: Array.from(w.subarray(W_VAL1, W_VAL1 + 5), r),
    tools: Object.fromEntries(TOOL_IDS.map((id, i) => [id, r(w[W_TOOL + i]!)])),
  } as WeightsJson;
  for (const [name, k] of SCALARS) j[name] = r(w[k]!);
  return j;
}

/** Ручные веса: от них стартует настройка и на них — «жадная» сравнительная точка. */
export const HAND: WeightsJson = {
  val0: [0.02, 0.05, 0.12, 0.27, 0.55],
  val1: [0, 0.01, 0.03, 0.08, 0.2],
  gift: 0.3,
  door: 0.03,
  event: 0.05,
  fed: 0.02,
  swap: 0,
  instigate: 0.03,
  reroll: 0.3,
  chain: 0,
  toolPick: 0.3,
  far: 0,
  brand: 0.05,
  ahead: 0,
  skip: 0,
  ring: 0,
  tools: Object.fromEntries(TOOL_IDS.map((id) => [id, 0.5])),
};

/** Веса по умолчанию — настроенные самоигрой (weights.json). */
export const DEFAULT_WEIGHTS: Float64Array = fromJson(tuned as WeightsJson);
