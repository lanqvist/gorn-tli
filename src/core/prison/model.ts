/**
 * Тюрьма Талоса: ид, типы и параметры правил.
 *
 * Всё по docs/prison/rules.md. Где правило — догадка, число вынесено в
 * Params и настраивается, а не зашито в движок.
 */

// ── звери и редкости ────────────────────────────────────────────────────────

export const BEASTS = ['mammoth', 'lion', 'wolf', 'rat'] as const;
export type Beast = (typeof BEASTS)[number];

/** Обычная (0) … Призматическая (5). */
export type Tier = 0 | 1 | 2 | 3 | 4 | 5;
export const TIER_NAMES = ['Обычная', 'Магическая', 'Редкая', 'Легендарная', 'Величайшая', 'Призматическая'] as const;

export const MAMMOTH = 0;
export const LION = 1;
export const WOLF = 2;
export const RAT = 3;

export const LEGENDARY = 3;
export const SUPREME = 4;
export const PRISMATIC = 5;

/** Камер на кольце; 0 — допросная. */
export const CELLS = 16;
export const OFFICE = 0;

// ── орудия пыток (rules.md §7), порядок = номер бита в маске ────────────────

export const TOOL_IDS = [
  // обход и двери
  'forged', 'keys', 'dogtag', 'blacklist', 'fire', 'hook', 'shortchain', 'shackles', 'stake',
  // пожирание
  'whip', 'saw', 'collar', 'muzzle', 'revenge', 'cage', 'skewer', 'crown', 'maul', 'guillotine', 'ravenous',
  // замена
  'rope', 'pestle', 'scales', 'axe', 'maiden', 'scapegoat',
  // утро
  'tongs', 'claws', 'ironbox', 'coin', 'trap',
] as const;
export type ToolId = (typeof TOOL_IDS)[number];

/** Номер бита орудия: TOOL.forged === 0 … TOOL.trap === 30. */
export const TOOL = Object.fromEntries(TOOL_IDS.map((id, i) => [id, i])) as { readonly [K in ToolId]: number };

export const TOOL_NAMES: Record<ToolId, string> = {
  forged: 'Поддельный ключ',
  keys: 'Потерянная связка ключей',
  dogtag: 'Жетон каторжника',
  blacklist: 'Чёрный список экзекутора',
  fire: 'Раскалённое клеймо',
  hook: 'Крюк отбора',
  shortchain: 'Кандалы с короткой цепью',
  shackles: 'Кандалы с длинной цепью',
  stake: 'Столб для сожжения',
  whip: 'Шипастая железная плеть',
  saw: 'Ржавая пила',
  collar: 'Шипастый ошейник безумного зверя',
  muzzle: 'Пыточный намордник',
  revenge: 'Железная дева мстителя',
  cage: 'Переполненная клетка зверей',
  skewer: 'Шампур крысиных голов: Огромная крыса',
  crown: 'Железная корона короля тюрьмы: Яростный лев',
  maul: 'Молот «Слоновья нога»: Мамонт',
  guillotine: 'Клыкастая гильотина: Альфа-волк',
  ravenous: 'Голодная удушающая цепь',
  rope: 'Висельная петля',
  pestle: 'Железный пест',
  scales: 'Весы тюремщика',
  axe: 'Палаческая секира надзирателя',
  maiden: 'Рассечённый саркофаг',
  scapegoat: 'Гильотина козла отпущения',
  tongs: 'Железные щипцы похоти: Мамонт',
  claws: 'Грязные когти: Альфа-волк',
  ironbox: 'Шевелящийся железный ящик: Огромная крыса',
  coin: 'Монета участи братьев',
  trap: 'Окровавленный капкан: Яростный лев',
};

// ── подарки сокровищницы (§9) ───────────────────────────────────────────────

export const GIFT_IDS = ['ring', 'horn', 'wine', 'brand'] as const;
export type GiftId = (typeof GIFT_IDS)[number];
export const GIFT = Object.fromEntries(GIFT_IDS.map((id, i) => [id, i])) as { readonly [K in GiftId]: number };

// ── события (§8) ────────────────────────────────────────────────────────────

