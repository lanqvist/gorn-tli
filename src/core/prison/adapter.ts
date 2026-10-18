/**
 * Адаптер: экраны тюрьмы (ScreenView) и память забега между кадрами →
 * позиция движка для совета.
 *
 * Один кадр видит не всё: орудия (на экране цепочки панель скрыта), цель,
 * сколько дней в забеге, хранилище, что было на доске до затемнения
 * цепочки, сколько подарков подряд. Это хранит память забега — обычный
 * JSON, переживает перезапуск Горна (сохраняется через ответ 'state').
 *
 * Чего игрок не видит, адаптер не выдумывает: узники за дверями не
 * закреплены (кроме показанной редкости), вид события за «!» неизвестен —
 * решатель перебрасывает это на каждом раунде.
 */

import {
  BEASTS, CELLS, DEFAULT_PARAMS, EVENT, GIFT_IDS, OBJECTIVE, OFFICE, START_EVENT, SUPREME, TOOL, TOOL_IDS, type Action,
  type ObjectiveId, type Params, type StartEventId, type ToolId,
} from './model.js';
import type { ShotCause } from '../prisonTriggers.js';
import type { BoardView, PickView } from './view.js';
import {
  A_DEVOUR, A_END, A_HUNT, A_SWAP, legalCodes,
} from './engine/actions.js';
import { Rng } from './engine/rng.js';
import { newRun, officeRounds, targets } from './engine/rules.js';
import {
  BEAST, CHAIN_EATER, DAY, DAY_LIMIT, DOORS, DOORS_N, EVT, FLAGS, F_SCRATCH, F_VIS_TIER, HUNT_LION, HUNT_PREY, LOCK,
  NEST, NEXT, OBJECTIVE_ID, OFFER, OFFER_GIFT, OFFER_KIND, OFFER_N, OFFER_TOOL, OFFICE_LEFT, PHASE, PICK_GIFTS,
  PICK_TOOLS, PRE_BEAST, PRE_TIER, P_CHAIN, P_DAYEND, P_MANAGE, P_OFFICE, P_PATROL, P_PICK, P_RATWAY, REROLLS, START,
  STORAGE, State, TIER, TOOLS, USED, USED_DEVOUR, USURP, WARDEN,
} from './engine/state.js';

// ── память забега ───────────────────────────────────────────────────────────

/** Что ждём от игрока по последнему понятому экрану. */
/** hunt — «Выберите цель» после «Выслеживания»: добыча для льва надзирателя. */
export type Step = 'patrol' | 'manage' | 'office' | 'ratway' | 'hunt' | 'chain' | 'pick' | 'gift' | 'wait';

export interface CellMemory {
  k: 'office' | 'locked' | 'empty' | 'inmate';
  /** Зверь 0…3 (BEASTS). */
  b?: number;
  t?: number;
  /** «!» — событие. */
  ev?: boolean;
  nest?: boolean;
  /** День, когда гнездо увидели впервые: от него — срок вылупления. */
  nestDay?: number;
  /** Показанная редкость за дверью. */
  shown?: number;
}

