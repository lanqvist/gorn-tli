/**
 * Правила тюрьмы (rules.md §1–10): двери, рост, пожирание, утро, события,
 * замена, подарки, цели. Функции меняют состояние на месте и ставят NEXT;
 * куда ход переходит дальше, решает settle() в actions.ts.
 *
 * Наборы камер — 16-битные маски (бит c — камера c): так выбор случайной
 * камеры не требует буферов и не аллоцирует.
 */

import { EVENT_SPEC, TOOL_OFFER, TOOL_SPEC } from '../client-tables.js';
import {
  CELLS, EVENT, EVENT_IDS, EVENT_POOL, LEGENDARY, LION, MAMMOTH, OBJECTIVE, OBJECTIVE_IDS, OFFICE, PRISMATIC, RAT,
  START_EVENT, SUPREME, TOOL, TOOL_IDS, WOLF, type Params, type TierOdds,
} from '../model.js';
import type { Rng } from './rng.js';
import {
  BEAST, CHAIN_EATER, CHAIN_REACTION, DAY, DAY_LIMIT, DOORS, DOORS_N, EVT, FLAGS, F_SCRATCH, F_TUSK, F_VIS_BEAST,
  F_VIS_RARE, F_VIS_TIER, LOCK, NEST, PREY_LEFT, PREY_LION, NEXT, OBJECTIVE_ID, OBJ_DONE, OBJ_PROGRESS,
  OFFER, OFFER_GIFT, OFFER_KIND, OFFER_N, OFFER_TOOL, OFFICE_LEFT, PICK_TOOLS, PICK_GIFTS, PRE_BEAST, PRE_TIER,
  P_CHAIN, P_DAYEND, P_END, P_EVENT, P_MANAGE, P_MORNING, P_OFFICE, P_PATROL, P_RATWAY, REROLLS, START, STAT_BITES,
  START_PENDING, STAT_DEVOURS, STAT_EVENTS, STAT_OPENED, STAT_STEPS, STORAGE, TIER, TOOLS, USED, USED_DEVOUR, USED_HUNT,
  USED_SWAP, USURP,
  WARDEN,
  type State, dist, hasTool,
} from './state.js';

// ── маски ───────────────────────────────────────────────────────────────────

/** Первая еда: мамонт → лев, лев → волк, волк → крыса, крыса → мамонт. */
export const FIRST_FOOD = [LION, WOLF, RAT, MAMMOTH] as const;
/** Вторая еда на любой редкости (tlidb «Преимущество»): мамонт → волк, лев → крыса. */
export const SECOND_FOOD = [WOLF, RAT, -1, -1] as const;

const ALL_TOOLS = (1 << TOOL_IDS.length) - 1;
const POOL = EVENT_POOL.map((id) => EVENT[id]);

// Таблицы клиента (client-tables.ts) в виде массивов по номеру события / орудия.
const SPAWN_ANY = 0, SPAWN_OPENED = 1, SPAWN_UNOPENED = 2;
const EVENT_W = EVENT_IDS.map((id) => EVENT_SPEC[id].weight);
const EVENT_SPAWN = EVENT_IDS.map((id) => {
  const sp = EVENT_SPEC[id].spawn;
  return sp === 'opened' ? SPAWN_OPENED : sp === 'unopened' ? SPAWN_UNOPENED : SPAWN_ANY;
});
/** Маска орудий, при которых событие не выпадает (ExcludeRelic). */
const EVENT_EXCL = EVENT_IDS.map((id) => EVENT_SPEC[id].excludeTools.reduce((m, t) => m | (1 << TOOL[t]), 0));
const TOOL_W = TOOL_IDS.map((id) => TOOL_SPEC[id].weight);
/** Маска орудий, исключённых этим орудием (Exclude). */
const TOOL_EXCL = TOOL_IDS.map((id) => TOOL_SPEC[id].exclude.reduce((m, t) => m | (1 << TOOL[t]), 0));
const offerW = new Int32Array(TOOL_IDS.length);

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

