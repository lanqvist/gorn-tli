import { percentile, perHour, summarize, type RateSummary } from './stats.js';
import type { ConfigBaseId, ItemDelta, Run } from './types.js';

export type PriceLookup = (id: ConfigBaseId) => number | null;

/**
 * Сколько времени карта была «живой».
 *
 * Простой — главный способ незаметно испортить любую цифру «в час»:
 * отошёл на десять минут, не выходя из карты, и знаменатель вырос,
 * а числитель нет. Игра при этом продолжает писать в лог, поэтому
 * активность файла признаком не является — считаем по событиям добычи.
 *
 * Промежутки между событиями обрезаются порогом: пауза дольше него
 * в зачёт времени не идёт.
 */
export const IDLE_CAP_MS = 180_000;

export function activeDuration(run: Run, idleCapMs = IDLE_CAP_MS, until?: number): number {
  const end = run.endedAt ?? until ?? run.startedAt;
  const total = Math.max(0, end - run.startedAt);
  if (total <= idleCapMs) return total;

  const events = [...run.drops, ...run.costs]
    .map((e) => e.ts)
    .filter((ts) => ts >= run.startedAt && ts <= end)
    .sort((a, b) => a - b);

  // Без событий судить не о чем — карта могла быть пустой, а могла быть
  // брошенной. Обрезаем по порогу, но не выбрасываем целиком.
  if (events.length === 0) return Math.min(total, idleCapMs);

  let active = 0;
  let previous = run.startedAt;
  for (const ts of [...events, end]) {
    active += Math.min(ts - previous, idleCapMs);
    previous = ts;
  }
  return active;
}

/** Чистая стоимость забега: добыча минус вложения, обе по референсным ценам. */
export function runNet(run: Run, priceOf: PriceLookup): number {
  let value = 0;
  for (const d of run.drops) {
    const price = priceOf(d.configBaseId);
    if (price !== null) value += price * d.qty;
  }
  let cost = 0;
  for (const c of run.costs) {
    const price = priceOf(c.configBaseId);
    if (price !== null) cost += price * c.qty;
  }
  return value - cost;
}

/**
 * Подпись стратегии: из чего карта была открыта.
 *
 * Вложения известны поштучно — они видны в логе как расход по протоколу
 * Spv3Open. Значит стратегию можно определить автоматически, а не просить
 * игрока размечать забеги руками. Exile Diary завёл теги стратегий
 * с постоянной ценой карты; здесь и состав, и цена берутся из фактических
 * расходов.
 */
export function strategyKey(run: Run): string {
  const ids = [...new Set(run.costs.map((c) => c.configBaseId))].sort((a, b) => a - b);
  return ids.length === 0 ? 'none' : ids.join('+');
}

export interface StrategyStats {
  key: string;
  /** Идентификаторы предметов, которыми открывалась карта. */
  costItems: ConfigBaseId[];
  runs: number;
  rate: RateSummary;
  /** Средние вложения на карту. */
  costPerRun: number;
  /** Средняя чистая прибыль с карты. */
  netPerRun: number;
  totalActiveMs: number;
}

/**
 * Группировка забегов по стратегии с честной статистикой внутри каждой.
 *
 * Стратегии с одним-двумя забегами показывать как сравнимые нельзя,
 * поэтому размер выборки едет вместе с цифрой, а не отдельно.
 */
export function groupByStrategy(
  runs: Run[],
  priceOf: PriceLookup,
  idleCapMs = IDLE_CAP_MS,
): StrategyStats[] {
  const groups = new Map<string, Run[]>();
  for (const run of runs) {
    const key = strategyKey(run);
    const list = groups.get(key);
    if (list) list.push(run);
    else groups.set(key, [run]);
  }

  const out: StrategyStats[] = [];
  for (const [key, list] of groups) {
    const rates: number[] = [];
    let cost = 0;
    let net = 0;
    let activeMs = 0;

    for (const run of list) {
      const active = activeDuration(run, idleCapMs);
      const runValue = runNet(run, priceOf);
      activeMs += active;
      net += runValue;
      for (const c of run.costs) {
        const price = priceOf(c.configBaseId);
        if (price !== null) cost += price * c.qty;
      }
      if (active > 5000) rates.push(perHour(runValue, active));
    }

    out.push({
      key,
      costItems: key === 'none' ? [] : key.split('+').map(Number),
      runs: list.length,
      rate: summarize(rates),
      costPerRun: cost / list.length,
      netPerRun: net / list.length,
      totalActiveMs: activeMs,
    });
  }

  // Сначала то, во что вложено больше всего времени: по нему и данных больше.
  return out.sort((a, b) => b.totalActiveMs - a.totalActiveMs);
}

export interface MissingPrice {
  configBaseId: ConfigBaseId;
  /** Сколько штук уже выпало или потрачено. */
  qty: number;
  /** В скольких забегах встречался. */
  runs: number;
  /** Тратится на открытие карт — такой предмет искажает прибыль напрямую. */
  isCost: boolean;
}

/**
 * Чего не хватает для точной оценки — по влиянию на цифру.
 *
 * Порядок не по количеству штук: 305 Пламенных песков по 0,0001 стоят
 * три сотых ФЕ, а неоценённый маяк тратится на каждую карту и искажает
 * прибыль напрямую. Поэтому сначала расходники, затем то, что встречается
 * в большем числе забегов, и только потом количество.
 */
export function missingPrices(runs: Run[], priceOf: PriceLookup): MissingPrice[] {
  const totals = new Map<
    ConfigBaseId,
    { qty: number; runs: Set<number>; isCost: boolean }
  >();

  const note = (delta: ItemDelta, index: number, isCost: boolean): void => {
    if (priceOf(delta.configBaseId) !== null) return;
    const entry = totals.get(delta.configBaseId) ?? {
      qty: 0,
      runs: new Set<number>(),
      isCost: false,
    };
    entry.qty += delta.qty;
    entry.runs.add(index);
    entry.isCost ||= isCost;
    totals.set(delta.configBaseId, entry);
  };

  for (const [index, run] of runs.entries()) {
    for (const drop of run.drops) note(drop, index, false);
    for (const cost of run.costs) note(cost, index, true);
  }

  return [...totals.entries()]
    .map(([configBaseId, e]) => ({
      configBaseId,
      qty: e.qty,
      runs: e.runs.size,
      isCost: e.isCost,
    }))
    .sort((a, b) => {
      if (a.isCost !== b.isCost) return a.isCost ? -1 : 1;
      if (a.runs !== b.runs) return b.runs - a.runs;
      return b.qty - a.qty;
    });
}

/**
 * Норма, с которой сравнивается забег, — медиана последних N забегов.
 *
 * Сравнивать с лучшим забегом статистически бессмысленно и вдобавок
 * демотивирует: рекорд по определению недостижим в большинстве попыток.
 * Скользящее окно нужно, чтобы вчерашняя кампания не тянула норму вниз,
 * когда сегодня фармится эндгейм.
 */
export const NORM_WINDOW = 20;

export function rollingNorm(rates: number[], window = NORM_WINDOW): number {
  const recent = rates.slice(-window);
  if (recent.length === 0) return 0;
  return percentile([...recent].sort((a, b) => a - b), 0.5);
}
