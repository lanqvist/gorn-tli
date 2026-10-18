/**
 * Что удалить из папки кадров тюрьмы.
 *
 * Кадр — PNG (~2,5 МБ) и JSON рядом (килобайты): что было на экране, какие
 * строки лога его вызвали и что Горн ответил. За вечер набегает гигабайт,
 * а нужны для разбора в основном сбои. Поэтому:
 * - картинка кадра с подсказкой живёт 2 часа — успеть сказать «совет был
 *   не тот», пока кадр ещё есть;
 * - картинки сбоев (ничего не распознано, ошибка) и ручных кадров — 7 дней;
 * - описания JSON — 30 дней;
 * - сверх общего потолка удаляются самые старые картинки.
 */

/** Чем кончился кадр. */
export type ShotOutcome = 'hint' | 'miss' | 'manual';

export interface ShotEntry {
  /** Путь без расширения: `<папка дня>/<время>-<вид>`. */
  base: string;
  /** Когда снят (мс). */
  at: number;
  outcome: ShotOutcome;
  /** Размер PNG в байтах, 0 — картинки уже нет. */
  png: number;
  json: boolean;
}

export interface PrunePolicy {
  hintPngMs: number;
  missPngMs: number;
  jsonMs: number;
  maxBytes: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const PRUNE_POLICY: PrunePolicy = {
  hintPngMs: 2 * HOUR,
  missPngMs: 7 * DAY,
  jsonMs: 30 * DAY,
  maxBytes: 1024 ** 3,
};

/**
 * Исход кадра по его JSON: ручной, с подсказкой или сбой. Подсказка с
 * пометкой «не узнал» (неузнанная карта выбора) — тоже сбой: такие кадры
 * нужны для эталонов и хранятся дольше.
 */
export function shotOutcome(info: { kind?: string; hints?: { type?: string; text?: string }[] }): ShotOutcome {
  if (info.kind === 'manual') return 'manual';
  const hints = info.hints ?? [];
  const types = hints.map((h) => h.type);
  if (hints.some((h) => h.type === 'hint' && h.text?.includes('не узнал'))) return 'miss';
  return types.includes('hint') && !types.includes('error') ? 'hint' : 'miss';
}

/** Какие файлы удалить (пути с расширением). */
export function planPrune(entries: readonly ShotEntry[], now: number, policy: PrunePolicy = PRUNE_POLICY): string[] {
  const drop: string[] = [];
  const kept: ShotEntry[] = [];
  for (const e of entries) {
    const age = now - e.at;
    if (age > policy.jsonMs) {
      if (e.png) drop.push(`${e.base}.png`);
      if (e.json) drop.push(`${e.base}.json`);
      continue;
    }
    const pngMs = e.outcome === 'hint' ? policy.hintPngMs : policy.missPngMs;
    if (e.png && age > pngMs) drop.push(`${e.base}.png`);
    else if (e.png) kept.push(e);
  }
  // Потолок: самые старые картинки первыми.
  let total = kept.reduce((s, e) => s + e.png, 0);
  for (const e of [...kept].sort((a, b) => a.at - b.at)) {
    if (total <= policy.maxBytes) break;
    drop.push(`${e.base}.png`);
    total -= e.png;
  }
  return drop;
}
