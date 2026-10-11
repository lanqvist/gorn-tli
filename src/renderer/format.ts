export const NBSP = ' ';

export const num = (v: number, digits = 0) =>
  new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
    .format(v)
    .replace(/\s/g, NBSP);

export function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}${NBSP}ч ${m}${NBSP}м` : `${h}${NBSP}ч`;
  if (m > 0) return s > 0 ? `${m}${NBSP}м ${s}${NBSP}с` : `${m}${NBSP}м`;
  return `${s}${NBSP}с`;
}

export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export const time = (ts: number) =>
  new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));

export const cacheDate = (ts: number) =>
  new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));

/** Возраст события человеческим языком. */

export function ago(ms: number): string {
  if (ms < 8_000) return 'только что';
  if (ms < 60_000) return `${Math.round(ms / 1000)} с назад`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} мин назад`;
  return `${Math.round(ms / 3_600_000)} ч назад`;
}

/**
 * Копия в буфер с запасным путём: Clipboard API может быть запрещён
 * политикой окружения, execCommand работает и там.
 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}