export interface RunMemory {
  v: 1;
  cells: CellMemory[];
  warden: number;
  /** День с нуля и дней в забеге. */
  day: number;
  dayLimit: number;
  tools: ToolId[];
  objective: ObjectiveId | null;
  start: StartEventId;
  storage: number;
  step: Step;
  doors: number[];
  /** Карточки ряда решений; null — ряда не было. */
  decision: { consume: boolean; replace: boolean; end: boolean; hunt?: boolean } | null;
  /** Подсвеченные цели на экране цепочки. */
  chainTargets: number[];
  /**
   * Экран «Выберите узника для пожирания» до первого укуса: это ещё выбор
   * Пожирания, «Отменить» возвращает к ряду решений (а не завершает день).
   */
  firstBite: boolean;
  offer: ToolId[];
  rerolls: number;
  /** Сколько подарков подряд ещё выбрать. */
  gifts: number;
  /** Выбор орудия в начале забега: доски за ним ещё не было. */
  runStart: boolean;
  /** Тему забега увидели, а доски нового забега ещё не было (выбор орудий её не сбросит). */
  themeFresh: boolean;
  /**
   * Последний выбор орудий, ещё не подтверждённый доской: карты и
   * посоветованная. На следующей доске с панелью орудие из выбора либо
   * узнаётся на панели, либо считается взятым посоветованное.
   */
  pickOffer: ToolId[];
  pickAdvised: ToolId | null;
  /** Орудия, взятые «предположительно» (иконка на панели не узнана): с картами своего выбора. */
  assumed: { tool: ToolId; offer: ToolId[] }[];
  /**
   * Что было до выбора орудия в награду или до сокровищницы — куда забег
   * вернётся после выбора (иначе решатель прибавит или отнимет действие дня).
   */
  resume: Step;
  /**
   * Что привело к сокровищнице или выбору: Замена, Пожирание, утро (после
   * выбора — обход этого дня) или иное.
   */
  resumeAfter: ShotCause;
  /** Хранилище к началу дня: утренний Призматический в нём уже есть, даже если экран отстал. */
  dayStorage: number;
  /** Нижняя граница хранилища: в забеге оно только растёт. */
  storageFloor: number;
  /**
   * Орудия, которые панель показала один раз, а выбора с ними не было:
   * засчитываются со второго кадра подряд (пустая ячейка в окне подарка
   * однажды читалась как «Плеть» и висела в памяти до конца забега).
   */
  toolSightings: ToolId[];
}

const lockedCell = (): CellMemory => ({ k: 'locked' });

export function blankMemory(): RunMemory {
  return {
    v: 1,
    cells: Array.from({ length: CELLS }, (_, c) => (c === OFFICE ? { k: 'office' } : lockedCell())),
    warden: OFFICE,
    day: 0,
    dayLimit: DEFAULT_PARAMS.days,
    tools: [],
    objective: null,
    start: 'none',
    storage: 0,
    step: 'patrol',
    doors: [],
    decision: null,
    chainTargets: [],
    firstBite: false,
    offer: [],
    rerolls: 0,
    gifts: 0,
    runStart: false,
    themeFresh: false,
    pickOffer: [],
    pickAdvised: null,
    assumed: [],
    resume: 'patrol',
    resumeAfter: '',
    dayStorage: 0,
    storageFloor: 0,
    toolSightings: [],
  };
}

const isInt = (x: unknown, lo: number, hi: number): x is number => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;

