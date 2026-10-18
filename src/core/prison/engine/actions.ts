/**
 * Легальные ходы и их применение.
 *
 * Внутри ход — целое число (код): (вид << 6) | аргумент. Горячий путь
 * (плейаут, решатель) работает с кодами и переиспользуемым буфером, без
 * аллокаций; объектный Action из model.ts — для внешнего API и тестов.
 */

import {
  CELLS, DEFAULT_PARAMS, GIFT, GIFT_IDS, OBJECTIVE, OFFICE, START_EVENT, TOOL, TOOL_IDS, type Action, type GiftId,
  type ObjectiveId, type Params, type StartEventId, type ToolId,
} from '../model.js';
import { Rng } from './rng.js';
import {
  chainBite, dealDoors, devour, endDay, eventDecision, finishDevour, huntTargets, hunt, makeOffer, morning, newRun, office,
  patrol, ratway, swap, takeGift, takeTool, targets,
} from './rules.js';
import {
  CHAIN_EATER, DAY, DOORS, DOORS_N, NEXT, OFFER, OFFER_GIFT, OFFER_KIND, OFFER_N, OFFER_NONE, OFFER_TOOL, PHASE,
  PICK_GIFTS, PICK_TOOLS, P_CHAIN, P_DAYEND, P_END, P_EVENT, P_MANAGE, P_MORNING, P_OFFICE, P_PATROL,
  P_PICK, P_RATWAY, REROLLS, State, TIER, USED, WARDEN, EVT, copy, score,
} from './state.js';

// ── коды ходов ──────────────────────────────────────────────────────────────

export const A_PATROL = 0;
export const A_DEVOUR = 1;
export const A_CHAIN = 2;
export const A_STOPCHAIN = 3;
export const A_SWAP = 4;
export const A_END = 5;
export const A_HUNT = 6;
export const A_BESTOW = 7;
export const A_INSTIGATE = 8;
export const A_ACCEPT = 9;
export const A_SKIP = 10;
export const A_TOOL = 11;
export const A_GIFT = 12;
export const A_REROLL = 13;

const code = (kind: number, arg = 0) => (kind << 6) | arg;

export function encode(a: Action): number {
  switch (a.type) {
    case 'patrol': return code(A_PATROL, a.cell);
    case 'devour': return code(A_DEVOUR, a.to);
    case 'chain': return code(A_CHAIN, a.to);
    case 'stopchain': return code(A_STOPCHAIN);
    case 'swap': return code(A_SWAP);
    case 'end': return code(A_END);
    case 'hunt': return code(A_HUNT, a.to);
    case 'office': return code(a.choice === 'bestow' ? A_BESTOW : A_INSTIGATE);
    case 'event': return code(a.accept ? A_ACCEPT : A_SKIP);
    case 'choose':
      return a.id in GIFT ? code(A_GIFT, GIFT[a.id as GiftId]) : code(A_TOOL, TOOL[a.id as ToolId]);
    case 'reroll': return code(A_REROLL);
  }
}

export function decode(c: number): Action {
  const arg = c & 63;
  switch (c >> 6) {
    case A_PATROL: return { type: 'patrol', cell: arg };
    case A_DEVOUR: return { type: 'devour', to: arg };
    case A_CHAIN: return { type: 'chain', to: arg };
    case A_STOPCHAIN: return { type: 'stopchain' };
    case A_SWAP: return { type: 'swap' };
    case A_END: return { type: 'end' };
    case A_HUNT: return { type: 'hunt', to: arg };
    case A_BESTOW: return { type: 'office', choice: 'bestow' };
    case A_INSTIGATE: return { type: 'office', choice: 'instigate' };
    case A_ACCEPT: return { type: 'event', accept: true };
    case A_SKIP: return { type: 'event', accept: false };
    case A_TOOL: return { type: 'choose', id: TOOL_IDS[arg]! };
    case A_GIFT: return { type: 'choose', id: GIFT_IDS[arg]! };
    case A_REROLL: return { type: 'reroll' };
  }
  throw new Error(`тюрьма: неизвестный код хода ${c}`);
}