export const EVENT_IDS = [
  'chain', // Цепная реакция
  'execution', // Казнь
  'behind', // Закулисные махинации
  'appetite', // Зверский аппетит
  'convict', // Каторжник
  'raven', // Шёпот ворона
  'freedom', // Вкус свободы
  'usurp1', // Узурпация I
  'usurp2',
  'usurp3',
  'usurp4',
  'ratway', // Крысиная тропа
  'treasure', // Поиск «сокровищ»
  'rival', // Заклятый враг
  'luck', // Делим удачу
  'escort', // Этапирование сообщников
  'extra', // Добавка
] as const;
export type EventId = (typeof EVENT_IDS)[number];
export const EVENT = Object.fromEntries(EVENT_IDS.map((id, i) => [id, i])) as { readonly [K in EventId]: number };

/** События, которые выпадают за дверью и от «Подстрекнуть». Узурпация II–IV — только по цепочке. */
export const EVENT_POOL: readonly EventId[] = [
  'chain', 'execution', 'behind', 'appetite', 'convict', 'raven', 'freedom', 'usurp1', 'ratway', 'treasure',
  'rival', 'luck', 'escort', 'extra',
];

// ── цели и стартовые события (§10) ──────────────────────────────────────────

export const OBJECTIVE_IDS = [
  'apex', // Загнанный зверь-царь
  'jungle', // Закон джунглей
  'doors', // За дверью камеры
  'walk', // Путь обхода тюрьмы
  'currents', // Скрытые волнения
] as const;
export type ObjectiveId = (typeof OBJECTIVE_IDS)[number];
export const OBJECTIVE = Object.fromEntries(OBJECTIVE_IDS.map((id, i) => [id, i])) as {
  readonly [K in ObjectiveId]: number;
};

export const START_EVENT_IDS = [
  'none',
  'cagefight', // Бой в клетке
  'ironlaw', // Железный закон
  'tyranny', // Тирания
  'abundance', // Изобилие
] as const;
export type StartEventId = (typeof START_EVENT_IDS)[number];
export const START_EVENT = Object.fromEntries(START_EVENT_IDS.map((id, i) => [id, i])) as {
  readonly [K in StartEventId]: number;
};

// ── ходы ────────────────────────────────────────────────────────────────────

export type Action =
  | { type: 'patrol'; cell: number }
  | { type: 'devour'; to: number }
  | { type: 'chain'; to: number }
  | { type: 'stopchain' }
  | { type: 'swap' }
  | { type: 'end' }
  /** «Выслеживание» (Окровавленный капкан): лев в камере надзирателя метит добычу. */
  | { type: 'hunt'; to: number }
  | { type: 'office'; choice: 'bestow' | 'instigate' }
  | { type: 'event'; accept: boolean }
  | { type: 'choose'; id: ToolId | GiftId }
  | { type: 'reroll' };

// ── параметры правил ────────────────────────────────────────────────────────

/** Доли по редкостям 0…5. */
export type TierOdds = readonly [number, number, number, number, number, number];

export interface Params {
  /** Дней в забеге; «Железный закон» — ironLawDays. */
  days: number;
  ironLawDays: number;
  /** Мест в хранилище призматических. */
  storage: number;
  /** Обновлений выбора орудий на забег: счётчик общий на забег (tlidb «Осталось раз»). */
  rerolls: number;
  /** Кто за дверью. [замер, 7 191 дверь] */
  doorOdds: TierOdds;
  /** Новый узник при замене. [замер, 696 замен] */
  replaceOdds: TierOdds;
  /** Пунктов назначения утром. */
  doorCards: number;
  /** Утром без «минус-карточных» орудий карточек на одну меньше. [замер, 8 592 утра] */
  oneLessDoor: number;
  /** Карточки — среди шагов 1…doorReach вперёд. [замер] */
  doorReach: number;
  /** Событие за дверью в начале забега. [замер, 10 370 дверей] */
  doorEvent: number;
  /** Событие за дверью, которая снова заперлась. [догадка: как в первый день] */
  relockEvent: number;
  /** «Закон джунглей» считает каждое Пожирание, укус цепочки тоже (карты зовут его «цепным Пожиранием»). */
  jungleCountsBites: boolean;
  /** После выполнения цели выпадает следующая (другая случайная). [догадка] */
  objectiveRepeat: boolean;
  /** Сколько нужно для цели. */
  objectiveTarget: Readonly<Record<ObjectiveId, number>>;
  /** «Тирания»: дополнительных выборов в допросной за визит. [догадка] */
  tyrannyExtra: number;
  /** «Изобилие»: подарков после каждого призматического. [факт] */
  abundanceGifts: number;