/** Память из сохранения; испорченное — чистый забег. */
export function loadMemory(x: unknown): RunMemory {
  const base = blankMemory();
  if (!x || typeof x !== 'object') return base;
  const m = x as Partial<RunMemory>;
  if (m.v !== 1 || !Array.isArray(m.cells) || m.cells.length !== CELLS) return base;
  const cells = m.cells.map((c, i): CellMemory => {
    if (i === OFFICE) return { k: 'office' };
    if (!c || typeof c !== 'object') return lockedCell();
    if (c.k === 'inmate' && isInt(c.b, 0, 3) && isInt(c.t, 0, SUPREME)) return { k: 'inmate', b: c.b, t: c.t, ...(c.ev ? { ev: true } : {}) };
    if (c.k === 'empty') return { k: 'empty' };
    const out: CellMemory = lockedCell();
    if (c.ev) out.ev = true;
    if (c.nest) out.nest = true;
    if (c.nest && isInt(c.nestDay, 0, 29)) out.nestDay = c.nestDay;
    if (isInt(c.shown, 0, SUPREME)) out.shown = c.shown;
    return out;
  });
  const steps: Step[] = ['patrol', 'manage', 'office', 'ratway', 'hunt', 'chain', 'pick', 'gift', 'wait'];
  const tools = (TOOL_IDS as readonly string[]);
  const cellList = (a: unknown) => (Array.isArray(a) ? a.filter((n) => isInt(n, 0, CELLS - 1)) : []);
  return {
    ...base,
    cells,
    warden: isInt(m.warden, 0, CELLS - 1) ? m.warden : OFFICE,
    dayLimit: m.dayLimit === 30 ? 30 : DEFAULT_PARAMS.days,
    day: isInt(m.day, 0, 29) ? m.day : 0,
    tools: Array.isArray(m.tools) ? (m.tools.filter((t) => tools.includes(t)) as ToolId[]) : [],
    objective: m.objective && m.objective in OBJECTIVE ? m.objective : null,
    start: m.start && m.start in START_EVENT ? m.start : 'none',
    storage: isInt(m.storage, 0, 99) ? m.storage : 0,
    step: m.step && steps.includes(m.step) ? m.step : 'patrol',
    doors: cellList(m.doors),
    decision: m.decision && typeof m.decision === 'object'
      ? { consume: !!m.decision.consume, replace: !!m.decision.replace, end: !!m.decision.end, ...(m.decision.hunt ? { hunt: true } : {}) }
      : null,
    chainTargets: cellList(m.chainTargets),
    firstBite: !!m.firstBite,
    offer: Array.isArray(m.offer) ? (m.offer.filter((t) => tools.includes(t)) as ToolId[]) : [],
    rerolls: isInt(m.rerolls, 0, 9) ? m.rerolls : 0,
    gifts: isInt(m.gifts, 0, 30) ? m.gifts : 0,
    runStart: !!m.runStart,
    themeFresh: !!m.themeFresh,
    pickOffer: Array.isArray(m.pickOffer) ? (m.pickOffer.filter((t) => tools.includes(t)) as ToolId[]) : [],
    pickAdvised: m.pickAdvised && tools.includes(m.pickAdvised) ? m.pickAdvised : null,
    assumed: Array.isArray(m.assumed)
      ? m.assumed
          .filter((a) => a && tools.includes(a.tool) && Array.isArray(a.offer))
          .map((a) => ({ tool: a.tool, offer: a.offer.filter((t) => tools.includes(t)) as ToolId[] }))
      : [],
    resume: m.resume && steps.includes(m.resume) ? m.resume : 'patrol',
    resumeAfter: m.resumeAfter === 'swap' || m.resumeAfter === 'consume' || m.resumeAfter === 'morning' ? m.resumeAfter : '',
    dayStorage: isInt(m.dayStorage, 0, 99) ? m.dayStorage : 0,
    storageFloor: isInt(m.storageFloor, 0, 99) ? m.storageFloor : 0,
    toolSightings: Array.isArray(m.toolSightings) ? (m.toolSightings.filter((t) => tools.includes(t)) as ToolId[]) : [],
  };
}

/** Цель с панели распознавания → цель движка. */
const OBJECTIVE_FROM_VIEW: Record<string, ObjectiveId> = {
  beastking: 'apex', apex: 'apex', jungle: 'jungle', doors: 'doors', walk: 'walk', currents: 'currents',
};

/**
 * Тема забега по номеру озвучки окна темы («Play_VO_Story_S16_Special_0N»).
 * Клиент: THEME_DIALOGUE_MAP 301…304 → реплики 160005…160008 подряд,
 * озвучек темы ровно четыре. 01 = «Злоупотребление властью» — по живому
 * забегу; 02–04 — по порядку реплик, сверить по забегам.
 */
export const THEME_BY_VOICE: Readonly<Record<number, StartEventId>> = { 1: 'tyranny', 2: 'abundance', 3: 'ironlaw', 4: 'cagefight' };

const beastNo = (b: string | undefined): number => Math.max(0, BEASTS.indexOf((b ?? 'mammoth') as (typeof BEASTS)[number]));

// ── позиция для совета ──────────────────────────────────────────────────────

export type Position =
  | {
      ok: true;
      state: State;
      /** Можно ли этот ход на экране (карточки ряда решений). */
      allowed: (code: number) => boolean;
    }
  | {
      ok: false;
      problem: string;
      /** Совет без расчёта, когда модель не сходится с экраном (цепочка). */
      fallback?: Action;
    };

export class PrisonAdapter {
  mem: RunMemory;
  /** День этого кадра взят из лога — экранный не нужен. */
  private dayFromLog = false;

  constructor(saved?: unknown, private readonly p: Readonly<Params> = DEFAULT_PARAMS) {
    this.mem = loadMemory(saved);
  }

  reset(): void {
    this.mem = blankMemory();
  }