// ── продвижение до следующего решения игрока ────────────────────────────────

/**
 * Довести состояние до ближайшего решения игрока: выборы орудий и
 * подарков идут первыми, утро и конец дня проходят сами, ряд решений без
 * выбора (только «Завершить день») пропускается.
 */
export function settle(s: State, r: Rng, p: Params): void {
  const m = s.m;
  for (;;) {
    if (m[PICK_GIFTS]! > 0 || m[PICK_TOOLS]! > 0) {
      if (m[OFFER_KIND] !== OFFER_NONE || makeOffer(s, r)) {
        m[PHASE] = P_PICK;
        return;
      }
      continue;
    }
    const nx = m[NEXT]!;
    switch (nx) {
      case P_MORNING:
        r.morning(m[DAY]!);
        morning(s, r, p);
        continue;
      case P_DAYEND:
        endDay(s);
        continue;
      case P_PATROL:
        // Обход, двери которого ещё не видны (подарок утром пришёл раньше
        // дверей): раздать их, как в конце утра. Кости — от утра этого дня.
        if (m[DOORS_N] === 0) {
          r.morning(m[DAY]!);
          dealDoors(s, r, p);
        }
        break;
      case P_MANAGE:
        if (m[USED] !== 0 || m[TIER + m[WARDEN]!]! < 0) {
          m[NEXT] = P_DAYEND;
          continue;
        }
        break;
      case P_CHAIN: {
        const e = m[CHAIN_EATER]!;
        if (e < 0 || targets(s, e) === 0) {
          finishDevour(s);
          continue;
        }
        break;
      }
      case P_EVENT:
        if (m[EVT + m[WARDEN]!] === 0) {
          m[NEXT] = P_MANAGE;
          continue;
        }
        break;
    }
    m[PHASE] = nx;
    return;
  }
}

// ── легальные ходы ──────────────────────────────────────────────────────────

/** Записать коды легальных ходов в out, вернуть их число. Буфер — не меньше 32. */
export function legalCodes(s: State, out: Int32Array): number {
  const m = s.m;
  let n = 0;
  switch (m[PHASE]) {
    case P_PICK: {
      const kind = m[OFFER_KIND] === OFFER_GIFT ? A_GIFT : A_TOOL;
      for (let i = 0; i < m[OFFER_N]!; i++) out[n++] = code(kind, m[OFFER + i]!);
      if (kind === A_TOOL && m[REROLLS]! > 0) out[n++] = code(A_REROLL);
      break;
    }
    case P_PATROL:
      for (let i = 0; i < m[DOORS_N]!; i++) out[n++] = code(A_PATROL, m[DOORS + i]!);
      break;
    case P_EVENT:
      // В игре у окна события одна кнопка — «Подтвердить»: пропустить нельзя
      // (по логу: 72 нажатия Btn_S16Board_EventPop_Confirm на 70 окон, других
      // кнопок нет). A_SKIP остаётся в кодах, но легальным не бывает.
      out[n++] = code(A_ACCEPT);
      break;
    case P_OFFICE:
      out[n++] = code(A_BESTOW);
      out[n++] = code(A_INSTIGATE);
      break;
    case P_RATWAY: {
      const w = m[WARDEN]!;
      for (let c = 1; c < CELLS; c++) if (c !== w) out[n++] = code(A_PATROL, c);
      break;
    }
    case P_MANAGE: {
      const mask = targets(s, m[WARDEN]!);
      for (let c = 1; c < CELLS; c++) if ((mask >>> c) & 1) out[n++] = code(A_DEVOUR, c);
      const prey = huntTargets(s);
      for (let c = 1; c < CELLS; c++) if ((prey >>> c) & 1) out[n++] = code(A_HUNT, c);
      out[n++] = code(A_SWAP);
      out[n++] = code(A_END);
      break;
    }
    case P_CHAIN: {
      const mask = targets(s, m[CHAIN_EATER]!);
      for (let c = 1; c < CELLS; c++) if ((mask >>> c) & 1) out[n++] = code(A_CHAIN, c);
      out[n++] = code(A_STOPCHAIN);
      break;
    }
  }
  return n;
}


