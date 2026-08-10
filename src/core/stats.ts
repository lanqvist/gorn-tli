/**
 * Честная статистика — главное отличие Горна от остальных трекеров жанра.
 *
 * Все известные трекеры (TITrack, Fenix, Exile Diary, Exilence, PoeStash,
 * Wealthy Exile, dIVa) показывают СРЕДНЕЕ значение дохода в час.
 * Для дропа в ARPG это плохая оценка: распределение с тяжёлым хвостом,
 * одна редкая дорогая вещь задирает среднее так, что оно перестаёт
 * описывать типичный забег. Игрок принимает решения по числу,
 * которого не увидит ни в одном забеге.
 *
 * Поэтому главная метрика — медиана, а рядом всегда показывается,
 * насколько ей можно верить.
 */

export interface RateSummary {
  /** Медиана — главное число на экране. */
  median: number;
  /** Среднее — рядом мелким шрифтом, для сравнения с другими трекерами. */
  mean: number;
  p25: number;
  p75: number;
  /** Сколько забегов легло в расчёт. */
  sampleSize: number;
  confidence: Confidence;
  /** Доля общего дохода, принесённая самым удачным забегом.
   *  Если она велика — цифра держится на одной находке. */
  topShare: number;
}

export type Confidence = 'insufficient' | 'emerging' | 'solid';

/** Пороги подобраны так, чтобы бейдж менялся на осмысленных отрезках фарма. */
export const CONFIDENCE_THRESHOLDS = { emerging: 15, solid: 50 } as const;

export function confidenceOf(sampleSize: number): Confidence {
  if (sampleSize < CONFIDENCE_THRESHOLDS.emerging) return 'insufficient';
  if (sampleSize < CONFIDENCE_THRESHOLDS.solid) return 'emerging';
  return 'solid';
}

/** Линейно интерполированный перцентиль. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export function median(values: number[]): number {
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

/**
 * Сводка по набору значений (например, ФЕ/час по каждому забегу).
 */
export function summarize(values: number[]): RateSummary {
  const n = values.length;
  if (n === 0) {
    return {
      median: 0,
      mean: 0,
      p25: 0,
      p75: 0,
      sampleSize: 0,
      confidence: 'insufficient',
      topShare: 0,
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((a, b) => a + b, 0);
  const max = sorted[sorted.length - 1]!;

  return {
    median: percentile(sorted, 0.5),
    mean: total / n,
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    sampleSize: n,
    confidence: confidenceOf(n),
    topShare: total > 0 ? max / total : 0,
  };
}

/** Доход в час из количества и длительности. */
export function perHour(amount: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return (amount / durationMs) * 3_600_000;
}