  /** Доска со строкой дней, панелями и рядом карточек (или экран цепочки). */
  board(v: BoardView): void {
    const m = this.mem;
    // День — по логу, если он есть (экран на последнем дне «осталось 0» не читается).
    if (v.daysLeft !== null && !this.dayFromLog) {
      if (v.daysLeft > m.dayLimit) {
        // Больше 20 дней осталось — забег «Железного закона».
        m.dayLimit = this.p.ironLawDays;
        if (m.start === 'none') m.start = 'ironlaw';
      }
      // «Осталось N» в день номер cur (с единицы) — это лимит − cur (замер по
      // строкам «check cur=…» рядом с кадрами): день с нуля — лимит − N − 1.
      m.day = Math.max(0, Math.min(m.dayLimit - 1, m.dayLimit - v.daysLeft - 1));
    }
    this.panelTools(v);
    if (v.chromatic >= 0) m.storage = Math.max(v.chromatic, m.storageFloor);
    if (v.objective && OBJECTIVE_FROM_VIEW[v.objective]) m.objective = OBJECTIVE_FROM_VIEW[v.objective]!;
    m.runStart = false;
    m.themeFresh = false;
    m.offer = [];

    if (v.chain) {
      this.chainBoard(v);
      return;
    }
    m.firstBite = false;
    // Выбор добычи «Выслеживания»: доска та же, что в ряде решений, но
    // затемнена кроме целей — редкости с неё не перечитываем.
    const huntScreen = v.decision?.kind === 'ratway' && (m.step === 'hunt' || (m.step === 'manage' && !!m.decision?.hunt));
    v.cells.forEach((c, n) => {
      if (n === OFFICE || huntScreen) return;
      const was = m.cells[n]!;
      if (c.kind === 'inmate') {
        // Редкость не нарисована (после переподключения) — тот же узник в
        // этой камере сохраняет редкость из памяти.
        const b = beastNo(c.beast);
        const keep = c.tierUnknown && was.k === 'inmate' && was.b === b;
        const cell: CellMemory = { k: 'inmate', b, t: keep ? was.t! : Math.min(c.tier ?? 0, SUPREME) };
        if (c.event) cell.ev = true;
        m.cells[n] = cell;
      } else if (c.kind === 'locked') {
        const cell: CellMemory = lockedCell();
        if (c.event) cell.ev = true;
        if (c.nest) {
          cell.nest = true;
          cell.nestDay = was.k === 'locked' && was.nest && was.nestDay !== undefined ? was.nestDay : m.day;
        }
        const shown = c.shownTier ?? (was.k === 'locked' ? was.shown : undefined);
        if (shown !== undefined) cell.shown = Math.min(shown, SUPREME);
        m.cells[n] = cell;
      } else {
        m.cells[n] = { k: 'empty' };
      }
    });
    if (v.warden !== null) m.warden = v.warden;
    m.chainTargets = [];
    if (huntScreen) {
      // «Выберите цель» сразу после ряда с «Выслеживанием» — добыча, не крысиная тропа
      // (надпись та же). Ряд решений помним: «Отменить» вернёт к нему.
      m.step = 'hunt';
      m.doors = [];
    } else if (v.decision?.kind === 'ratway') {
      m.step = 'ratway';
      m.doors = [];
      m.decision = null;
    } else if (v.decision?.kind === 'office') {
      m.step = 'office';
      m.doors = [];
      m.decision = null;
    } else if (v.decision?.kind === 'manage') {
      m.step = 'manage';
      m.doors = [];
      m.decision = { consume: v.decision.consume, replace: v.decision.replace, end: v.decision.end, ...(v.decision.hunt ? { hunt: true } : {}) };
    } else if (v.doors.length) {
      m.step = 'patrol';
      m.doors = v.doors.filter((n) => n !== m.warden);
      m.decision = null;
    }
  }

