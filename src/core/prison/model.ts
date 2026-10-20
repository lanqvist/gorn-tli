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
  muzzle: 'Пыточный намордник бешеного зверя',
  revenge: 'Железная дева мстителя',
  cage: 'Переполненная клетка зверей',
  skewer: 'Шампур крысиных голов: Огромная крыса',
  crown: 'Железная корона короля тюрьмы: Яростный лев',
  maul: 'Молот Слоновья нога: Слон',
  guillotine: 'Гильотина с волчьими клыками: Вожак',
  ravenous: 'Голодная удушающая цепь лютого зверя',
  rope: 'Висельная петля',
  pestle: 'Железный пест',
  scales: 'Весы тюремщика',
  axe: 'Палаческая секира надзирателя',
  maiden: 'Рассечённый саркофаг',
  scapegoat: 'Гильотина козла отпущения',
  tongs: 'Клещи порока: Слон',
  claws: 'Грязный железный коготь: Вожак',
  ironbox: 'Кишащий железный ящик: Огромная крыса',
  coin: 'Монета участи братьев',
  trap: 'Окровавленный капкан: Яростный лев',
};

/** ID орудия в клиенте игры (таблица relic, docs/prison/client-datamining.md). */
export const TOOL_CLIENT_ID: Record<ToolId, number> = {
  muzzle: 101, ravenous: 102, collar: 103, revenge: 104, cage: 105, whip: 106, saw: 107,
  blacklist: 111, keys: 112, coin: 113, fire: 114, dogtag: 115, forged: 116, hook: 117,
  scapegoat: 121, axe: 122, maiden: 123, scales: 124, rope: 125, stake: 126, pestle: 127,
  shortchain: 131, shackles: 132,
  tongs: 141, maul: 142, trap: 143, crown: 144, claws: 145, guillotine: 146, ironbox: 147, skewer: 148,
};

// ── подарки сокровищницы (§9) ───────────────────────────────────────────────

export const GIFT_IDS = ['ring', 'horn', 'wine', 'brand'] as const;
export type GiftId = (typeof GIFT_IDS)[number];
export const GIFT = Object.fromEntries(GIFT_IDS.map((id, i) => [id, i])) as { readonly [K in GiftId]: number };

/** ID подарка в клиенте (таблица colored_reward). */
export const GIFT_CLIENT_ID: Record<GiftId, number> = { ring: 1, horn: 2, wine: 3, brand: 4 };

// ── события (§8) ────────────────────────────────────────────────────────────

export const EVENT_IDS = [
  'chain', // Цепная реакция
  'execution', // Эффективность казни
  'behind', // Закулисные махинации
  'appetite', // Зверский аппетит
  'convict', // Каторжник
  'raven', // Шёпот ворона
  'freedom', // Вкус свободы
  'usurp1', // Узурпация I
  'usurp2',
  'usurp3',
  'usurp4',
  'ratway', // Крысиный ход в стоках
  'treasure', // Поиск «сокровищ»
  'rival', // Заклятый враг
  'luck', // Делим удачу
  'escort', // Этапирование сообщников
  'extra', // Добавка
] as const;
export type EventId = (typeof EVENT_IDS)[number];
export const EVENT = Object.fromEntries(EVENT_IDS.map((id, i) => [id, i])) as { readonly [K in EventId]: number };

/** ID события в клиенте (таблица event). */
export const EVENT_CLIENT_ID: Record<EventId, number> = {
  convict: 201, freedom: 202, behind: 203, appetite: 211, extra: 212, luck: 213, rival: 221, execution: 222,
  raven: 231, treasure: 232, ratway: 241, chain: 242, escort: 251, usurp1: 252, usurp2: 253, usurp3: 254, usurp4: 255,
};

/** Постоянная часть пула событий. Узурпация — одна текущая ступень, её держит состояние (клиент 252–255). */
export const EVENT_POOL: readonly EventId[] = [
  'chain', 'execution', 'behind', 'appetite', 'convict', 'raven', 'freedom', 'ratway', 'treasure',
  'rival', 'luck', 'escort', 'extra',
];

// ── цели и стартовые события (§10) ──────────────────────────────────────────

/** Порядок здесь свой; ID цели в клиенте (таблица task): apex 1, jungle 2, doors 3, currents 4, walk 5. */
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

