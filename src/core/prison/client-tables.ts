/**
 * Числа из таблиц клиента игры для выбора событий и орудий.
 *
 * Источник — расшифрованные Lua-таблицы S16 (Steam build 25986394):
 * config_s16_gameplay_event.out и config_s16_gameplay_relic.out, патч 6139046
 * (docs/prison/client-data/numeric-s16-*.json — только локально;
 * docs/prison/client-data/numeric-findings.md). Пропущенные поля строк
 * наследуются из most_value — здесь уже раскрыты. Перенесены только ID и
 * числа, без текстов издателя.
 *
 * Это базовые веса выбора, не вероятности: сервер может менять их во время
 * забега (BuildWeightInc, ступени Узурпации), а шанс самой метки события
 * таблицы не задают.
 */

import type { EventId, ToolId } from './model.js';

/** Где может появиться событие: SpawnCellState 801 any, 802 unopened, 803 opened. */
export type SpawnCell = 'any' | 'unopened' | 'opened';

export interface EventSpec {
  /** Базовый Weight. */
  readonly weight: number;
  readonly spawn: SpawnCell;
  /** ExcludeRelic: событие не выпадает, если у игрока есть это орудие. */
  readonly excludeTools: readonly ToolId[];
}

/**
 * События 201–255. У всех UnlockType 402 (complete_game_count), UnlockParam 2,
 * RepeatLimit пустой: движок считает всё разблокированным и без лимита повторов.
 */
export const EVENT_SPEC: Readonly<Record<EventId, EventSpec>> = {
  convict: { weight: 40, spawn: 'unopened', excludeTools: [] }, // 201
  freedom: { weight: 40, spawn: 'unopened', excludeTools: ['muzzle'] }, // 202, ExcludeRelic [101]
  behind: { weight: 40, spawn: 'unopened', excludeTools: [] }, // 203
  appetite: { weight: 30, spawn: 'opened', excludeTools: [] }, // 211
  extra: { weight: 30, spawn: 'opened', excludeTools: [] }, // 212
  luck: { weight: 20, spawn: 'opened', excludeTools: [] }, // 213
  rival: { weight: 30, spawn: 'opened', excludeTools: [] }, // 221
  execution: { weight: 20, spawn: 'opened', excludeTools: [] }, // 222
  raven: { weight: 10, spawn: 'any', excludeTools: [] }, // 231
  treasure: { weight: 10, spawn: 'any', excludeTools: [] }, // 232
  ratway: { weight: 20, spawn: 'any', excludeTools: [] }, // 241
  chain: { weight: 20, spawn: 'any', excludeTools: [] }, // 242
  escort: { weight: 20, spawn: 'opened', excludeTools: [] }, // 251
  usurp1: { weight: 10, spawn: 'any', excludeTools: [] }, // 252
  // 253–255: базовый вес 0. По текстам ступени сменяют друг друга в пуле; с каким
  // весом выпадает следующая — не найдено, движок берёт Params.usurpNextWeight.
  usurp2: { weight: 0, spawn: 'any', excludeTools: [] },
  usurp3: { weight: 0, spawn: 'any', excludeTools: [] },
  usurp4: { weight: 0, spawn: 'any', excludeTools: [] },
};

export interface ToolSpec {
  /** Базовый Weight: 40 у обычных (101–132), 5 у особых (141–148). */
  readonly weight: number;
  /** BuildWeightInc: прибавка веса по BuildID. Как сервер её применяет — не найдено; движок не использует. */
  readonly buildWeightInc: number;
  /** Exclude: при этом орудии перечисленные не выпадают. */
  readonly exclude: readonly ToolId[];
}

// Особые орудия: пара одного зверя совместима, с остальными особыми — нет (Exclude 141–148).
const ELEPHANT: readonly ToolId[] = ['tongs', 'maul'];
const LION_PAIR: readonly ToolId[] = ['trap', 'crown'];
const WOLF_PAIR: readonly ToolId[] = ['claws', 'guillotine'];
const RAT_PAIR: readonly ToolId[] = ['ironbox', 'skewer'];
const SPECIAL: readonly ToolId[] = [...ELEPHANT, ...LION_PAIR, ...WOLF_PAIR, ...RAT_PAIR];
const special = (pair: readonly ToolId[]): ToolSpec => ({
  weight: 5,
  buildWeightInc: 80,
  exclude: SPECIAL.filter((t) => !pair.includes(t)),
});
const common = (buildWeightInc = 40): ToolSpec => ({ weight: 40, buildWeightInc, exclude: [] });

/** Орудия 101–148. У всех MaxObtain 1; UnlockType 402 — движок считает всё разблокированным. */
export const TOOL_SPEC: Readonly<Record<ToolId, ToolSpec>> = {
  muzzle: common(), ravenous: common(), collar: common(), revenge: common(), cage: common(), whip: common(),
  saw: common(), blacklist: common(), keys: common(), coin: common(), fire: common(), dogtag: common(),
  forged: common(), hook: common(), scapegoat: common(), axe: common(), maiden: common(), scales: common(),
  rope: common(), stake: common(), pestle: common(), shortchain: common(0), shackles: common(0),
  tongs: special(ELEPHANT), maul: special(ELEPHANT),
  trap: special(LION_PAIR), crown: special(LION_PAIR),
  claws: special(WOLF_PAIR), guillotine: special(WOLF_PAIR),
  ironbox: special(RAT_PAIR), skewer: special(RAT_PAIR),
};

/** Вариантов в выборе орудия (config 320). */
export const TOOL_OFFER = 3;
/** Цели task 1–5 и темы 301–304: Weight 25 у каждой; темы взаимно исключают друг друга. */
export const OBJECTIVE_WEIGHT = 25;
export const THEME_WEIGHT = 25;
