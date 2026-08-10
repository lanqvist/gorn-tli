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

/** Крупные суммы сокращаем, но только начиная с десятков тысяч. */
export function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${formatNumber(value / 1_000_000, 1)}${NBSP}млн`;
  if (abs >= 10_000) return `${formatNumber(value / 1000, 1)}${NBSP}тыс`;
  return formatNumber(value);
}

/** 1 ч 39 м · 50 с · 2 м 47 с */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}${NBSP}ч ${m}${NBSP}м`;
  if (m > 0) return `${m}${NBSP}м ${s}${NBSP}с`;
  return `${s}${NBSP}с`;
}

/** Короткая форма для таймера забега: 1:12 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
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