  /**
   * Экран цепочки: доска затемнена, редкости читаются хуже. Едок только
   * растёт, съеденные запираются — остальное берём из доски до укуса.
   */
  private chainBoard(v: BoardView): void {
    const m = this.mem;
    const warden = v.warden ?? m.warden;
    const after = m.warden === warden && (m.step === 'manage' || m.step === 'chain');
    const walked = m.step === 'patrol' && m.doors.includes(warden);
    const known = after || walked;
    const was = m.cells[warden]!;
    let eaten = 0;
    v.cells.forEach((c, n) => {
      if (n === OFFICE || n === warden) return;
      const prev = m.cells[n]!;
      if (known) {
        // Съеденный за этот укус — заперт; остальные — как до укуса.
        if (c.kind === 'locked' && prev.k === 'inmate') {
          m.cells[n] = lockedCell();
          eaten++;
        }
        else if (c.kind === 'inmate' && prev.k !== 'inmate') m.cells[n] = { k: 'inmate', b: beastNo(c.beast), t: Math.min(c.tier ?? 0, SUPREME) };
        return;
      }
      if (c.kind === 'inmate') m.cells[n] = { k: 'inmate', b: beastNo(c.beast), t: Math.min(c.tier ?? 0, SUPREME) };
      else if (c.kind === 'locked') m.cells[n] = { ...lockedCell(), ...(c.event ? { ev: true } : {}) };
      else m.cells[n] = { k: 'empty' };
    });
    const eater = v.cells[warden];
    const prevTier = known && was.k === 'inmate' ? was.t! : 0;
    if (eater?.kind === 'inmate') {
      m.cells[warden] = { k: 'inmate', b: beastNo(eater.beast), t: Math.min(Math.max(eater.tier ?? 0, prevTier), SUPREME) };
    } else if (was.k !== 'inmate') {
      m.cells[warden] = { k: 'inmate', b: 0, t: prevTier };
    }
    const tier = m.cells[warden]!.t!;
    // Никого не съели, едок не вырос, а прошлый экран — ряд решений: это
    // выбор цели первого укуса. Тот же экран снова — остаётся, чем был.
    const unchanged = walked || (was.k === 'inmate' && eater?.kind === 'inmate' && was.t === (eater.tier ?? 0));
    m.firstBite = m.step === 'chain' ? m.firstBite && eaten === 0 : known && eaten === 0 && unchanged;
    // Подсвеченная цель той же редкости, что и едок (если орудие не меняет правило).
    for (const n of v.chain!.targets) {
      const c = m.cells[n]!;
      if (c.k === 'locked') continue; // сквозь дверь (Когти)
      const seen = v.cells[n];
      if (c.k === 'inmate' && c.t! <= tier && (!seen?.beast || c.b === beastNo(seen.beast))) continue;
      m.cells[n] = { k: 'inmate', b: seen?.beast ? beastNo(seen.beast) : (c.b ?? 0), t: tier };
    }
    m.warden = warden;
    m.step = 'chain';
    m.chainTargets = [...v.chain!.targets];
    m.doors = [];
    m.decision = null;
    // Портрет едока на тёмном экране читается и другим зверем: берём того,
    // кто ест все подсвеченные цели (прочитанный, прежний, любой).
    if (m.chainTargets.length) {
      const order = [m.cells[warden]!.b!, ...(was.k === 'inmate' ? [was.b!] : []), 0, 1, 2, 3];
      for (const b of order) {
        m.cells[warden]!.b = b;
        if (this.chainFits()) break;
      }
      if (!this.chainFits()) m.cells[warden]!.b = order[0]!;
    }
  }

  private chainFits(): boolean {
    const s = this.build();
    const mask = targets(s, this.mem.warden);
    return this.mem.chainTargets.every((n) => (mask >>> n) & 1);
  }

  /** Выбор орудий: в начале забега (fresh) или в награду за цель. */
  /** День по логу кадра; null — строки «check cur» не было (день — с экрана). */
  logDay(d: { cur: number; max: number } | null): void {
    this.dayFromLog = !!d && d.max > 0;
    if (!d || d.max <= 0) return;
    const m = this.mem;
    m.dayLimit = d.max;
    if (d.max === this.p.ironLawDays && m.start === 'none') m.start = 'ironlaw';
    // cur — номер дня с единицы; 0 — выбор орудий перед первым днём.
    const day = Math.max(0, Math.min(d.max - 1, d.cur - 1));
    if (day > m.day) m.dayStorage = m.storage;
    m.day = day;
  }

  /** Совет на выборе орудий: какое орудие посоветовано (для памяти, если панель его не узнает). */
  advised(tool: ToolId): void {
    this.mem.pickAdvised = tool;
  }

