/**
 * Правила тюрьмы (rules.md §1–10): двери, рост, пожирание, утро, события,
 * замена, подарки, цели. Функции меняют состояние на месте и ставят NEXT;
 * куда ход переходит дальше, решает settle() в actions.ts.
 *
 * Наборы камер — 16-битные маски (бит c — камера c): так выбор случайной
 * камеры не требует буферов и не аллоцирует.
 */

import {
  CELLS, EVENT, EVENT_POOL, LEGENDARY, LION, MAMMOTH, OBJECTIVE, OBJECTIVE_IDS, OFFICE, PRISMATIC, RAT,
  START_EVENT, SUPREME, TOOL, TOOL_IDS, WOLF, type Params, type TierOdds,
} from '../model.js';
import type { Rng } from './rng.js';
import {
  BEAST, CHAIN_EATER, CHAIN_REACTION, DAY, DAY_LIMIT, DOORS, DOORS_N, EVT, FLAGS, F_SCRATCH, F_TUSK, F_VIS_BEAST,
  F_VIS_RARE, F_VIS_TIER, HUNT_LEFT, HUNT_LION, HUNT_PREY, LOCK, NEST, NEXT, OBJECTIVE_ID, OBJ_DONE, OBJ_PROGRESS,
  OFFER, OFFER_GIFT, OFFER_KIND, OFFER_N, OFFER_TOOL, OFFICE_LEFT, PICK_TOOLS, PICK_GIFTS, PRE_BEAST, PRE_TIER,
  P_CHAIN, P_DAYEND, P_END, P_EVENT, P_HUNT, P_MANAGE, P_MORNING, P_OFFICE, P_PATROL, P_RATWAY, REROLLS, START, STAT_BITES,
  STAT_DEVOURS, STAT_EVENTS, STAT_OPENED, STAT_STEPS, STORAGE, TIER, TOOLS, USED, USED_DEVOUR, USED_SWAP, WARDEN,
  type State, dist, hasTool,
} from './state.js';

// ── маски ───────────────────────────────────────────────────────────────────

/** Первая еда: мамонт → лев, лев → волк, волк → крыса, крыса → мамонт. */
export const FIRST_FOOD = [LION, WOLF, RAT, MAMMOTH] as const;
/** Вторая еда (от Легендарной): мамонт → волк, лев → крыса. */
export const SECOND_FOOD = [WOLF, RAT, -1, -1] as const;

const ALL_TOOLS = (1 << TOOL_IDS.length) - 1;
const POOL = EVENT_POOL.map((id) => EVENT[id]);

export function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
}

/** Номер k-го установленного бита (k с нуля). */
function nthBit(mask: number, k: number): number {
  for (let i = 0; i < 32; i++) {
    if ((mask >>> i) & 1) {
      if (k === 0) return i;
      k--;
    }
  }
  return -1;
}

/** Случайный установленный бит, −1 — маска пуста. */
export function pickBit(mask: number, r: Rng): number {
  const n = popcount(mask);
  return n === 0 ? -1 : nthBit(mask, r.int(n));
}

export function lockedMask(s: State): number {
  const m = s.m;
  let mask = 0;
  for (let c = 1; c < CELLS; c++) if (m[LOCK + c] === 1) mask |= 1 << c;
  return mask;
}

export function inmateMask(s: State): number {
  const m = s.m;
  let mask = 0;
  for (let c = 1; c < CELLS; c++) if (m[TIER + c]! >= 0) mask |= 1 << c;
  return mask;
}

function lockedNoEventMask(s: State): number {
  const m = s.m;
  let mask = 0;
  for (let c = 1; c < CELLS; c++) if (m[LOCK + c] === 1 && m[EVT + c] === 0) mask |= 1 << c;
  return mask;
}

// ── броски ──────────────────────────────────────────────────────────────────

/** Редкость по долям, не ниже floor. */
export function rollTier(r: Rng, odds: TierOdds, floor: number): number {
  let sum = 0;
  for (let t = floor; t <= PRISMATIC; t++) sum += odds[t]!;
  if (sum <= 0) return floor;
  // Целое из ГСЧ, а не float(): дробное число, вернувшееся из вызова, V8 упаковывает в кучу.
  let x = r.int(0x40000000) * (sum / 0x40000000);
  for (let t = floor; t < PRISMATIC; t++) {
    x -= odds[t]!;
    if (x < 0) return t;
  }
  return PRISMATIC;
}

function doorFloor(s: State, c: number): number {
  const floor = (s.m[FLAGS + c]! & F_VIS_RARE) !== 0 ? 2 : 0;
  return hasTool(s, TOOL.hook) && floor < 1 ? 1 : floor;
}

function randomEvent(r: Rng): number {
  return POOL[r.int(POOL.length)]!;
}

// ── цели ────────────────────────────────────────────────────────────────────