function illegal(s: State, c: number): never {
  throw new Error(`тюрьма: ход ${JSON.stringify(decode(c))} нельзя в фазе ${s.m[PHASE]}`);
}

/**
 * Применить ход по коду. Ход должен быть легальным: фаза и цель
 * проверяются, если check (по умолчанию да). Доигрывания своей стратегией
 * передают false — её ходы легальны по построению.
 */
export function applyCode(s: State, c: number, r: Rng, p: Params, check = true): void {
  if (!check) {
    applyTrusted(s, c, r, p);
    return;
  }
  const m = s.m;
  const arg = c & 63;
  const ph = m[PHASE];
  switch (c >> 6) {
    case A_PATROL:
      if (ph === P_PATROL) {
        let ok = false;
        for (let i = 0; i < m[DOORS_N]!; i++) if (m[DOORS + i] === arg) ok = true;
        if (!ok) illegal(s, c);
        patrol(s, r, p, arg);
      } else if (ph === P_RATWAY) {
        if (arg === OFFICE || arg >= CELLS || arg === m[WARDEN]) illegal(s, c);
        ratway(s, r, p, arg);
      } else illegal(s, c);
      break;
    case A_DEVOUR:
      if (ph !== P_MANAGE || !((targets(s, m[WARDEN]!) >>> arg) & 1)) illegal(s, c);
      devour(s, r, p, arg);
      break;
    case A_CHAIN:
      if (ph !== P_CHAIN || !((targets(s, m[CHAIN_EATER]!) >>> arg) & 1)) illegal(s, c);
      chainBite(s, r, p, arg);
      break;
    case A_STOPCHAIN:
      if (ph !== P_CHAIN) illegal(s, c);
      finishDevour(s);
      break;
    case A_SWAP:
      if (ph !== P_MANAGE) illegal(s, c);
      swap(s, r, p);
      break;
    case A_END:
      if (ph !== P_MANAGE) illegal(s, c);
      m[NEXT] = P_DAYEND;
      break;
    case A_HUNT:
      if (ph !== P_MANAGE || !((huntTargets(s) >>> arg) & 1)) illegal(s, c);
      hunt(s, arg, p);
      break;
    case A_BESTOW:
    case A_INSTIGATE:
      if (ph !== P_OFFICE) illegal(s, c);
      office(s, r, p, c >> 6 === A_INSTIGATE);
      break;
    case A_ACCEPT:
    case A_SKIP:
      if (ph !== P_EVENT) illegal(s, c);
      eventDecision(s, r, p, c >> 6 === A_ACCEPT);
      break;
    case A_TOOL:
    case A_GIFT: {
      const want = c >> 6 === A_GIFT ? OFFER_GIFT : OFFER_TOOL;
      let ok = ph === P_PICK && m[OFFER_KIND] === want;
      if (ok) {
        ok = false;
        for (let i = 0; i < m[OFFER_N]!; i++) if (m[OFFER + i] === arg) ok = true;
      }
      if (!ok) illegal(s, c);
      m[OFFER_KIND] = OFFER_NONE;
      if (want === OFFER_GIFT) takeGift(s, r, p, arg);
      else takeTool(s, arg);
      break;
    }
    case A_REROLL:
      if (ph !== P_PICK || m[OFFER_KIND] !== OFFER_TOOL || m[REROLLS]! <= 0) illegal(s, c);
      m[REROLLS] = m[REROLLS]! - 1;
      m[OFFER_KIND] = OFFER_NONE;
      break;
    default:
      illegal(s, c);
  }
  settle(s, r, p);
}