  /**
   * Орудия с панели. Узнанные — в память (и подтверждают «предположительные»);
   * после выбора на доске с панелью орудие из выбора либо узнано, либо
   * взято посоветованное — «предположительно», пока панель не подтвердит.
   */
  private panelTools(v: BoardView): void {
    const m = this.mem;
    if (!v.toolSlots && !v.tools.length) return;
    // Орудие из недавнего выбора — сразу; прочие — со второго кадра подряд.
    const offered = (t: ToolId) => m.pickOffer.includes(t) || m.assumed.some((a) => a.offer.includes(t));
    const seen = m.toolSightings;
    m.toolSightings = [];
    for (const t of v.tools) {
      if (m.tools.includes(t)) continue;
      if (!offered(t) && !seen.includes(t)) {
        m.toolSightings.push(t);
        continue;
      }
      // Панель узнала орудие, а «предположительно» записано другое из того же выбора — исправить.
      const wrong = m.assumed.find((a) => a.offer.includes(t) && a.tool !== t && !v.tools.includes(a.tool));
      if (wrong) {
        m.tools = m.tools.filter((x) => x !== wrong.tool);
        wrong.tool = t;
      }
      m.tools.push(t);
    }
    m.assumed = m.assumed.filter((a) => !v.tools.includes(a.tool));
    if (!v.toolSlots || !m.pickOffer.length) return;
    const offer = m.pickOffer;
    const advised = m.pickAdvised;
    m.pickOffer = [];
    m.pickAdvised = null;
    if (v.tools.some((t) => offer.includes(t))) return;
    if (advised && !m.tools.includes(advised)) {
      m.tools.push(advised);
      m.assumed.push({ tool: advised, offer });
    }
  }

  /** Окно темы забега: voice — номер озвучки из лога; неизвестный номер — тему не выдумываем. */
  theme(voice: number | null): void {
    const id = voice !== null ? THEME_BY_VOICE[voice] : undefined;
    if (!id) return;
    this.mem.start = id;
    this.mem.themeFresh = true;
    if (id === 'ironlaw') this.mem.dayLimit = this.p.ironLawDays;
  }

  /**
   * Выбор пришёл утром, до обхода: после него — обход этого дня. Двери —
   * только если доска нового дня их уже показала (иначе их раздаст движок).
   */
  private resumeMorning(): void {
    const m = this.mem;
    if (m.step !== 'patrol') m.doors = [];
    m.resume = 'patrol';
    m.resumeAfter = 'morning';
  }

  pick(v: PickView, fresh: boolean, rerolled: boolean, after: ShotCause = ''): void {
    if (!['pick', 'gift', 'wait'].includes(this.mem.step)) {
      if (after === 'morning' && !fresh) this.resumeMorning();
      else {
        this.mem.resume = this.mem.step;
        this.mem.resumeAfter = '';
      }
    }
    if (fresh && !v.reward) {
      // Новый забег: доска за выбором — чистая. Цель и тему с окон перед
      // выбором (если были) не теряем.
      const theme = this.mem.runStart || this.mem.themeFresh;
      const keep = {
        objective: this.mem.runStart ? this.mem.objective : null,
        start: theme ? this.mem.start : ('none' as StartEventId),
        dayLimit: theme ? this.mem.dayLimit : DEFAULT_PARAMS.days,
        themeFresh: this.mem.themeFresh,
      };
      this.mem = { ...blankMemory(), ...keep };
      this.mem.runStart = true;
    }
    this.mem.step = 'pick';
    this.mem.offer = v.cards.filter((c): c is ToolId => c !== null && !this.mem.tools.includes(c));
    this.mem.pickOffer = [...this.mem.offer];
    this.mem.pickAdvised = null;
    this.mem.rerolls = v.reroll && !rerolled ? 1 : 0;
  }