/** Продвинуть цель obj на n; выполненная даёт выбор орудия. */
export function progress(s: State, r: Rng, p: Params, obj: number, n: number): void {
  const m = s.m;
  if (m[OBJECTIVE_ID] !== obj) return;
  m[OBJ_PROGRESS] = m[OBJ_PROGRESS]! + n;
  if (m[OBJ_PROGRESS]! < p.objectiveTarget[OBJECTIVE_IDS[obj]!]) return;
  m[PICK_TOOLS] = m[PICK_TOOLS]! + 1;
  m[OBJ_DONE] = m[OBJ_DONE]! + 1;
  m[OBJ_PROGRESS] = 0;
  if (!p.objectiveRepeat) {
    m[OBJECTIVE_ID] = -1;
    return;
  }
  let next = r.int(OBJECTIVE_IDS.length - 1);
  if (next >= obj) next++;
  setObjective(s, r, p, next);
}

/** Поставить цель; «Загнанный зверь-царь» при уже имеющемся Величайшем выполняется сразу. */
export function setObjective(s: State, r: Rng, p: Params, obj: number): void {
  const m = s.m;
  m[OBJECTIVE_ID] = obj;
  m[OBJ_PROGRESS] = 0;
  if (obj === OBJECTIVE.apex) {
    for (let c = 1; c < CELLS; c++) {
      if (m[TIER + c]! >= SUPREME) {
        progress(s, r, p, obj, 1);
        return;
      }
    }
  }
}

// ── узники ──────────────────────────────────────────────────────────────────

/** Забыть метки, привязанные к узнику камеры c (охота). */
function forget(s: State, c: number): void {
  const m = s.m;
  if (m[HUNT_LEFT]! > 0 && (m[HUNT_LION] === c || m[HUNT_PREY] === c)) m[HUNT_LEFT] = 0;
}

/** Камера снова заперта: узник ушёл. Может выпасть новое событие за дверью. */
export function relock(s: State, r: Rng, p: Params, c: number): void {
  const m = s.m;
  forget(s, c);
  m[BEAST + c] = -1;
  m[TIER + c] = -1;
  m[LOCK + c] = 1;
  m[FLAGS + c] = 0;
  m[NEST + c] = 0;
  m[PRE_TIER + c] = -1;
  m[PRE_BEAST + c] = -1;
  if (m[CHAIN_EATER] === c) m[CHAIN_EATER] = -1;
  if (m[EVT + c] === 0 && r.chance(p.relockEvent)) m[EVT + c] = randomEvent(r) + 1;
}

/**
 * Привести редкость узника в порядок после изменения: Величайшая — к цели,
 * Призматическая — в хранилище (камера запирается, сокровищница), при
 * полном хранилище рост стоит на Величайшей.
 */
export function settleTier(s: State, r: Rng, p: Params, c: number): void {
  const m = s.m;
  const t = m[TIER + c]!;
  if (t < SUPREME) return;
  progress(s, r, p, OBJECTIVE.apex, 1);
  if (t < PRISMATIC) return;
  if (m[STORAGE]! < p.storage) {
    m[STORAGE] = m[STORAGE]! + 1;
    m[PICK_GIFTS] = m[PICK_GIFTS]! + (m[START] === START_EVENT.abundance ? p.abundanceGifts : 1);
    relock(s, r, p, c);
  } else {
    m[TIER + c] = SUPREME;
  }
}

/** +n к редкости узника камеры c (если он там есть). */
export function raise(s: State, r: Rng, p: Params, c: number, n: number): void {
  const m = s.m;
  if (m[TIER + c]! < 0 || n <= 0) return;
  m[TIER + c] = m[TIER + c]! + n;
  settleTier(s, r, p, c);
}

/** Посадить узника в камеру (она становится открытой). */
export function place(s: State, r: Rng, p: Params, c: number, beast: number, tier: number): void {
  const m = s.m;
  m[LOCK + c] = 0;
  m[NEST + c] = 0;
  m[PRE_TIER + c] = -1;
  m[PRE_BEAST + c] = -1;
  m[FLAGS + c] = 0;
  m[BEAST + c] = beast;
  m[TIER + c] = tier;
  settleTier(s, r, p, c);
}

/** Закрепить узника за запертой дверью (без показа игроку). */
export function preset(s: State, r: Rng, p: Params, c: number): void {
  const m = s.m;
  if (m[LOCK + c] !== 1 || m[PRE_TIER + c]! >= 0) return;
  m[PRE_TIER + c] = rollTier(r, p.doorOdds, doorFloor(s, c));
  m[PRE_BEAST + c] = r.int(4);
}

/**
 * Открыть запертую камеру: узник — закреплённый или по шансам двери. Событие
 * остаётся в камере и сработает при обходе в неё. Гнездо пропадает.
 */
export function openCell(s: State, r: Rng, p: Params, c: number): void {
  const m = s.m;
  if (m[LOCK + c] !== 1) return;
  let tier = m[PRE_TIER + c]!;
  let beast = m[PRE_BEAST + c]!;
  if (tier < 0) {
    tier = rollTier(r, p.doorOdds, doorFloor(s, c));
    beast = r.int(4);
  }
  m[STAT_OPENED] = m[STAT_OPENED]! + 1;
  place(s, r, p, c, beast, tier);
  progress(s, r, p, OBJECTIVE.doors, 1);
}

/** Открыть случайную запертую камеру; −1 — запертых нет. */
export function openRandom(s: State, r: Rng, p: Params): number {
  const c = pickBit(lockedMask(s), r);
  if (c >= 0) openCell(s, r, p, c);
  return c;
}