/** То же без проверок. */
function applyTrusted(s: State, c: number, r: Rng, p: Params): void {
  const m = s.m;
  const arg = c & 63;
  switch (c >> 6) {
    case A_PATROL:
      if (m[PHASE] === P_RATWAY) ratway(s, r, p, arg);
      else patrol(s, r, p, arg);
      break;
    case A_DEVOUR:
      devour(s, r, p, arg);
      break;
    case A_CHAIN:
      chainBite(s, r, p, arg);
      break;
    case A_STOPCHAIN:
      finishDevour(s);
      break;
    case A_SWAP:
      swap(s, r, p);
      break;
    case A_END:
      m[NEXT] = P_DAYEND;
      break;
    case A_HUNT:
      hunt(s, arg, p);
      break;
    case A_BESTOW:
    case A_INSTIGATE:
      office(s, r, p, c >> 6 === A_INSTIGATE);
      break;
    case A_ACCEPT:
    case A_SKIP:
      eventDecision(s, r, p, c >> 6 === A_ACCEPT);
      break;
    case A_TOOL:
      m[OFFER_KIND] = OFFER_NONE;
      takeTool(s, arg);
      break;
    case A_GIFT:
      m[OFFER_KIND] = OFFER_NONE;
      takeGift(s, r, p, arg);
      break;
    case A_REROLL:
      m[REROLLS] = m[REROLLS]! - 1;
      m[OFFER_KIND] = OFFER_NONE;
      break;
  }
  settle(s, r, p);
}

// ── начало забега и плейаут ─────────────────────────────────────────────────

export interface RunOptions {
  start?: StartEventId;
  /** Цель; null — без цели (тогда и без орудий за цели). */
  objective?: ObjectiveId | null;
  /** Орудия, которые уже есть. */
  tools?: ToolId[];
  /** Выбор орудия в начале (по умолчанию да). */
  startPick?: boolean;
}

/** Начать забег и довести до первого решения. */
export function startRun(s: State, r: Rng, p: Params, opts: RunOptions = {}): void {
  let tools = 0;
  for (const t of opts.tools ?? []) tools |= 1 << TOOL[t];
  newRun(s, r, p, {
    start: START_EVENT[opts.start ?? 'none'],
    objective: opts.objective === null ? -1 : opts.objective ? OBJECTIVE[opts.objective] : r.int(5),
    tools,
    startPick: opts.startPick ?? true,
  });
  settle(s, r, p);
}

/** Буфер для legalCodes. */
export function codeBuffer(): Int32Array {
  return new Int32Array(32);
}

/** Доиграть забег случайными легальными ходами; вернуть счёт. Без аллокаций. */
export function randomPlayout(s: State, r: Rng, p: Params, buf: Int32Array): number {
  const m = s.m;
  while (m[PHASE] !== P_END) {
    const n = legalCodes(s, buf);
    applyCode(s, buf[r.int(n)]!, r, p);
  }
  return score(s);
}

// ── объектный API ───────────────────────────────────────────────────────────

export interface Engine {
  legal(s: State): Action[];
  apply(s: State, a: Action, rng: Rng): void;
  copy(from: State, to: State): void;
  score(s: State): number;
  start(s: State, rng: Rng, opts?: RunOptions): void;
  readonly params: Readonly<Params>;
}

export function createEngine(params: Readonly<Params> = DEFAULT_PARAMS): Engine {
  const buf = codeBuffer();
  return {
    params,
    legal(s) {
      const n = legalCodes(s, buf);
      const out: Action[] = [];
      for (let i = 0; i < n; i++) out.push(decode(buf[i]!));
      return out;
    },
    apply(s, a, rng) {
      applyCode(s, encode(a), rng, params);
    },
    copy,
    score,
    start(s, rng, opts) {
      startRun(s, rng, params, opts);
    },
  };
}

export { State, Rng };