  /**
   * Сокровищница. after — что к ней привело ('swap' — заменённый стал
   * Призматическим и ушёл в хранилище; 'morning' — узник стал
   * Призматическим утром, после подарка будет обход дня); 'view' — доска за
   * окном уже видна, по ней можно советовать подарок.
   */
  treasure(after: ShotCause | 'view'): void {
    const m = this.mem;
    if (after === 'view') {
      m.step = 'gift';
      m.gifts = Math.max(1, m.gifts);
      return;
    }
    if (after === 'morning') {
      // Утренний Призматический уже в хранилище, даже если экран за окном
      // показывает прежнее число.
      m.storageFloor = Math.max(m.storageFloor, m.dayStorage + 1);
      m.storage = Math.max(m.storage, m.storageFloor);
    }
    if (!['pick', 'gift', 'wait'].includes(m.step)) {
      if (after === 'morning') this.resumeMorning();
      else {
        m.resume = m.step;
        m.resumeAfter = after;
      }
    }
    const w = m.cells[m.warden];
    if (after === 'swap' && w?.k === 'inmate') {
      m.cells[m.warden] = lockedCell();
      m.storage++;
    }
    m.gifts = m.start === 'abundance' ? this.p.abundanceGifts : 1;
    m.step = 'wait';
  }

  /** Позиция движка по памяти. */
  position(): Position {
    const m = this.mem;
    switch (m.step) {
      case 'wait':
        return { ok: false, problem: 'сокровищница: доска за окном ещё не видна' };
      case 'patrol':
        if (!m.doors.length) return { ok: false, problem: 'нет дверей' };
        break;
      case 'pick':
        if (!m.offer.length) return { ok: false, problem: 'нет карт выбора' };
        break;
      case 'chain': {
        if (m.cells[m.warden]?.k !== 'inmate') return { ok: false, problem: 'нет едока' };
        if (m.chainTargets.length && !this.chainFits()) {
          // Модель не объясняет подсвеченные цели (орудие меняет правило,
          // редкость на тёмном экране прочиталась не так): экрану верить
          // больше — совет по самой редкой из подсвеченных.
          const best = m.chainTargets.reduce((a, b) => ((m.cells[b]?.t ?? -1) > (m.cells[a]?.t ?? -1) ? b : a));
          return { ok: false, problem: 'модель не сходится с подсвеченными целями', fallback: { type: 'chain', to: best } };
        }
        break;
      }
    }
    const state = this.build();
    const d = m.step === 'manage' ? m.decision : null;
    const hunting = m.step === 'hunt';
    const targetsShown = m.step === 'chain' && m.firstBite ? m.chainTargets : null;
    const allowed = (code: number): boolean => {
      const kind = code >> 6;
      if (targetsShown && kind === A_DEVOUR) return targetsShown.includes(code & 63);
      if (hunting) return kind === A_HUNT;
      if (!d) return true;
      if (kind === A_HUNT) return !!d.hunt;
      if (kind === A_DEVOUR) return d.consume;
      if (kind === A_SWAP) return d.replace;
      if (kind === A_END) return true;
      return true;
    };
    const buf = new Int32Array(32);
    const n = legalCodes(state, buf);
    let any = false;
    for (let i = 0; i < n; i++) if (allowed(buf[i]!)) any = true;
    if (!any) return { ok: false, problem: 'ни один ход движка не виден на экране' };
    return { ok: true, state, allowed };
  }