/**
 * Вес события ev для камеры c: базовый Weight (клиент event 201–255), 0 —
 * событие здесь не выпадает: камера не того состояния (SpawnCellState), у
 * игрока исключающее орудие (ExcludeRelic) или ступени Узурпации нет в пуле.
 * Текущая ступень Узурпации после I весит usurpNextWeight. [допущение: её
 * базовый вес 0, как ступень получает вес — не найдено]
 */
export function eventWeight(s: State, p: Params, ev: number, c: number): number {
  const m = s.m;
  const sp = EVENT_SPAWN[ev]!;
  if (sp === SPAWN_OPENED ? m[LOCK + c] === 1 : sp === SPAWN_UNOPENED && m[LOCK + c] !== 1) return 0;
  if ((m[TOOLS]! & EVENT_EXCL[ev]!) !== 0) return 0;
  if (ev >= EVENT.usurp1 && ev <= EVENT.usurp4) {
    if (m[USURP] !== ev) return 0;
    return ev === EVENT.usurp1 ? EVENT_W[ev]! : p.usurpNextWeight;
  }
  return EVENT_W[ev]!;
}

/**
 * Событие для камеры c: взвешенный выбор среди допустимых для неё (13
 * постоянных и текущая ступень Узурпации). −1 — допустимых нет. Модель
 * «сначала камера, потом событие под её состояние» — допущение: порядок
 * выбора у сервера не найден.
 */
function randomEvent(s: State, r: Rng, p: Params, c: number): number {
  const u = s.m[USURP]!;
  let total = 0;
  for (let i = 0; i < POOL.length; i++) total += eventWeight(s, p, POOL[i]!, c);
  if (u >= 0) total += eventWeight(s, p, u, c);
  if (total <= 0) return -1;
  let x = r.int(total);
  for (let i = 0; i < POOL.length; i++) {
    x -= eventWeight(s, p, POOL[i]!, c);
    if (x < 0) return POOL[i]!;
  }
  return u;
}

/** Поставить событие в камеру c (если есть допустимое). */
function putEvent(s: State, r: Rng, p: Params, c: number): void {
  const ev = randomEvent(s, r, p, c);
  if (ev >= 0) s.m[EVT + c] = ev + 1;
}

/** Поставить событие в случайную камеру из mask. */
function addEvent(s: State, r: Rng, p: Params, mask: number): void {
  const c = pickBit(mask, r);
  if (c >= 0) putEvent(s, r, p, c);
}

function eventCount(s: State): number {
  let n = 0;
  for (let c = 1; c < CELLS; c++) if (s.m[EVT + c] !== 0) n++;
  return n;
}

/**
 * Клиент 310 «棋盘最小事变标记数» = 1: меток событий на поле не меньше
 * eventMin. Добираются сразу, как сработала последняя метка, в случайную
 * камеру без события, открытую или запертую, кроме камеры надзирателя
 * [замер 19.10: 206 доборов на кадрах — равномерно по камерам и шагам, в
 * камеру надзирателя ни разу; лог — сразу после окна события, утром ни разу].
 */
export function topUpEvents(s: State, r: Rng, p: Params): void {
  for (let n = eventCount(s); n < p.eventMin; n++) addEvent(s, r, p, noEventMask(s));
}