/** Убрать узника: камера запирается. */
export function remove(s: State, r: Rng, p: Params, c: number): void {
  if (s.m[TIER + c]! >= 0) relock(s, r, p, c);
}

/** +1 случайным n разным узникам. */
function raiseRandom(s: State, r: Rng, p: Params, n: number, gain: number): void {
  let mask = inmateMask(s);
  for (let i = 0; i < n && mask; i++) {
    const c = pickBit(mask, r);
    mask &= ~(1 << c);
    raise(s, r, p, c, gain);
  }
}

// ── кто кого ест ────────────────────────────────────────────────────────────

function isFood(eater: number, tier: number, food: number): boolean {
  return food === FIRST_FOOD[eater] || (tier >= LEGENDARY && food === SECOND_FOOD[eater]);
}

/** Может ли узник камеры e съесть камеру t (с орудиями и стартовым событием). */
export function canEat(s: State, e: number, t: number): boolean {
  return ((targets(s, e) >>> t) & 1) === 1;
}

/**
 * Маска целей едока e. Едят свою еду той же редкости; орудия и «Бой в
 * клетке» расширяют круг. Всё, что зависит только от едока, считается до
 * цикла: это самая горячая функция плейаута.
 */
export function targets(s: State, e: number): number {
  const m = s.m;
  const te = m[TIER + e]!;
  if (te < 0 || te >= PRISMATIC) return 0;
  const be = m[BEAST + e]!;
  const tools = m[TOOLS]!;
  const f1 = FIRST_FOOD[be]!;
  const f2 = te >= LEGENDARY ? SECOND_FOOD[be]! : -1;
  const anyTier = m[START] === START_EVENT.cagefight;
  const skewer = be === RAT && ((tools >>> TOOL.skewer) & 1) === 1;
  const crown = be === LION && ((tools >>> TOOL.crown) & 1) === 1;
  const maul = be === MAMMOTH && ((tools >>> TOOL.maul) & 1) === 1;
  const guillotine = be === WOLF && ((tools >>> TOOL.guillotine) & 1) === 1;
  // Грязные когти: волк той же редкости ест сквозь поцарапанную дверь.
  const claws = be === WOLF && ((tools >>> TOOL.claws) & 1) === 1;
  let mask = 0;
  for (let t = 1; t < CELLS; t++) {
    if (t === e) continue;
    if (m[LOCK + t] === 1) {
      if (claws && (m[FLAGS + t]! & F_SCRATCH) !== 0 && m[PRE_TIER + t] === te) mask |= 1 << t;
      continue;
    }
    const tt = m[TIER + t]!;
    if (tt < 0) continue;
    const bt = m[BEAST + t]!;
    const food = bt === f1 || bt === f2;
    if (
      (food && (tt === te || anyTier)) ||
      (crown && tt === te) ||
      (skewer && bt === RAT && tt === te) ||
      (maul && food && tt > te) ||
      (guillotine && bt === RAT && tt < te)
    ) {
      mask |= 1 << t;
    }
  }
  return mask;
}

/**
 * Укус: e съедает t. Съеденный пропадает (камера запирается или, с «Тесной
 * клеткой», сразу открывается с новым узником), едок растёт и меняет зверя.
 */
export function bite(s: State, r: Rng, p: Params, e: number, t: number, inChain: boolean): void {
  const m = s.m;
  const te = m[TIER + e]!;
  const be = m[BEAST + e]!;
  const door = m[LOCK + t] === 1;
  const tt = door ? m[PRE_TIER + t]! : m[TIER + t]!;
  const bt = door ? m[PRE_BEAST + t]! : m[BEAST + t]!;

  let gain = 1;
  if (door) gain = p.clawsGain;
  else if (be === MAMMOTH && hasTool(s, TOOL.maul) && isFood(be, te, bt)) gain = Math.max(1, tt + 2 - te);
  if (be === RAT && hasTool(s, TOOL.skewer)) gain += p.skewerBonus;
  if (be === LION && hasTool(s, TOOL.crown)) gain += p.crownBonus;
  if (hasTool(s, TOOL.whip) && r.chance(p.whipChance)) gain++;
  if (inChain && hasTool(s, TOOL.collar) && r.chance(p.collarChance)) gain++;

  if (!door && hasTool(s, TOOL.cage) && r.chance(p.cageChance)) {
    forget(s, t);
    m[LOCK + t] = 1;
    m[PRE_TIER + t] = -1;
    m[FLAGS + t] = 0;
    m[TIER + t] = -1;
    m[BEAST + t] = -1;
    openCell(s, r, p, t);
  } else {
    relock(s, r, p, t);
  }

  if (hasTool(s, TOOL.muzzle) && popcount(inmateMask(s)) <= p.muzzleLeft) gain += p.muzzleBonus;

  m[STAT_BITES] = m[STAT_BITES]! + 1;
  if (p.jungleCountsBites) progress(s, r, p, OBJECTIVE.jungle, 1);

  raise(s, r, p, e, gain);
  if (m[TIER + e]! >= 0 && m[START] !== START_EVENT.cagefight) m[BEAST + e] = r.int(4);
}

