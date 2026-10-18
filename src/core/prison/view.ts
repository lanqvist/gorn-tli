/**
 * Что распознано на экране тюрьмы — договор между распознаванием
 * (`recognize/`) и остальным симулятором. Описан в docs/prison/architecture.md.
 *
 * Номера камер внутри — 0–15: 0 — допросная. Игроку показываем +1.
 *
 * `Beast`, `Tier`, `ToolId`, `GiftId` — общие имена с движком (этап A);
 * при слиянии их сведут в model.ts.
 */

export type Beast = 'mammoth' | 'lion' | 'wolf' | 'rat';
/** Обычная (0), Магическая, Редкая, Легендарная, Величайшая, Призматическая (5). */
export type Tier = 0 | 1 | 2 | 3 | 4 | 5;

/** Орудия пыток, rules.md §7. */
export const TOOL_IDS = [
  // обход и двери
  'forged',
  'keys',
  'dogtag',
  'blacklist',
  'fire',
  'hook',
  'shortchain',
  'shackles',
  'stake',
  // пожирание
  'whip',
  'saw',
  'collar',
  'muzzle',
  'revenge',
  'cage',
  'skewer',
  'crown',
  'maul',
  'guillotine',
  'ravenous',
  // замена
  'rope',
  'pestle',
  'scales',
  'axe',
  'maiden',
  'scapegoat',
  // утро
  'tongs',
  'claws',
  'ironbox',
  'coin',
  'trap',
] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export type GiftId = 'ring' | 'horn' | 'wine' | 'brand';

export interface CellView {
  kind: 'office' | 'locked' | 'empty' | 'inmate';
  beast?: Beast;
  tier?: Tier;
  /** «!» — событие в камере. */
  event?: boolean;
  nest?: boolean;
  /**
   * Клыки: на экране цепочки — цель пожирания; на остальных экранах доски —
   * красные клыки над портретом.
   */
  jaws?: boolean;
  /** Редкость видна на запертой двери (портрет «?» со свечением). */
  shownTier?: Tier;
  /**
   * Редкость не видна: рамка тёмная, без серебра и свечения (после
   * переподключения игра рисует так прежних узников; так же на затемнённых
   * переходах). tier тогда 0, но верить ему нельзя.
   */
  tierUnknown?: boolean;
}

/** Прямоугольник в пикселях кадра. */
export type Box = [x0: number, y0: number, x1: number, y1: number];

export interface BoardView {
  cells: CellView[]; // 16
  warden: number | null;
  /** null — не видно (экран цепочки) или не прочитано. */
  daysLeft: number | null;
  /** Предложенные камеры, в порядке карточек; допросная — 0. */
  doors: number[];
  decision:
    | null
    | { kind: 'manage'; consume: boolean; replace: boolean; end: boolean; hunt?: boolean }
    | { kind: 'office' }
    | { kind: 'ratway' } // «Выберите цель»: крысиная тропа или добыча «Выслеживания»
    | { kind: 'event' }; // окно события
  /** «Выберите узника для пожирания». */
  chain: { targets: number[] } | null;
  /** На экране цепочки панель скрыта — пусто. */
  tools: ToolId[];
  /**
   * Места панели орудий: орудие или null — иконка без эталона. Нет поля —
   * панели не видно.
   */
  toolSlots?: (ToolId | null)[];
  /** Призматических в хранилище; −1 — панель не видна (экран цепочки). */
  chromatic: number;
  /** doors | jungle | beastking | walk | currents; null — не видно или не узнана. */
  objective: string | null;
  /** Где рисовать метки. */
  at: {
    cells: { x: number; y: number; r: number }[];
    doorCards: Box[];
    decisionCards: Box[];
    /** Вид каждой карточки ряда решений (consume, replace, hunt, end, bestow, instigate), в порядке decisionCards. */
    decisionKinds?: string[];
    cancel: Box | null;
  };
}

export interface PickView {
  cards: (ToolId | null)[];
  boxes: Box[];
  /** Есть кнопка «Обновить». */
  reroll: boolean;
  /** Выбор в награду за цель (а не в начале забега). */
  reward: boolean;
}

export type ScreenView =
  | { screen: 'board'; board: BoardView }
  | { screen: 'pick'; pick: PickView }
  | { screen: 'treasure'; gifts: Box[] }
  | { screen: 'other' };