function noEventMask(s: State): number {
  let mask = 0;
  const w = s.m[WARDEN]!;
  for (let c = 1; c < CELLS; c++) if (s.m[EVT + c] === 0 && c !== w) mask |= 1 << c;
  return mask;
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
  for (let t = 1; t < CELLS; t++) if (m[PREY_LEFT + t]! > 0 && (t === c || m[PREY_LION + t] === c)) m[PREY_LEFT + t] = 0;
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
  if (m[EVT + c] === 0 && r.chance(p.relockEvent)) putEvent(s, r, p, c);
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

function isFood(eater: number, food: number): boolean {
  return food === FIRST_FOOD[eater] || food === SECOND_FOOD[eater];
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
  const f2 = SECOND_FOOD[be]!;
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
      (food && (tt === te || (anyTier && tt < te))) ||
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
 * Укус (одно Пожирание): e съедает t. Съеденный пропадает (камера запирается
 * или, с «Переполненной клеткой», сразу открывается с новым узником), едок
 * растёт и меняет зверя. «После Пожирания» срабатывает после каждого укуса,
 * цепочки тоже: карты зовут её «цепным Пожиранием».
 */
export function bite(s: State, r: Rng, p: Params, e: number, t: number, inChain: boolean): void {
  const m = s.m;
  const te = m[TIER + e]!;
  const be = m[BEAST + e]!;
  const door = m[LOCK + t] === 1;
  const tt = door ? m[PRE_TIER + t]! : m[TIER + t]!;
  const bt = door ? m[PRE_BEAST + t]! : m[BEAST + t]!;
  // Намордник (101): «на поле не более 4 узников» — до укуса, считая едока и жертву.
  // Кадры 18.10: при 4 узниках после укуса (5 до) +2 не было ни разу (4 из 4), при 3 до — было.
  const fieldBefore = popcount(inmateMask(s));

  let gain = 1;
  if (door) gain = p.clawsGain;
  else if (be === MAMMOTH && hasTool(s, TOOL.maul) && isFood(be, bt)) gain = Math.max(1, tt + 2 - te);
  // Клиент 146: после поедания ниже по редкости Гильотиной — «Подавление».
  else if (tt < te && be === WOLF && bt === RAT && hasTool(s, TOOL.guillotine) && !r.chance(1 - p.oppressStep * (te - tt))) gain = 0;
  // Шампур (148): +2 за поедание крысы крысой. Кадры 18.10: крыса, съевшая мамонта
  // с Шампуром, получала только +1 (2 цепочки в забеге 13:11).
  if (be === RAT && bt === RAT && hasTool(s, TOOL.skewer)) gain += p.skewerBonus;
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

  if (hasTool(s, TOOL.muzzle) && fieldBefore <= p.muzzleLeft) gain += p.muzzleBonus;

  m[STAT_BITES] = m[STAT_BITES]! + 1;
  if (p.jungleCountsBites) progress(s, r, p, OBJECTIVE.jungle, 1);

  raise(s, r, p, e, gain);
  if (m[TIER + e]! < 0) return;
  if (m[START] !== START_EVENT.cagefight) {
    const nb = r.int(4);
    if (nb !== be) forget(s, e);
    m[BEAST + e] = nb;
  }
  afterDevour(s, r, p, e);
}

/** «Ржавая пила» и «Железная дева мстителя»: после каждого Пожирания. */
function afterDevour(s: State, r: Rng, p: Params, e: number): void {
  const m = s.m;
  if (hasTool(s, TOOL.saw) && r.chance(p.sawChance)) raise(s, r, p, e, 1);
  if (m[TIER + e]! >= 0 && hasTool(s, TOOL.revenge) && r.chance(p.revengeChance)) openFood(s, r, p, e);
}

/**
 * Открыть случайную запертую камеру с узником, которого e гарантированно
 * может съесть (клиент 104, 221): его редкости, зверь — случайный из тех,
 * над кем у e преимущество. [догадка: как выбирается зверь]
 */
function openFood(s: State, r: Rng, p: Params, e: number): void {
  const m = s.m;
  const c = pickBit(lockedMask(s), r);
  if (c < 0) return;
  const be = m[BEAST + e]!;
  const second = SECOND_FOOD[be]!;
  m[PRE_TIER + c] = m[TIER + e]!;
  m[PRE_BEAST + c] = second >= 0 && r.int(2) === 1 ? second : FIRST_FOOD[be]!;
  openCell(s, r, p, c);
}

/** Копия узника камеры c в случайной запертой камере, она открывается. */
function copyInmate(s: State, r: Rng, p: Params, c: number): void {
  const m = s.m;
  const d = pickBit(lockedMask(s), r);
  if (d < 0) return;
  m[PRE_TIER + d] = m[TIER + c]!;
  m[PRE_BEAST + d] = m[BEAST + c]!;
  openCell(s, r, p, d);
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
    finishDevour(s);
  }
}

/** Конец Пожирания (цепочка кончилась или «Отменить»): день завершается. */
export function finishDevour(s: State): void {
  const m = s.m;
  m[CHAIN_EATER] = -1;
  m[NEXT] = P_DAYEND;
}

// ── утро ────────────────────────────────────────────────────────────────────

/**
 * Утро: утренние орудия, затем пункты назначения. Порядок орудий — догадка:
 * гнёзда, удушающая цепь, монета, щипцы, когти, ящик, «Добыча».
 */
export function morning(s: State, r: Rng, p: Params): void {
  const m = s.m;
  if (m[START_PENDING] === 1) {
    m[START_PENDING] = 0;
    startBoard(s, r, p);
  }

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

  // Клиент 141, 145, 147: каждое утро по одной новой метке. Камера с меткой
  // второй раз не выбирается. [догадка: метки не складываются]
  if (hasTool(s, TOOL.tongs)) {
    let mammoths = 0;
    for (let c = 1; c < CELLS; c++) {
      if (m[TIER + c]! >= 0 && m[BEAST + c] === MAMMOTH && !(m[FLAGS + c]! & F_TUSK)) mammoths |= 1 << c;
    }
    const c = pickBit(mammoths, r);
    if (c >= 0) m[FLAGS + c] = m[FLAGS + c]! | F_TUSK;
  }

  if (hasTool(s, TOOL.claws)) {
    let free = 0;
    for (let c = 1; c < CELLS; c++) if (m[LOCK + c] === 1 && !(m[FLAGS + c]! & F_SCRATCH)) free |= 1 << c;
    const c = pickBit(free, r);
    if (c >= 0) {
      preset(s, r, p, c);
      m[FLAGS + c] = m[FLAGS + c]! | F_SCRATCH | F_VIS_TIER;
    }
  }

  if (hasTool(s, TOOL.ironbox)) {
    let free = 0;
    for (let c = 1; c < CELLS; c++) if (m[LOCK + c] === 1 && m[NEST + c] === 0) free |= 1 << c;
    const c = pickBit(free, r);
    if (c >= 0) m[NEST + c] = p.ironboxDays;
  }

  // Метка «Добыча» (tlidb): 3 хода, в начале каждого дня лев и добыча +1.
  for (let prey = 1; prey < CELLS; prey++) {
    if (m[PREY_LEFT + prey]! <= 0) continue;
    const lion = m[PREY_LION + prey]!;
    m[PREY_LEFT + prey] = m[PREY_LEFT + prey]! - 1;
    raise(s, r, p, prey, 1);
    if (lion > 0) raise(s, r, p, lion, 1);
  }

  dealDoors(s, r, p);
  m[NEXT] = P_PATROL;
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

/**
 * Монета участи братьев (клиент 113): случайно убирает 1 идентичного узника,
 * затем случайный из оставшихся идентичных ему +2.
 */
function coin(s: State, r: Rng, p: Params): void {
  const m = s.m;
  let twins = 0;
  for (let a = 1; a < CELLS; a++) {
    if (m[TIER + a]! < 0) continue;
    for (let b = 1; b < CELLS; b++) {
      if (b !== a && m[TIER + b] === m[TIER + a] && m[BEAST + b] === m[BEAST + a]) twins |= 1 << a;
    }
  }
  const gone = pickBit(twins, r);
  if (gone < 0) return;
  let rest = 0;
  for (let b = 1; b < CELLS; b++) {
    if (b !== gone && m[TIER + b] === m[TIER + gone] && m[BEAST + b] === m[BEAST + gone]) rest |= 1 << b;
  }
  remove(s, r, p, gone);
  const c = pickBit(rest, r);
  if (c >= 0) raise(s, r, p, c, p.coinBonus);
}

/**
 * Кого лев в камере надзирателя может пометить «Выслеживанием» (Окровавленный
 * капкан): его цели Пожирания за открытыми дверями. Пока метка «Добыча»
 * держится, новой нет. [догадка: цели — те, кого можно съесть]
 */
export function huntTargets(s: State): number {
  const m = s.m;
  const w = m[WARDEN]!;
  if (!hasTool(s, TOOL.trap) || m[BEAST + w] !== LION || m[TIER + w]! < 0) return 0;
  let marked = 0;
  for (let c = 1; c < CELLS; c++) if (m[PREY_LEFT + c]! > 0) marked |= 1 << c;
  return targets(s, w) & ~lockedMask(s) & ~marked;
}

/** «Выслеживание»: лев надзирателя метит добычу; это действие дня. */
export function hunt(s: State, prey: number, p: Params): void {
  const m = s.m;
  m[PREY_LION + prey] = m[WARDEN]!;
  m[PREY_LEFT + prey] = p.trapMornings;
  m[USED] = USED_HUNT;
  m[NEXT] = P_DAYEND;
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
  arrive(s, r, p, cell);
}

/** «Крысиная тропа»: переход без шагов; дверь открывается, орудия обхода не срабатывают. */
export function ratway(s: State, r: Rng, p: Params, cell: number): void {
  s.m[WARDEN] = cell;
  openCell(s, r, p, cell);
  arrive(s, r, p, cell);
}

function arrive(s: State, r: Rng, p: Params, cell: number): void {
  const m = s.m;
  if (cell === OFFICE) {
    tyrannyArrive(s, r, p);
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
  if (hasTool(s, TOOL.fire) && m[TIER + c]! >= 0 && r.chance(p.fireChance)) copyInmate(s, r, p, c);
  if (hasTool(s, TOOL.blacklist) && popcount(lockedMask(s)) <= p.blacklistLocked) {
    raiseRandom(s, r, p, p.blacklistCount, 1);
  }
}

// ── допросная ───────────────────────────────────────────────────────────────

/** Выборов в допросной за визит: один. */
export function officeRounds(_s: State, _p: Params): number {
  return 1;
}

/**
 * «Подстрекнуть» (глоссарий 16000108): событие в случайную камеру. Камера —
 * любая без события, открытая или запертая (события бывают и для открытых,
 * SpawnCellState 803). [допущение: камеру с событием не выбирает]
 */
function instigate(s: State, r: Rng, p: Params): void {
  let mask = noEventMask(s);
  for (let i = 0; i < p.instigateDoors && mask; i++) {
    const c = pickBit(mask, r);
    mask &= ~(1 << c);
    putEvent(s, r, p, c);
  }
}

/**
 * «Злоупотребление властью» (клиент 301): при каждой остановке в допросной
 * ещё tyrannyExtra раз автоматически Подстрекнуть и Наградить. [догадка:
 * срабатывают при приходе, до выбора игрока, сначала Подстрекнуть]
 */
export function tyrannyArrive(s: State, r: Rng, p: Params): void {
  if (s.m[START] !== START_EVENT.tyranny) return;
  for (let i = 0; i < p.tyrannyExtra; i++) {
    instigate(s, r, p);
    raiseRandom(s, r, p, 1, 1);
  }
}

export function office(s: State, r: Rng, p: Params, choose: boolean): void {
  const m = s.m;
  if (choose) instigate(s, r, p);
  else raiseRandom(s, r, p, 1, 1);
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
  if (accept && ev >= 0) {
    m[STAT_EVENTS] = m[STAT_EVENTS]! + 1;
    runEvent(s, r, p, c, ev);
    progress(s, r, p, OBJECTIVE.currents, 1);
  }
  topUpEvents(s, r, p);
}

/** Действие события ev в камере c. */
export function runEvent(s: State, r: Rng, p: Params, c: number, ev: number): void {
  const m = s.m;
  switch (ev) {
    case EVENT.chain:
      m[CHAIN_REACTION] = 1;
      break;
    case EVENT.execution: {
      // Клиент 222: все низшие узники, над которыми у текущего преимущество; +1 за каждого.
      const te = m[TIER + c]!;
      if (te < 0) break;
      const be = m[BEAST + c]!;
      let n = 0;
      for (let t = 1; t < CELLS; t++) {
        if (t !== c && m[TIER + t]! >= 0 && m[TIER + t]! < te && isFood(be, m[BEAST + t]!)) {
          remove(s, r, p, t);
          n++;
        }
      }
      raise(s, r, p, c, n);
      break;
    }
    case EVENT.behind: {
      if (m[TIER + c]! < 0) break;
      // «Дефицитное кодовое имя» (tlidb): меньше всех на поле, считая 0 и самого узника.
      let c0 = 0, c1 = 0, c2 = 0, c3 = 0;
      for (let t = 1; t < CELLS; t++) {
        if (m[TIER + t]! < 0) continue;
        const b = m[BEAST + t];
        if (b === 0) c0++;
        else if (b === 1) c1++;
        else if (b === 2) c2++;
        else c3++;
      }
      const min = Math.min(c0, c1, c2, c3);
      const mask = (c0 === min ? 1 : 0) | (c1 === min ? 2 : 0) | (c2 === min ? 4 : 0) | (c3 === min ? 8 : 0);
      const nb = pickBit(mask, r);
      if (nb !== m[BEAST + c]) forget(s, c);
      m[BEAST + c] = nb;
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
      // Клиент 201: камера с узником не ниже Легендарной. [догадка: доли — шансы двери от Легендарной]
      const t = pickBit(lockedMask(s), r);
      if (t < 0) break;
      m[PRE_TIER + t] = rollTier(r, p.doorOdds, LEGENDARY);
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
      // Клиент 252–255: I — 1 узник +1, II — 1 узник +2, III — 2 узника +2,
      // IV — все +2. Ступень заменяет себя в пуле следующей, IV уходит из пула.
      const level = ev - EVENT.usurp1;
      const n = p.usurpCount[level]!;
      raiseRandom(s, r, p, n < 0 ? CELLS : n, p.usurpGain[level]!);
      if (m[USURP] === ev) m[USURP] = ev === EVENT.usurp4 ? -1 : ev + 1;
      break;
    }
    case EVENT.ratway:
      m[NEXT] = P_RATWAY;
      break;
    case EVENT.treasure:
      // Карта разведывает камеры ниже Редкой; про остальные игрок выводит «не ниже Редкой».
      for (let t = 1; t < CELLS; t++) {
        if (m[LOCK + t] !== 1) continue;
        preset(s, r, p, t);
        m[FLAGS + t] = m[FLAGS + t]! | (m[PRE_TIER + t]! <= 1 ? F_VIS_TIER : F_VIS_RARE);
      }
      break;
    case EVENT.rival:
      if (m[TIER + c]! >= 0) openFood(s, r, p, c);
      break;
    case EVENT.luck: {
      if (m[TIER + c]! < 0) break;
      let n = 0;
      for (let t = 1; t < CELLS; t++) if (t !== c && m[TIER + t]! >= 0 && m[BEAST + t] === m[BEAST + c]) n++;
      raise(s, r, p, c, n);
      break;
    }
    case EVENT.escort:
      if (m[TIER + c]! >= 0) copyInmate(s, r, p, c);
      break;
    case EVENT.extra:
      raiseRandom(s, r, p, p.extraCount, 1);
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
    // Клиент 121: «редкость после замены гарантированно повышается». [догадка: бросок замены не ниже прежней + 1]
    tier = rollTier(r, p.replaceOdds, Math.min(oldTier + 1, PRISMATIC));
  } else {
    let floor = hasTool(s, TOOL.rope) ? 2 : 0;
    if (floor < 1 && hasTool(s, TOOL.hook)) floor = 1;
    tier = rollTier(r, p.replaceOdds, floor);
  }
  let beast = r.int(4);
  if (hasTool(s, TOOL.stake) && oldTier < LEGENDARY && tier < LEGENDARY && r.chance(p.stakeChance)) tier = LEGENDARY;
  if (hasTool(s, TOOL.pestle)) beast = oldBeast;

  // «Бивень» (tlidb) — метка камеры: сходит, только когда в камере нет узника.
  m[FLAGS + c] = tusk ? F_TUSK : 0;
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

/**
 * Вес орудия t в выборе: базовый Weight (клиент relic: 40 у обычных, 5 у
 * особых); 0 — уже есть (MaxObtain 1) или исключено имеющимся (Exclude, в
 * обе стороны). BuildWeightInc не применяется: как сервер его прибавляет —
 * не найдено, поэтому выбор — приближение по базовым весам.
 */
export function toolWeight(s: State, t: number): number {
  const own = s.m[TOOLS]!;
  if ((own >>> t) & 1) return 0;
  if ((TOOL_EXCL[t]! & own) !== 0) return 0;
  for (let o = 0; o < TOOL_IDS.length; o++) if ((own >>> o) & 1 && (TOOL_EXCL[o]! >>> t) & 1) return 0;
  return TOOL_W[t]!;
}

/**
 * Предложить выбор: подарки (все 4) раньше орудий. Орудий TOOL_OFFER (config
 * 320 = 3), взвешенно без повторов среди допустимых. false — предлагать нечего.
 */
export function makeOffer(s: State, r: Rng): boolean {
  const m = s.m;
  if (m[PICK_GIFTS]! > 0) {
    m[OFFER_KIND] = OFFER_GIFT;
    m[OFFER_N] = 4;
    for (let i = 0; i < 4; i++) m[OFFER + i] = i;
    return true;
  }
  let total = 0;
  for (let t = 0; t < TOOL_IDS.length; t++) {
    offerW[t] = toolWeight(s, t);
    total += offerW[t]!;
  }
  if (total === 0) {
    m[PICK_TOOLS] = 0;
    return false;
  }
  m[OFFER_KIND] = OFFER_TOOL;
  let n = 0;
  for (; n < TOOL_OFFER && total > 0; n++) {
    let x = r.int(total);
    let t = 0;
    for (; t < TOOL_IDS.length - 1; t++) {
      x -= offerW[t]!;
      if (x < 0) break;
    }
    total -= offerW[t]!;
    offerW[t] = 0;
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
      forget(s, c);
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

/** Новый забег: надзиратель в допросной, 4 случайные камеры открыты, остальные заперты, метки событий. */
export function newRun(s: State, r: Rng, p: Params, setup: RunSetup): void {
  const m = s.m;
  m.fill(0);
  for (let c = 0; c < CELLS; c++) {
    m[BEAST + c] = -1;
    m[TIER + c] = -1;
    m[PRE_TIER + c] = -1;
    m[PRE_BEAST + c] = -1;
    if (c !== OFFICE) m[LOCK + c] = 1;
  }
  m[USURP] = EVENT.usurp1;
  m[OBJECTIVE_ID] = -1; // цель ставится в конце: стартовые камеры её не двигают
  m[TOOLS] = setup.tools & ALL_TOOLS;
  m[START] = setup.start;
  m[WARDEN] = OFFICE;
  m[DAY_LIMIT] = setup.start === START_EVENT.ironlaw ? p.ironLawDays : p.days;
  m[REROLLS] = p.rerolls;
  m[CHAIN_EATER] = -1;
  for (let c = 0; c < CELLS; c++) {
    m[PREY_LEFT + c] = 0;
    m[PREY_LION + c] = -1;
  }
  m[PICK_TOOLS] = setup.startPick ? 1 : 0;
  m[NEXT] = P_MORNING;
  // С выбором орудия доска за ним ещё не видна: её разыграет первое утро. Иначе
  // решатель на экране выбора считал бы от одной заранее выпавшей доски.
  if (setup.startPick) m[START_PENDING] = 1;
  else startBoard(s, r, p);
  setObjective(s, r, p, setup.objective);
}

/**
 * Стартовая доска: startOpen случайных камер открыто (клиент config 309 = 4;
 * на кадрах первого дня — 4 в 11 забегах из 12), метки событий до eventMin
 * (config 310; на кадрах — ровно 1 во всех 12). Узники по шансам двери без
 * Крюка и не в зачёт «За дверью камеры». [допущение: доска создаётся до
 * выбора стартового орудия]
 */
function startBoard(s: State, r: Rng, p: Params): void {
  const m = s.m;
  for (let i = 0; i < p.startOpen; i++) {
    const c = pickBit(lockedMask(s), r);
    if (c < 0) break;
    const tier = rollTier(r, p.doorOdds, 0);
    m[STAT_OPENED] = m[STAT_OPENED]! + 1;
    place(s, r, p, c, r.int(4), tier);
  }
  for (let c = 1; c < CELLS; c++) if (m[LOCK + c] === 1 && r.chance(p.doorEvent)) putEvent(s, r, p, c);
  topUpEvents(s, r, p);
}