/** Пожирание из ряда решений: первый укус, дальше цепочка. */
export function devour(s: State, r: Rng, p: Params, t: number): void {
  const m = s.m;
  const e = m[WARDEN]!;
  m[USED] = USED_DEVOUR;
  m[STAT_DEVOURS] = m[STAT_DEVOURS]! + 1;
  if (!p.jungleCountsBites) progress(s, r, p, OBJECTIVE.jungle, 1);
  bite(s, r, p, e, t, false);
  afterBite(s, r, p, e);
}

/** Укус в цепочке. */
export function chainBite(s: State, r: Rng, p: Params, t: number): void {
  const e = s.m[CHAIN_EATER]!;
  bite(s, r, p, e, t, true);
  afterBite(s, r, p, e);
}

function afterBite(s: State, r: Rng, p: Params, e: number): void {
  const m = s.m;
  if (m[TIER + e]! >= 0 && targets(s, e) !== 0) {
    m[CHAIN_EATER] = e;
    m[NEXT] = P_CHAIN;
  } else {
    finishDevour(s, r, p, e);
  }
}

/** Конец Пожирания: «Ржавая пила», «Железная дева мстителя», день завершается. */
export function finishDevour(s: State, r: Rng, p: Params, e: number): void {
  const m = s.m;
  m[CHAIN_EATER] = -1;
  m[NEXT] = P_DAYEND;
  if (e < 0 || m[TIER + e]! < 0) return;
  if (hasTool(s, TOOL.saw) && r.chance(p.sawChance)) raise(s, r, p, e, 1);
  if (m[TIER + e]! >= 0 && hasTool(s, TOOL.revenge) && r.chance(p.revengeChance)) {
    const c = pickBit(lockedMask(s), r);
    if (c >= 0) {
      m[PRE_TIER + c] = m[TIER + e]!;
      m[PRE_BEAST + c] = FIRST_FOOD[m[BEAST + e]!]!;
      openCell(s, r, p, c);
    }
  }
}

// ── утро ────────────────────────────────────────────────────────────────────

/**
 * Утро: утренние орудия, затем пункты назначения. Порядок орудий — догадка:
 * гнёзда, удушающая цепь, монета, щипцы, когти, ящик, капкан.
 */
export function morning(s: State, r: Rng, p: Params): void {
  const m = s.m;

  // Гнёзда «Железного ящика»: через ironboxDays утр — Редкая крыса.
  for (let c = 1; c < CELLS; c++) {
    if (m[NEST + c]! > 0) {
      m[NEST + c] = m[NEST + c]! - 1;
      if (m[NEST + c] === 0 && m[LOCK + c] === 1) {
        m[PRE_TIER + c] = p.ironboxTier;
        m[PRE_BEAST + c] = RAT;
        openCell(s, r, p, c);
      }
    }
  }

  if (hasTool(s, TOOL.ravenous)) ravenous(s, r, p);
  if (hasTool(s, TOOL.coin) && r.chance(p.coinChance)) coin(s, r, p);

  if (hasTool(s, TOOL.tongs)) {
    let marked = false;
    let mammoths = 0;
    for (let c = 1; c < CELLS; c++) {
      if (m[TIER + c]! < 0) continue;
      if (m[FLAGS + c]! & F_TUSK) marked = true;
      if (m[BEAST + c] === MAMMOTH) mammoths |= 1 << c;
    }
    const c = marked ? -1 : pickBit(mammoths, r);
    if (c >= 0) m[FLAGS + c] = m[FLAGS + c]! | F_TUSK;
  }

  if (hasTool(s, TOOL.claws)) {
    let scratched = false;
    for (let c = 1; c < CELLS; c++) if (m[LOCK + c] === 1 && m[FLAGS + c]! & F_SCRATCH) scratched = true;
    const c = scratched ? -1 : pickBit(lockedMask(s), r);
    if (c >= 0) {
      preset(s, r, p, c);
      m[FLAGS + c] = m[FLAGS + c]! | F_SCRATCH | F_VIS_TIER;
    }
  }

  if (hasTool(s, TOOL.ironbox)) {
    let nests = false;
    for (let c = 1; c < CELLS; c++) if (m[NEST + c]! > 0) nests = true;
    const c = nests ? -1 : pickBit(lockedMask(s), r);
    if (c >= 0) m[NEST + c] = p.ironboxDays;
  }

  let hunt = false;
  if (hasTool(s, TOOL.trap)) {
    if (m[HUNT_LEFT]! > 0) {
      const lion = m[HUNT_LION]!;
      const prey = m[HUNT_PREY]!;
      m[HUNT_LEFT] = m[HUNT_LEFT]! - 1;
      raise(s, r, p, prey, 1);
      raise(s, r, p, lion, 1);
    } else {
      hunt = huntTargets(s) !== 0;
    }
  }

  dealDoors(s, r, p);
  m[NEXT] = hunt ? P_HUNT : P_PATROL;
}

