/**
 * Русское форматирование. Разделитель разрядов — неразрывный пробел,
 * дробная часть — запятая, как принято в русской типографике.
 */

const NBSP = ' ';

export function formatNumber(value: number, fractionDigits = 0): string {
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })
    .format(value)
    // Intl в некоторых сборках Node отдаёт обычный пробел — приводим к неразрывному,
    // иначе число переносится по строкам.
    .replace(/\s/g, NBSP);
}

/** 1 ч 39 м · 50 с · 2 м 47 с */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}${NBSP}ч ${m}${NBSP}м` : `${h}${NBSP}ч`;
  if (m > 0) return s > 0 ? `${m}${NBSP}м ${s}${NBSP}с` : `${m}${NBSP}м`;
  return `${s}${NBSP}с`;
}

export function formatDateTime(ts: number): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

const CONFIDENCE_LABELS = {
  insufficient: 'данных мало',
  emerging: 'есть картина',
  solid: 'надёжно',
} as const;

export function confidenceLabel(c: keyof typeof CONFIDENCE_LABELS): string {
  return CONFIDENCE_LABELS[c];
}

/** Знаковая дельта для сравнения с медианой: «+240 (+23%)». */
export function formatDelta(value: number, basis: number): string {
  const sign = value >= 0 ? '+' : '−';
  const abs = Math.abs(value);
  if (basis <= 0) return `${sign}${formatNumber(abs)}`;
  const pct = Math.round((abs / basis) * 100);
  return `${sign}${formatNumber(abs)} (${sign}${pct}%)`;
}
