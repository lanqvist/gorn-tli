import { activeDuration, runEnd, runNet, type RunPricing } from './analysis.js';
import { perHour, summarize, type RateSummary } from './stats.js';
import type { Run } from './types.js';

/**
 * Срезы накопленной истории: по картам, по дням и по сессиям.
 *
 * База хранит каждый забег, но экран до сих пор показывал только последние
 * двадцать пять и одну прошлую сессию — остальное было видно лишь в CSV.
 */

export interface MapStats {
  /** Имя карты — то же, что в таблице забегов. */
  name: string;
  runs: number;
  rate: RateSummary;
  netPerRun: number;
  /** Среднее активное время карты. */
  avgActiveMs: number;
  totalActiveMs: number;
}

/**
 * Какая карта сколько приносит. Стратегии отвечают на «чем открывать»,
 * а это — на «куда идти»: одни и те же вложения на разных картах дают
 * разную добычу.
 */
export function groupByMap(
  runs: Run[],
  nameOf: (run: Run) => string,
  pricing: RunPricing,
): MapStats[] {
  const groups = new Map<string, Run[]>();
  for (const run of runs) {
    const name = nameOf(run);
    const list = groups.get(name);
    if (list) list.push(run);
    else groups.set(name, [run]);
  }

  const out: MapStats[] = [];
  for (const [name, list] of groups) {
    let net = 0;
    let activeMs = 0;
    const rates: number[] = [];
    for (const run of list) {
      const active = activeDuration(run);
      const value = runNet(run, pricing);
      net += value;
      activeMs += active;
      // Тот же отсев, что у стратегий: на пяти секундах темп — шум.
      if (active > 5000) rates.push(perHour(value, active));
    }
    out.push({
      name,
      runs: list.length,
      rate: summarize(rates),
      netPerRun: net / list.length,
      avgActiveMs: activeMs / list.length,
      totalActiveMs: activeMs,
    });
  }
  // Сначала то, где проведено больше времени: там и выборка надёжнее.
  return out.sort((a, b) => b.totalActiveMs - a.totalActiveMs);
}

export interface PeriodTotals {
  runs: number;
  netFe: number;
  inMapMs: number;
}

function totalsOf(runs: Run[], pricing: RunPricing): PeriodTotals {
  let netFe = 0;
  let inMapMs = 0;
  for (const run of runs) {
    netFe += runNet(run, pricing);
    inMapMs += activeDuration(run);
  }
  return { runs: runs.length, netFe, inMapMs };
}

/** Полночь местного времени для метки. */
export function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface DayTotals extends PeriodTotals {
  /** Полночь местного времени. */
  day: number;
}

/**
 * Итоги за последние `days` дней, включая сегодняшний. Пустые дни
 * остаются в ряду: пропуск в графике — тоже информация.
 * День забега — по его окончанию, как и у сессий.
 */
export function dailyTotals(
  runs: Run[],
  pricing: RunPricing,
  days: number,
  now: number,
): DayTotals[] {
  const byDay = new Map<number, Run[]>();
  for (const run of runs) {
    const day = dayStart(runEnd(run));
    const list = byDay.get(day);
    if (list) list.push(run);
    else byDay.set(day, [run]);
  }

  const out: DayTotals[] = [];
  const cursor = new Date(dayStart(now));
  // Шаг через setDate, а не вычитанием суток: при переводе часов
  // в сутках бывает 23 и 25 часов.
  cursor.setDate(cursor.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const day = cursor.getTime();
    out.push({ day, ...totalsOf(byDay.get(day) ?? [], pricing) });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

export interface SessionBounds {
  startedAt: number;
  /** null — активная сессия. */
  endedAt: number | null;
}

export interface SessionTotals extends PeriodTotals, SessionBounds {}

/**
 * Итоги каждой сессии. Забег относится к сессии, в которой закончился —
 * то же правило, что у счётчиков на экране, иначе суммы бы не сошлись.
 * Сессии без забегов отбрасываются: сброс дважды подряд — не событие.
 * Свежие сверху.
 */
export function sessionTotals(
  sessions: SessionBounds[],
  runs: Run[],
  pricing: RunPricing,
): SessionTotals[] {
  return sessions
    .map((s) => {
      const inside = runs.filter((r) => {
        const end = runEnd(r);
        return end >= s.startedAt && (s.endedAt === null || end < s.endedAt);
      });
      return { ...s, ...totalsOf(inside, pricing) };
    })
    .filter((s) => s.runs > 0)
    .sort((a, b) => b.startedAt - a.startedAt);
}