/** Голодная удушающая цепь: самый редкий узник убирает соседей, +1 за каждого с шансом. */
function ravenous(s: State, r: Rng, p: Params): void {
  const m = s.m;
  let best = -1;
  let mask = 0;
  for (let c = 1; c < CELLS; c++) {
    const t = m[TIER + c]!;
    if (t > best) {
      best = t;
      mask = 1 << c;
    } else if (t === best && t >= 0) {
      mask |= 1 << c;
    }
  }
  const e = pickBit(mask, r);
  if (e < 0) return;
  let gain = 0;
  for (let d = -1; d <= 1; d += 2) {
    const c = (e + d + CELLS) & (CELLS - 1);
    if (c === OFFICE || m[TIER + c]! < 0) continue;
    remove(s, r, p, c);
    if (r.chance(p.ravenousChance)) gain++;
  }
  raise(s, r, p, e, gain);
}

/** Монета судьбы: пара одинаковых (зверь и редкость) — один уходит, другой растёт. */
function coin(s: State, r: Rng, p: Params): void {
  const m = s.m;
  let pairs = 0;
  for (let a = 1; a < CELLS; a++) {
    if (m[TIER + a]! < 0) continue;
    for (let b = a + 1; b < CELLS; b++) if (m[TIER + b] === m[TIER + a] && m[BEAST + b] === m[BEAST + a]) pairs++;
  }
  if (pairs === 0) return;
  let k = r.int(pairs);
  for (let a = 1; a < CELLS; a++) {
    if (m[TIER + a]! < 0) continue;
    for (let b = a + 1; b < CELLS; b++) {
      if (m[TIER + b] !== m[TIER + a] || m[BEAST + b] !== m[BEAST + a]) continue;
      if (k-- > 0) continue;
      const first = r.int(2) === 0;
      remove(s, r, p, first ? a : b);
      raise(s, r, p, first ? b : a, p.coinBonus);
      return;
    }
  }
}

/** Добыча, которую может пометить лев («Охота»). */
export function huntTargets(s: State): number {
  const m = s.m;
  let mask = 0;
  for (let c = 1; c < CELLS; c++) if (m[BEAST + c] === LION) mask |= targets(s, c);
  return mask & ~lockedMask(s);
}

/** «Охота»: добычу метит самый редкий лев, который может её съесть. */
export function hunt(s: State, prey: number, p: Params): void {
  const m = s.m;
  let lion = -1;
  for (let c = 1; c < CELLS; c++) {
    if (m[BEAST + c] === LION && canEat(s, c, prey) && (lion < 0 || m[TIER + c]! > m[TIER + lion]!)) lion = c;
  }
  m[HUNT_LION] = lion;
  m[HUNT_PREY] = prey;
  m[HUNT_LEFT] = lion >= 0 ? p.trapMornings : 0;
  m[NEXT] = P_PATROL;
}

/** Пункты назначения: 3 минус орудия, утром без них иногда на одну меньше; не меньше одной. */
export function dealDoors(s: State, r: Rng, p: Params): void {
  const m = s.m;
  let n = p.doorCards;
  const minus = (hasTool(s, TOOL.forged) ? 1 : 0) + (hasTool(s, TOOL.whip) ? 1 : 0) + (hasTool(s, TOOL.stake) ? 1 : 0);
  if (minus > 0) n -= minus;
  else if (r.chance(p.oneLessDoor)) n--;
  if (n < 1) n = 1;
  if (n > 3) n = 3;
  let steps = ((1 << p.doorReach) - 1) << 1;
  let chosen = 0;
  for (let i = 0; i < n && steps; i++) {
    const k = pickBit(steps, r);
    steps &= ~(1 << k);
    chosen |= 1 << k;
  }
  const w = m[WARDEN]!;
  let i = 0;
  for (let k = 1; k <= p.doorReach; k++) if ((chosen >>> k) & 1) m[DOORS + i++] = (w + k) & (CELLS - 1);
  m[DOORS_N] = i;
}

/** Конец дня. */
export function endDay(s: State): void {
  const m = s.m;
  m[DAY] = m[DAY]! + 1;
  m[USED] = 0;
  m[CHAIN_EATER] = -1;
  m[DOORS_N] = 0;
  m[NEXT] = m[DAY]! >= m[DAY_LIMIT]! ? P_END : P_MORNING;
}

// ── обход ───────────────────────────────────────────────────────────────────

/** Обход: надзиратель идёт по часовой стрелке к камере cell. */
export function patrol(s: State, r: Rng, p: Params, cell: number): void {
  const m = s.m;
  const from = m[WARDEN]!;
  const steps = dist(from, cell);
  if (m[CHAIN_REACTION] === 1) {
    m[CHAIN_REACTION] = 0;
    for (let k = 1; k < steps; k++) openCell(s, r, p, (from + k) & (CELLS - 1));
  }
  m[WARDEN] = cell;
  m[STAT_STEPS] = m[STAT_STEPS]! + steps;
  progress(s, r, p, OBJECTIVE.walk, steps);

  if (cell !== OFFICE && m[LOCK + cell] === 1) {
    openCell(s, r, p, cell);
    doorTools(s, r, p, cell);
  }
  if (hasTool(s, TOOL.shortchain) && steps <= p.shortchainSteps && r.chance(p.shortchainChance)) openRandom(s, r, p);
  if (hasTool(s, TOOL.shackles) && steps >= p.shacklesSteps && r.chance(p.shacklesChance)) raiseRandom(s, r, p, 1, 1);
  arrive(s, p, cell);
}