  // орудия обхода и дверей
  forgedChance: number;
  /** На карте 80 %, в замерах 63 % (199 случаев). */
  keysChance: number;
  dogtagChance: number;
  blacklistLocked: number;
  blacklistCount: number;
  fireChance: number;
  shortchainSteps: number;
  shortchainChance: number;
  shacklesSteps: number;
  shacklesChance: number;
  stakeChance: number;

  // пожирание
  whipChance: number;
  sawChance: number;
  collarChance: number;
  muzzleLeft: number;
  muzzleBonus: number;
  revengeChance: number;
  cageChance: number;
  /**
   * «Подавление» (tlidb): за каждый ранг разницы редкостей шанс повышения −5 %.
   * Применяется к укусу узника ниже едока (Гильотина, «Бой в клетке»). [догадка: к чему относится]
   */
  oppressStep: number;
  /** Добавка к укусу крысы с «Шампуром». */
  skewerBonus: number;
  /** Добавка к укусу льва с «Короной», как у «Шампура»: итого +1 + crownBonus. [догадка] */
  crownBonus: number;
  ravenousChance: number;

  // замена
  scalesChance: number;
  axeOpens: number;
  maidenBonus: number;
  scapegoatRemoves: number;

  // утро
  tongsTargets: number;
  /** Укус волка в камеру с Царапинами: обычный +1 и ещё +2 (tlidb «Царапины»). */
  clawsGain: number;
  ironboxDays: number;
  /** Гнездо открывается Редкой крысой (tlidb «Крысиное гнездо»). */
  ironboxTier: number;
  coinChance: number;
  coinBonus: number;
  /** Метка «Добыча» длится 3 хода (tlidb). */
  trapMornings: number;

  // события
  appetiteTries: number;
  appetiteChance: number;
  ravenCells: number;
  freedomOpens: number;
  /** Узурпация I…IV: прирост случайного узника. [I, II — карта; III, IV — догадка по ряду] */
  usurpGain: readonly [number, number, number, number];
  /** «Добавка»: до стольких случайных узников +1. */
  extraCount: number;

  // подарки
  ringOpens: number;
  brandCount: number;

  // допросная
  /** «Подстрекнуть»: событий за запертые двери без события (tlidb: одно). */
  instigateDoors: number;
}

const defaults: Params = {
  days: 20,
  ironLawDays: 30,
  storage: 10,
  rerolls: 1,
  doorOdds: [0.418, 0.359, 0.114, 0.092, 0.018, 0],
  replaceOdds: [0.422, 0.333, 0.145, 0.073, 0.023, 0.003],
  doorCards: 3,
  oneLessDoor: 0.169,
  doorReach: 6,
  doorEvent: 0.064,
  relockEvent: 0.064,
  jungleCountsBites: true,
  objectiveRepeat: true,
  objectiveTarget: { apex: 1, jungle: 4, doors: 10, walk: 18, currents: 2 },
  tyrannyExtra: 3,
  abundanceGifts: 3,

  forgedChance: 0.5,
  keysChance: 0.8,
  dogtagChance: 0.25,
  blacklistLocked: 5,
  blacklistCount: 2,
  fireChance: 0.35,
  shortchainSteps: 3,
  shortchainChance: 0.5,
  shacklesSteps: 4,
  shacklesChance: 0.4,
  stakeChance: 0.4,

  whipChance: 0.35,
  sawChance: 0.25,
  collarChance: 0.8,
  muzzleLeft: 4,
  muzzleBonus: 2,
  revengeChance: 0.3,
  cageChance: 0.4,
  oppressStep: 0.05,
  skewerBonus: 1,
  crownBonus: 2,
  ravenousChance: 0.4,

  scalesChance: 0.8,
  axeOpens: 2,
  maidenBonus: 3,
  scapegoatRemoves: 2,

  tongsTargets: 4,
  clawsGain: 3,
  ironboxDays: 2,
  ironboxTier: 2,
  coinChance: 0.6,
  coinBonus: 2,
  trapMornings: 3,

  appetiteTries: 5,
  appetiteChance: 0.5,
  ravenCells: 4,
  freedomOpens: 3,
  usurpGain: [1, 2, 3, 4],
  extraCount: 3,

  ringOpens: 3,
  brandCount: 4,

  instigateDoors: 1,
};

export const DEFAULT_PARAMS: Readonly<Params> = Object.freeze(defaults);