/** Особые темы забега (клиент 301–304; шанс темы за забег 12 %, клиент 161). */
export const START_EVENT_IDS = [
  'none',
  'cagefight', // 304 Схватка узников
  'ironlaw', // 303 Железный закон
  'tyranny', // 301 Злоупотребление властью
  'abundance', // 302 Расточительность
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

/**
 * Числа правил. Источник у каждого: «клиент N» — ID записи в клиенте игры
 * (docs/prison/client-datamining.md; тексты и числовой конфиг), [замер] —
 * свои забеги, [догадка] — не найдено ни в клиенте, ни в замерах.
 */
export interface Params {
  /** Дней в забеге (20); «Железный закон» (клиент 303) — 30. */
  days: number;
  ironLawDays: number;
  /** Мест в хранилище призматических (клиент config 114 = 10). */
  storage: number;
  /** Обновлений выбора орудий на забег; счётчик общий на забег (глоссарий 16000106). [догадка: базовое 1 — по кадрам] */
  rerolls: number;
  /** Кто за дверью. [замер, 7 191 дверь; в клиенте не найдено] */
  doorOdds: TierOdds;
  /** Новый узник при замене. [замер, 696 замен; в клиенте не найдено] */
  replaceOdds: TierOdds;
  /** Пунктов назначения утром (клиент config 305 = 3 кандидата броска). */
  doorCards: number;
  /**
   * Утром без «минус-карточных» орудий карточек на одну меньше. По своим кадрам
   * 0: три разных шага в 548 утрах из 549 [замер 19.10, 29 забегов]; прежний
   * замер «16,9 % из 8 592 утр» не подтвердился. Оставлен ручкой для сверки.
   */
  oneLessDoor: number;
  /** Карточки — среди шагов 1…doorReach (клиент config 306–307: бросок 1–6). */
  doorReach: number;
  /** Камер, открытых в начале забега (клиент config 309 = 4; на своих кадрах первого дня — 4). */
  startOpen: number;
  /**
   * Меток событий на поле не меньше (клиент config 310 = 1). Добираются сразу,
   * как сработала последняя, не утром [замер: лог, 125 меток из 127 — сразу
   * после окна события; кадры, 206 доборов].
   */
  eventMin: number;
  /** Событие за каждой запертой дверью в начале забега сверх минимума. [догадка: 0 — хватает eventMin] */
  doorEvent: number;
  /** Событие за дверью, которая снова заперлась. [догадка: 0 — хватает eventMin] */
  relockEvent: number;
  /** «Закон джунглей» (клиент task 2) считает каждое Пожирание, укус цепочки тоже. [догадка по тексту 103] */
  jungleCountsBites: boolean;
  /**
   * После выполнения цели выпадает следующая (другая случайная). В игре —
   * нет: одна цель и одна награда за забег (логи 17–18.10: 25 забегов из 25,
   * клиент — цели только в состоянии начала забега, изменения «новая цель»
   * в протоколе нет). Параметр оставлен для опытов.
   */
  objectiveRepeat: boolean;
  /** Сколько нужно для цели (клиент task 1–5). */
  objectiveTarget: Readonly<Record<ObjectiveId, number>>;
  /** «Злоупотребление властью» (клиент 301): автоматических Подстрекнуть и Наградить за остановку в допросной. */
  tyrannyExtra: number;
  /** «Расточительность» (клиент 302): выборов сокровища за призматического, 1 + 2. */
  abundanceGifts: number;

  // орудия обхода и дверей (клиент 111–117, 126, 131–132)
  forgedChance: number;
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

  // пожирание (клиент 101–107, 142, 144, 146, 148)
  whipChance: number;
  sawChance: number;
  collarChance: number;
  /** Намордник (101): +muzzleBonus, если до укуса на поле не больше muzzleLeft узников (с едоком и жертвой). [кадры 18.10] */
  muzzleLeft: number;
  muzzleBonus: number;
  revengeChance: number;
  cageChance: number;
  /**
   * «Подавление» (глоссарий 16000117): за каждый ранг разницы шанс повышения −5 %.
   * Срабатывает после поедания Гильотиной (клиент 146). [догадка: от базового 100 %]
   */
  oppressStep: number;
  /** Шампур (клиент 148): крыса, съевшая крысу, дополнительно +2; за другую еду — нет. [кадры 18.10] */
  skewerBonus: number;
  /** Корона (клиент 144): лев после Пожирания дополнительно +2. */
  crownBonus: number;
  ravenousChance: number;

  // замена (клиент 121–127)
  scalesChance: number;
  axeOpens: number;
  maidenBonus: number;
  scapegoatRemoves: number;

  // утро и метки (клиент 102, 113, 141, 143, 145, 147; глоссарий)
  tongsTargets: number;
  /** Укус волка в камеру с Царапинами: обычный +1 и ещё +2 (глоссарий «Царапины»). */
  clawsGain: number;
  ironboxDays: number;
  /** Гнездо открывается Редкой крысой (глоссарий «Крысиное гнездо»). */
  ironboxTier: number;
  coinChance: number;
  coinBonus: number;
  /** Метка «Добыча» длится 3 хода (глоссарий). */
  trapMornings: number;

  // события (клиент 201–255)
  appetiteTries: number;
  appetiteChance: number;
  ravenCells: number;
  freedomOpens: number;
  /**
   * Вес текущей ступени Узурпации II–IV в пуле. Базовый Weight у 253–255 — 0,
   * у 252 — 10; как следующая ступень получает вес — не найдено. [допущение: 10, как у I]
   */
  usurpNextWeight: number;
  /** Узурпация I…IV (клиент 252–255): сколько случайных узников (−1 — все) и на сколько. */
  usurpCount: readonly [number, number, number, number];
  usurpGain: readonly [number, number, number, number];
  /** «Добавка» (клиент 212): до стольких случайных узников +1. */
  extraCount: number;

  // подарки (клиент colored_reward 1–4)
  ringOpens: number;
  brandCount: number;

  // допросная
  /** «Подстрекнуть»: событий за визит (глоссарий 16000108; игрок). [догадка: только за запертые двери] */
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
  oneLessDoor: 0,
  doorReach: 6,
  startOpen: 4,
  eventMin: 1,
  doorEvent: 0,
  relockEvent: 0,
  jungleCountsBites: true,
  objectiveRepeat: false,
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
  skewerBonus: 2,
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
  usurpNextWeight: 10,
  usurpCount: [1, 1, 2, -1],
  usurpGain: [1, 2, 2, 2],
  extraCount: 3,

  ringOpens: 3,
  brandCount: 4,

  instigateDoors: 1,
};

export const DEFAULT_PARAMS: Readonly<Params> = Object.freeze(defaults);