/** «Крысиная тропа»: переход без шагов; дверь открывается, орудия обхода не срабатывают. */
export function ratway(s: State, r: Rng, p: Params, cell: number): void {
  s.m[WARDEN] = cell;
  openCell(s, r, p, cell);
  arrive(s, p, cell);
}

function arrive(s: State, p: Params, cell: number): void {
  const m = s.m;
  if (cell === OFFICE) {
    m[OFFICE_LEFT] = officeRounds(s, p);
    m[NEXT] = P_OFFICE;
  } else if (m[EVT + cell] !== 0) {
    m[NEXT] = P_EVENT;
  } else {
    m[NEXT] = P_MANAGE;
  }
}

/** Орудия при открытии двери обходом. Порядок — догадка. */
function doorTools(s: State, r: Rng, p: Params, c: number): void {
  const m = s.m;
  if (hasTool(s, TOOL.dogtag) && r.chance(p.dogtagChance)) raise(s, r, p, c, 1);
  if (hasTool(s, TOOL.keys) && r.chance(p.keysChance)) {
    openCell(s, r, p, (c + CELLS - 1) & (CELLS - 1));
    openCell(s, r, p, (c + 1) & (CELLS - 1));
  }
  if (hasTool(s, TOOL.forged) && r.chance(p.forgedChance)) openRandom(s, r, p);
  if (hasTool(s, TOOL.fire) && m[TIER + c]! >= 0 && r.chance(p.fireChance)) {
    const d = pickBit(lockedMask(s), r);
    if (d >= 0) {
      m[PRE_TIER + d] = m[TIER + c]!;
      m[PRE_BEAST + d] = m[BEAST + c]!;
      openCell(s, r, p, d);
    }
  }
  if (hasTool(s, TOOL.blacklist) && popcount(lockedMask(s)) <= p.blacklistLocked) {
    raiseRandom(s, r, p, p.blacklistCount, 1);
  }
}

// ── допросная ───────────────────────────────────────────────────────────────

/** Выборов в допросной за визит: 1, с «Тиранией» ещё tyrannyExtra. */
export function officeRounds(s: State, p: Params): number {
  return 1 + (s.m[START] === START_EVENT.tyranny ? p.tyrannyExtra : 0);
}

export function office(s: State, r: Rng, p: Params, instigate: boolean): void {
  const m = s.m;
  if (instigate) {
    let mask = lockedNoEventMask(s);
    for (let i = 0; i < p.instigateDoors && mask; i++) {
      const c = pickBit(mask, r);
      mask &= ~(1 << c);
      m[EVT + c] = randomEvent(r) + 1;
    }
  } else {
    raiseRandom(s, r, p, 1, 1);
  }
  m[OFFICE_LEFT] = m[OFFICE_LEFT]! - 1;
  m[NEXT] = m[OFFICE_LEFT]! > 0 ? P_OFFICE : P_MANAGE;
}

// ── события ─────────────────────────────────────────────────────────────────

/** Решение по событию в камере надзирателя. */
export function eventDecision(s: State, r: Rng, p: Params, accept: boolean): void {
  const m = s.m;
  const c = m[WARDEN]!;
  const ev = m[EVT + c]! - 1;
  m[EVT + c] = 0;
  m[NEXT] = P_MANAGE;
  if (!accept || ev < 0) return;
  m[STAT_EVENTS] = m[STAT_EVENTS]! + 1;
  runEvent(s, r, p, c, ev);
  progress(s, r, p, OBJECTIVE.currents, 1);
}