  /** Состояние движка по памяти. */
  build(): State {
    const m = this.mem;
    const p = this.p;
    const s = new State();
    const x = s.m;
    let tools = 0;
    for (const t of m.tools) tools |= 1 << TOOL[t];
    const objective = m.objective ? OBJECTIVE[m.objective] : -1;

    if (m.step === 'pick' && m.runStart) {
      // Начало забега: доска за выбором ещё не открыта — как в движке.
      newRun(s, new Rng(0x9e3779b1), p, { start: START_EVENT[m.start], objective, tools, startPick: true });
      this.offer(s);
      return s;
    }

    x.fill(0);
    for (let c = 0; c < CELLS; c++) {
      x[BEAST + c] = -1;
      x[TIER + c] = -1;
      x[PRE_TIER + c] = -1;
      x[PRE_BEAST + c] = -1;
      const cell = m.cells[c]!;
      if (c === OFFICE) continue;
      if (cell.k === 'locked') {
        x[LOCK + c] = 1;
        if (cell.nest) x[NEST + c] = Math.max(1, (cell.nestDay ?? m.day) + p.ironboxDays - m.day);
        if (cell.shown !== undefined) {
          x[PRE_TIER + c] = cell.shown;
          x[PRE_BEAST + c] = 0;
          x[FLAGS + c] = F_VIS_TIER | ((tools >>> TOOL.claws) & 1 ? F_SCRATCH : 0);
        }
      } else if (cell.k === 'inmate') {
        x[BEAST + c] = cell.b!;
        x[TIER + c] = cell.t!;
      }
      // Вид события неизвестен: любой из пула, решатель его перебросит.
      if (cell.ev && cell.k !== 'empty') x[EVT + c] = EVENT.chain + 1;
    }
    x[WARDEN] = m.warden;
    x[DAY] = m.day;
    x[DAY_LIMIT] = m.dayLimit;
    x[START] = START_EVENT[m.start];
    x[TOOLS] = tools;
    x[STORAGE] = Math.min(m.storage, p.storage);
    x[OBJECTIVE_ID] = objective;
    x[USURP] = EVENT.usurp1;
    x[CHAIN_EATER] = -1;
    x[HUNT_LION] = -1;
    x[HUNT_PREY] = -1;
    x[REROLLS] = m.rerolls;

    let phase = P_PATROL;
    switch (m.step) {
      case 'patrol':
        for (let i = 0; i < Math.min(3, m.doors.length); i++) x[DOORS + i] = m.doors[i]!;
        x[DOORS_N] = Math.min(3, m.doors.length);
        break;
      case 'manage':
      case 'hunt':
        // Выбор добычи — тот же ряд решений, разрешено только «Выслеживание».
        phase = P_MANAGE;
        break;
      case 'office':
        phase = P_OFFICE;
        x[OFFICE_LEFT] = officeRounds(s, p);
        break;
      case 'ratway':
        phase = P_RATWAY;
        break;
      case 'chain':
        if (m.firstBite) {
          // До первого укуса: выбор Пожирания; «Отменить» → Замена или конец дня.
          phase = P_MANAGE;
          break;
        }
        phase = P_CHAIN;
        x[CHAIN_EATER] = m.warden;
        x[USED] = USED_DEVOUR;
        break;
      case 'pick':
        // Награда за цель посреди дня: после выбора день доигрывается.
        this.offer(s);
        this.resumeAfterPick(s);
        return s;
      case 'gift':
      case 'wait':
        x[OFFER_KIND] = OFFER_GIFT;
        x[OFFER_N] = GIFT_IDS.length;
        for (let i = 0; i < GIFT_IDS.length; i++) x[OFFER + i] = i;
        x[PICK_GIFTS] = Math.max(1, m.gifts);
        x[PHASE] = P_PICK;
        this.resumeAfterPick(s);
        return s;
    }
    x[PHASE] = phase;
    x[NEXT] = phase;
    return s;
  }

  /**
   * Куда забег вернётся после выбора: после обхода (цель «прогулка»,
   * «двери») — к ряду решений; после Пожирания — к цепочке (движок сам
   * завершит её, если есть некого); после Замены — к концу дня; утром — к
   * обходу этого дня.
   */
  private resumeAfterPick(s: State): void {
    const m = this.mem;
    const x = s.m;
    if (m.resumeAfter === 'morning') {
      // Утренний выбор: впереди обход этого дня. Двери не видны — движок их раздаст.
      const n = Math.min(3, m.doors.length);
      for (let i = 0; i < n; i++) x[DOORS + i] = m.doors[i]!;
      x[DOORS_N] = n;
      x[NEXT] = P_PATROL;
      return;
    }
    let next = P_DAYEND;
    if (m.resume === 'patrol' || m.resume === 'office' || m.resume === 'ratway') next = P_MANAGE;
    else if (m.resume === 'chain' || (m.resume === 'manage' && m.resumeAfter === 'consume')) next = P_CHAIN;
    if (next === P_CHAIN) {
      x[CHAIN_EATER] = m.warden;
      x[USED] = USED_DEVOUR;
    }
    x[NEXT] = next;
  }

  private offer(s: State): void {
    const x = s.m;
    const ids = this.mem.offer.slice(0, 3);
    x[OFFER_KIND] = OFFER_TOOL;
    x[OFFER_N] = ids.length;
    ids.forEach((id, i) => (x[OFFER + i] = TOOL[id]));
    x[PICK_TOOLS] = Math.max(1, x[PICK_TOOLS]!);
    x[REROLLS] = this.mem.rerolls;
    x[PHASE] = P_PICK;
  }
}