/** Действие события ev в камере c. */
export function runEvent(s: State, r: Rng, p: Params, c: number, ev: number): void {
  const m = s.m;
  switch (ev) {
    case EVENT.chain:
      m[CHAIN_REACTION] = 1;
      break;
    case EVENT.execution: {
      const te = m[TIER + c]!;
      if (te < 0) break;
      const food = FIRST_FOOD[m[BEAST + c]!]!;
      let n = 0;
      for (let t = 1; t < CELLS; t++) {
        if (t !== c && m[BEAST + t] === food && m[TIER + t]! >= 0 && m[TIER + t]! < te) {
          remove(s, r, p, t);
          n++;
        }
      }
      raise(s, r, p, c, n);
      break;
    }
    case EVENT.behind: {
      if (m[TIER + c]! < 0) break;
      let c0 = 0, c1 = 0, c2 = 0, c3 = 0;
      for (let t = 1; t < CELLS; t++) {
        if (t === c || m[TIER + t]! < 0) continue;
        const b = m[BEAST + t];
        if (b === 0) c0++;
        else if (b === 1) c1++;
        else if (b === 2) c2++;
        else c3++;
      }
      const min = Math.min(c0, c1, c2, c3);
      const mask = (c0 === min ? 1 : 0) | (c1 === min ? 2 : 0) | (c2 === min ? 4 : 0) | (c3 === min ? 8 : 0);
      m[BEAST + c] = pickBit(mask, r);
      if (m[TIER + c]! < SUPREME) m[TIER + c] = SUPREME;
      settleTier(s, r, p, c);
      break;
    }
    case EVENT.appetite: {
      let low = 99;
      let mask = 0;
      for (let t = 1; t < CELLS; t++) {
        const tt = m[TIER + t]!;
        if (tt < 0) continue;
        if (tt < low) {
          low = tt;
          mask = 1 << t;
        } else if (tt === low) {
          mask |= 1 << t;
        }
      }
      const t = pickBit(mask, r);
      if (t < 0) break;
      let gain = 0;
      for (let i = 0; i < p.appetiteTries; i++) if (r.chance(p.appetiteChance)) gain++;
      raise(s, r, p, t, gain);
      break;
    }
    case EVENT.convict: {
      const t = pickBit(lockedMask(s), r);
      if (t < 0) break;
      m[PRE_TIER + t] = r.int(2) === 0 ? LEGENDARY : SUPREME;
      m[PRE_BEAST + t] = r.int(4);
      openCell(s, r, p, t);
      break;
    }
    case EVENT.raven: {
      const w = m[WARDEN]!;
      let n = 0;
      for (let k = 1; k < CELLS && n < p.ravenCells; k++) {
        const t = (w + k) & (CELLS - 1);
        if (m[LOCK + t] !== 1) continue;
        preset(s, r, p, t);
        m[FLAGS + t] = m[FLAGS + t]! | F_VIS_TIER;
        n++;
      }
      break;
    }
    case EVENT.freedom:
      for (let i = 0; i < p.freedomOpens; i++) openRandom(s, r, p);
      break;
    case EVENT.usurp1:
    case EVENT.usurp2:
    case EVENT.usurp3:
    case EVENT.usurp4: {
      const level = ev - EVENT.usurp1;
      raise(s, r, p, c, p.usurpGain[level]!);
      if (ev !== EVENT.usurp4) {
        const t = pickBit(lockedNoEventMask(s), r);
        if (t >= 0) m[EVT + t] = ev + 2;
      }
      break;
    }
    case EVENT.ratway:
      m[NEXT] = P_RATWAY;
      break;
    case EVENT.treasure:
      for (let t = 1; t < CELLS; t++) {
        if (m[LOCK + t] !== 1) continue;
        preset(s, r, p, t);
        m[FLAGS + t] = m[FLAGS + t]! | (m[PRE_TIER + t]! <= 1 ? F_VIS_TIER : F_VIS_RARE);
      }
      break;
  }
}

// ── замена ──────────────────────────────────────────────────────────────────

/**
 * Замена узника в камере надзирателя. Порядок орудий — догадка: Козёл
 * отпущения → бросок → Столб → Пест → Дева → Секира → Весы → Бивень.
 */
export function swap(s: State, r: Rng, p: Params): void {
  const m = s.m;
  const c = m[WARDEN]!;
  m[USED] = USED_SWAP;
  m[NEXT] = P_DAYEND;
  const oldTier = m[TIER + c]!;
  const oldBeast = m[BEAST + c]!;
  if (oldTier < 0) return;
  const tusk = (m[FLAGS + c]! & F_TUSK) !== 0;
  forget(s, c);

  let tier: number;
  const others = inmateMask(s) & ~(1 << c);
  if (hasTool(s, TOOL.scapegoat) && popcount(others) >= p.scapegoatRemoves) {
    let mask = others;
    for (let i = 0; i < p.scapegoatRemoves; i++) {
      const t = pickBit(mask, r);
      mask &= ~(1 << t);
      remove(s, r, p, t);
    }
    tier = oldTier + 1;
  } else {
    let floor = hasTool(s, TOOL.rope) ? 2 : 0;
    if (floor < 1 && hasTool(s, TOOL.hook)) floor = 1;
    tier = rollTier(r, p.replaceOdds, floor);
  }
  let beast = r.int(4);
  if (hasTool(s, TOOL.stake) && oldTier < LEGENDARY && tier < LEGENDARY && r.chance(p.stakeChance)) tier = LEGENDARY;
  if (hasTool(s, TOOL.pestle)) beast = oldBeast;

  m[FLAGS + c] = 0;
  m[BEAST + c] = beast;
  m[TIER + c] = tier;
  settleTier(s, r, p, c);

  if (hasTool(s, TOOL.maiden) && m[TIER + c]! >= 0) {
    let above = 0;
    let below = 0;
    for (let t = 1; t < CELLS; t++) {
      if (t === c || m[TIER + t]! < 0) continue;
      if (m[TIER + t]! > tier) above++;
      else if (m[TIER + t]! < tier) below++;
    }
    if (above === below) raise(s, r, p, c, p.maidenBonus);
  }
  if (hasTool(s, TOOL.axe) && tier > oldTier) for (let i = 0; i < p.axeOpens; i++) openRandom(s, r, p);
  if (hasTool(s, TOOL.scales) && r.chance(p.scalesChance)) revealBest(s, r, p);
  if (tusk && hasTool(s, TOOL.tongs)) raiseRandom(s, r, p, p.tongsTargets, 1);
}

/** Весы тюремщика: показать лучшего узника за запертыми дверями. */
export function revealBest(s: State, r: Rng, p: Params): void {
  const m = s.m;
  let best = -1;
  let mask = 0;
  for (let c = 1; c < CELLS; c++) {
    if (m[LOCK + c] !== 1) continue;
    preset(s, r, p, c);
    const t = m[PRE_TIER + c]!;
    if (t > best) {
      best = t;
      mask = 1 << c;
    } else if (t === best) {
      mask |= 1 << c;
    }
  }
  const c = pickBit(mask, r);
  if (c >= 0) m[FLAGS + c] = m[FLAGS + c]! | F_VIS_TIER | F_VIS_BEAST;
}

// ── выбор орудий и подарков ─────────────────────────────────────────────────

/** Предложить выбор: подарки (все 4) раньше орудий (3 из тех, которых нет). false — предлагать нечего. */
export function makeOffer(s: State, r: Rng): boolean {
  const m = s.m;
  if (m[PICK_GIFTS]! > 0) {
    m[OFFER_KIND] = OFFER_GIFT;
    m[OFFER_N] = 4;
    for (let i = 0; i < 4; i++) m[OFFER + i] = i;
    return true;
  }
  let pool = ALL_TOOLS & ~m[TOOLS]!;
  if (pool === 0) {
    m[PICK_TOOLS] = 0;
    return false;
  }
  m[OFFER_KIND] = OFFER_TOOL;
  let n = 0;
  for (; n < 3 && pool; n++) {
    const t = pickBit(pool, r);
    pool &= ~(1 << t);
    m[OFFER + n] = t;
  }
  m[OFFER_N] = n;
  return true;
}

/** Взять орудие. */
export function takeTool(s: State, tool: number): void {
  const m = s.m;
  m[TOOLS] = m[TOOLS]! | (1 << tool);
  m[PICK_TOOLS] = m[PICK_TOOLS]! - 1;
}

/** Взять подарок сокровищницы. */
export function takeGift(s: State, r: Rng, p: Params, gift: number): void {
  const m = s.m;
  m[PICK_GIFTS] = m[PICK_GIFTS]! - 1;
  switch (gift) {
    case 0: // Трёхглавое кольцо
      for (let i = 0; i < p.ringOpens; i++) openRandom(s, r, p);
      break;
    case 1: // Медный боевой рог: каждый с целью кусает один раз
      for (let c = 1; c < CELLS; c++) {
        if (m[TIER + c]! < 0) continue;
        const t = pickBit(targets(s, c), r);
        if (t >= 0) bite(s, r, p, c, t, false);
      }
      break;
    case 2: // Багряное вино
      for (let c = 1; c < CELLS; c++) if (m[TIER + c]! >= 0 && m[TIER + c]! < LEGENDARY) raise(s, r, p, c, 1);
      break;
    case 3: // Клеймо первородного греха
      brand(s, r, p);
      break;
  }
}

/**
 * До brandCount узников без еды меняют зверя так, чтобы еда появилась.
 * Смена не должна оставить без еды тех, кого клеймо уже накормило.
 */
function brand(s: State, r: Rng, p: Params): void {
  const m = s.m;
  let hungry = 0;
  for (let c = 1; c < CELLS; c++) if (m[TIER + c]! >= 0 && targets(s, c) === 0) hungry |= 1 << c;
  let fed = 0;
  let done = 0;
  while (hungry && done < p.brandCount) {
    const c = pickBit(hungry, r);
    hungry &= ~(1 << c);
    if (targets(s, c) !== 0) continue;
    const old = m[BEAST + c]!;
    let ok = 0;
    for (let b = 0; b < 4; b++) {
      if (b === old) continue;
      m[BEAST + c] = b;
      if (targets(s, c) !== 0 && allFed(s, fed)) ok |= 1 << b;
    }
    const b = pickBit(ok, r);
    m[BEAST + c] = b >= 0 ? b : old;
    if (b >= 0) {
      fed |= 1 << c;
      done++;
    }
  }
}

function allFed(s: State, mask: number): boolean {
  for (let c = 1; c < CELLS; c++) if ((mask >>> c) & 1 && targets(s, c) === 0) return false;
  return true;
}

// ── начало забега ───────────────────────────────────────────────────────────

export interface RunSetup {
  start: number;
  objective: number;
  tools: number;
  startPick: boolean;
}

/** Новый забег: надзиратель в допросной, камеры заперты, события за дверями. */
export function newRun(s: State, r: Rng, p: Params, setup: RunSetup): void {
  const m = s.m;
  m.fill(0);
  for (let c = 0; c < CELLS; c++) {
    m[BEAST + c] = -1;
    m[TIER + c] = -1;
    m[PRE_TIER + c] = -1;
    m[PRE_BEAST + c] = -1;
    if (c !== OFFICE) {
      m[LOCK + c] = 1;
      if (r.chance(p.doorEvent)) m[EVT + c] = randomEvent(r) + 1;
    }
  }
  m[WARDEN] = OFFICE;
  m[START] = setup.start;
  m[DAY_LIMIT] = setup.start === START_EVENT.ironlaw ? p.ironLawDays : p.days;
  m[REROLLS] = p.rerolls;
  m[CHAIN_EATER] = -1;
  m[HUNT_LION] = -1;
  m[HUNT_PREY] = -1;
  m[TOOLS] = setup.tools & ALL_TOOLS;
  m[PICK_TOOLS] = setup.startPick ? 1 : 0;
  m[NEXT] = P_MORNING;
  setObjective(s, r, p, setup.objective);
}
