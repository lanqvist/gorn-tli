/**
 * Мгновенная стратегия: ход без перебора вариантов.
 *
 * Доска оценивается суммой ценностей узников по редкости (веса, настроенные
 * самоигрой) плюс мелкие слагаемые. Пожирание считается точно: цепочка у
 * едока идёт только вверх по редкости, а съеденный всегда ниже следующей
 * ступени, поэтому матожидание цепочки зависит лишь от (редкость, зверь)
 * едока и состава доски — это таблица 6 × 4 × 2, которая заполняется сверху
 * вниз без рекурсии и без аллокаций.
 *
 * Стратегия видит только то, что видит игрок: закреплённых за дверью узников
 * берёт в расчёт, лишь если их редкость показана (F_VIS_*).
 */

import {
  CELLS, DEFAULT_PARAMS, LEGENDARY, LION, MAMMOTH, OFFICE, RAT, START_EVENT, TOOL, TOOL_IDS,
  TOOL_NAMES, WOLF, type Action, type Params,
} from '../model.js';
import {
  A_ACCEPT, A_BESTOW, A_CHAIN, A_DEVOUR, A_END, A_GIFT, A_HUNT, A_INSTIGATE, A_PATROL, A_REROLL,
  A_STOPCHAIN, A_SWAP, A_TOOL, applyCode, decode,
} from '../engine/actions.js';
import { Rng } from '../engine/rng.js';
import {
  FIRST_FOOD, SECOND_FOOD, huntTargets, officeRounds, targets,
} from '../engine/rules.js';
import {
  BEAST, CHAIN_EATER, DAY, DAY_LIMIT, DOORS, DOORS_N, EVT, FLAGS, F_TUSK, F_VIS_BEAST, F_VIS_RARE, F_VIS_TIER, LOCK,
  OFFER, OFFER_GIFT, OFFER_KIND, OFFER_N, PHASE, PICK_GIFTS, PICK_TOOLS, PRE_BEAST, PRE_TIER, P_CHAIN, P_END,
  P_EVENT, P_MANAGE, P_OFFICE, P_PATROL, P_PICK, P_RATWAY, REROLLS, START, STORAGE, State, TIER, TOOLS,
  WARDEN, dist,
} from '../engine/state.js';
import {
  DEFAULT_WEIGHTS, W_AHEAD, W_BRAND, W_CHAIN, W_RING, W_SKIP, W_DOOR, W_EVENT, W_FAR, W_FED, W_GIFT, W_INSTIGATE, W_REROLL, W_SWAP, W_TOOL,
  W_TOOLPICK, W_VAL0, W_VAL1,
} from './weights.js';

// ── рабочие таблицы (модульные, переиспользуются) ───────────────────────────

/** Ценность узника по редкости 0…4; [5] — ценность ухода в хранилище. */
const val = new Float64Array(6);
/** Узники доски: [редкость * 4 + зверь]. */
const cnt = new Int32Array(24);
/** F[(t * 4 + b) * 2 + c]: ценность едока (t, b), который может есть дальше; c — укус в цепочке. */
const F = new Float64Array(6 * 4 * 2);
/** Среднее F по новому зверю: A[t * 2 + c]. */
const A = new Float64Array(6 * 2);
/** Кто выйдет из двери, по редкости (с учётом «Крюка»). */
const pDoor = new Float64Array(6);
/** Кто выйдет при замене. */
const pRep = new Float64Array(6);
/** Выгода Замены гипотетического узника по редкости. */
const swapNew = new Float64Array(5);
/** swapNew посчитана для текущих таблиц (нужна только обходу — считаем по требованию). */
let swapReady = false;

let S: State = new State();
let m: Int32Array = S.m;
let P: Params = DEFAULT_PARAMS;
let W: Float64Array = DEFAULT_WEIGHTS;
let frac = 1;
let prismV = 1;
let tools = 0;
let anyTier = false;
let inmateCount = 0;
let lockedCount = 0;
let valSum = 0;
/** Средний прирост от +1 случайному узнику. */
let avgRise = 0;
/** Ценность нового узника из двери, по шансам. */
let doorNew = 0;
/** Открыть случайную запертую дверь: новый узник минус потерянная дверь. */
let openV = 0;
let crown = false;
let skewer = false;
let maul = false;
let guillotine = false;
/** Есть ли укус в цепочке, отличный от первого (Ошейник): иначе F[..][1] = F[..][0]. */
let chainDiffers = false;
/** Таблица цепочки посчитана для текущего prepare(). */
let chainReady = false;
let pWhip = 0;
let pCollar = 0;
let muzzle = 0;
let cageBonus = 0;

const has = (t: number) => ((tools >>> t) & 1) === 1;

function riseV(t: number, n: number): number {
  const u = t + n;
  return u >= 5 ? prismV : val[u]!;
}

function normalize(out: Float64Array, odds: readonly number[], floor: number): void {
  let sum = 0;
  for (let t = 0; t < 6; t++) sum += t >= floor ? odds[t]! : 0;
  for (let t = 0; t < 6; t++) out[t] = t >= floor && sum > 0 ? odds[t]! / sum : 0;
}

/** Подготовить таблицы для состояния s. */
function prepare(s: State, p: Params, w: Float64Array): void {
  S = s;
  m = s.m;
  P = p;
  W = w;
  const limit = m[DAY_LIMIT]!;
  frac = limit > 0 ? (limit - m[DAY]!) / limit : 0;
  for (let t = 0; t < 5; t++) val[t] = w[W_VAL1 + t]! + (w[W_VAL0 + t]! - w[W_VAL1 + t]!) * frac;
  prismV = m[STORAGE]! >= p.storage ? val[4]! : 1 + w[W_GIFT]!;
  val[5] = prismV;
  tools = m[TOOLS]!;
  anyTier = m[START] === START_EVENT.cagefight;

  cnt.fill(0);
  inmateCount = 0;
  lockedCount = 0;
  valSum = 0;
  let riseSum = 0;
  for (let c = 1; c < CELLS; c++) {
    if (m[LOCK + c] === 1) lockedCount++;
    const t = m[TIER + c]!;
    if (t < 0) continue;
    cnt[t * 4 + m[BEAST + c]!] = cnt[t * 4 + m[BEAST + c]!]! + 1;
    inmateCount++;
    valSum += val[t]!;
    riseSum += riseV(t, 1) - val[t]!;
  }
  avgRise = inmateCount > 0 ? riseSum / inmateCount : 0;

  crown = has(TOOL.crown);
  skewer = has(TOOL.skewer);
  maul = has(TOOL.maul);
  guillotine = has(TOOL.guillotine);
  pWhip = has(TOOL.whip) ? p.whipChance : 0;
  pCollar = has(TOOL.collar) ? p.collarChance : 0;
  muzzle = has(TOOL.muzzle) && inmateCount - 1 <= p.muzzleLeft ? p.muzzleBonus : 0;
  chainDiffers = pCollar > 0;
  chainReady = false;
}

/** Шансы дверей и замены, таблица цепочки: нужны обходу, пожиранию и цепочке, считаются по требованию. */
function ensureChain(): void {
  if (chainReady) return;
  chainReady = true;
  normalize(pDoor, P.doorOdds, has(TOOL.hook) ? 1 : 0);
  normalize(pRep, P.replaceOdds, has(TOOL.rope) ? 2 : has(TOOL.hook) ? 1 : 0);
  doorNew = 0;
  for (let t = 0; t < 6; t++) doorNew += pDoor[t]! * val[t]!;
  openV = doorNew - W[W_DOOR]! * frac;
  cageBonus = has(TOOL.cage) ? P.cageChance * doorNew : 0;
  fillChain();
  swapReady = false;
}

/** Ценность после укуса: едок поднялся до base (+ случайные добавки). */
function afterBite(t: number, b: number, base: number, chain: number): number {
  const pc = chain ? pCollar : 0;
  const p0 = (1 - pWhip) * (1 - pc);
  const p2 = pWhip * pc;
  const p1 = 1 - p0 - p2;
  return p0 * next(t + base, b) + p1 * next(t + base + 1, b) + p2 * next(t + base + 2, b);
}

function next(t: number, b: number): number {
  if (t >= 5) return prismV;
  return anyTier ? F[(t * 4 + b) * 2 + 1]! : A[t * 2 + 1]!;
}

/** Базовый прирост укуса: 1, Молот, добавки Шампура, Короны и Намордника. */
function baseGain(be: number, te: number, food: boolean, tt: number): number {
  let g = be === MAMMOTH && food && maul ? Math.max(1, tt + 2 - te) : 1;
  if (be === RAT && skewer) g += P.skewerBonus;
  if (be === LION && crown) g += P.crownBonus;
  return g + muzzle;
}

/** Вариант укуса: съесть узника редкости u. */
function biteOption(t: number, b: number, c: number, u: number, isFood: boolean): number {
  return -val[u]! + cageBonus + afterBite(t, b, baseGain(b, t, isFood, u), c);
}

function hasFood(u: number, f1: number, f2: number): boolean {
  return cnt[u * 4 + f1]! > 0 || (f2 >= 0 && cnt[u * 4 + f2]! > 0);
}

/** Лучший вариант укуса для едока (t, b) по составу доски; −∞, если есть некого. */
function bestBite(t: number, b: number, c: number): number {
  const f1 = FIRST_FOOD[b]!;
  const f2 = SECOND_FOOD[b]!;
  let best = -Infinity;
  const row = t * 4;
  if (hasFood(t, f1, f2)) best = biteOption(t, b, c, t, true);
  else if (b === LION && crown && cnt[row]! + cnt[row + 1]! + cnt[row + 2]! + cnt[row + 3]! > 0) best = biteOption(t, b, c, t, false);
  else if (b === RAT && skewer && cnt[row + RAT]! > 0) best = biteOption(t, b, c, t, false);
  // «Схватка узников» (клиент 304) — еда ниже по редкости; Молот (142) — выше.
  if (anyTier) for (let u = 0; u < t; u++) if (hasFood(u, f1, f2)) best = Math.max(best, biteOption(t, b, c, u, true));
  if (b === MAMMOTH && maul) for (let u = t + 1; u < 5; u++) if (hasFood(u, f1, f2)) best = Math.max(best, biteOption(t, b, c, u, true));
  if (b === WOLF && guillotine) {
    for (let u = 0; u < t; u++) if (cnt[u * 4 + RAT]! > 0) best = Math.max(best, biteOption(t, b, c, u, false));
  }
  return best;
}

function fillChain(): void {
  for (let b = 0; b < 4; b++) for (let c = 0; c < 2; c++) F[(5 * 4 + b) * 2 + c] = prismV;
  A[10] = prismV;
  A[11] = prismV;
  for (let t = 4; t >= 0; t--) {
    // c = 1 первым: варианты c = 0 смотрят только на ступени выше, а там уже всё посчитано
    for (let c = 1; c >= 0; c--) {
      if (c === 0 && !chainDiffers) {
        for (let b = 0; b < 4; b++) F[(t * 4 + b) * 2] = F[(t * 4 + b) * 2 + 1]!;
        A[t * 2] = A[t * 2 + 1]!;
        continue;
      }
      let sum = 0;
      for (let b = 0; b < 4; b++) {
        const v = Math.max(val[t]!, bestBite(t, b, c));
        F[(t * 4 + b) * 2 + c] = v;
        sum += v;
      }
      A[t * 2 + c] = sum / 4;
    }
  }
}

// ── оценки ходов ────────────────────────────────────────────────────────────

/** Выгода укуса e → j (от ценности едока до укуса). */
function biteGain(e: number, j: number, chain: number): number {
  const te = m[TIER + e]!;
  const be = m[BEAST + e]!;
  let cost: number;
  let base: number;
  if (m[LOCK + j] === 1) {
    cost = 0; // Когти: сквозь дверь, камера остаётся запертой
    base = P.clawsGain + muzzle;
  } else {
    const tt = m[TIER + j]!;
    const bt = m[BEAST + j]!;
    const food = bt === FIRST_FOOD[be] || bt === SECOND_FOOD[be];
    cost = val[tt]! - cageBonus;
    base = baseGain(be, te, food, tt);
  }
  return -cost + afterBite(te, be, base, chain) - val[te]!;
}

/** Выгода Замены узника редкости t (в камере c, −1 — гипотетический). */
function swapGain(t: number, c: number): number {
  let v: number;
  let pUp = 0;
  const others = inmateCount - (c >= 0 ? 1 : 0);
  if (has(TOOL.scapegoat) && others >= P.scapegoatRemoves) {
    const avgOther = others > 0 ? (valSum - (c >= 0 ? val[t]! : 0)) / others : 0;
    v = riseV(t, 1) - P.scapegoatRemoves * avgOther;
    pUp = 1;
  } else {
    v = 0;
    const stake = has(TOOL.stake) && t < LEGENDARY ? P.stakeChance : 0;
    for (let u = 0; u < 6; u++) {
      const q = pRep[u]!;
      if (q === 0) continue;
      if (u < LEGENDARY && stake > 0) {
        v += q * ((1 - stake) * val[u]! + stake * val[LEGENDARY]!);
        if (u > t) pUp += q * (1 - stake);
        if (LEGENDARY > t) pUp += q * stake;
      } else {
        v += q * val[u]!;
        if (u > t) pUp += q;
      }
    }
  }
  if (has(TOOL.axe)) v += pUp * P.axeOpens * openV;
  if (c >= 0 && has(TOOL.tongs) && (m[FLAGS + c]! & F_TUSK) !== 0) v += P.tongsTargets * avgRise;
  return v - val[t]! + W[W_SWAP]!;
}

/** Лучшее действие дня для узника в камере c: 0 — конец дня. */
function manageValue(c: number): number {
  const t = m[TIER + c]!;
  if (t < 0) return 0;
  let best = Math.max(0, swapGain(t, c));
  const mask = targets(S, c);
  for (let j = 1; j < CELLS; j++) if ((mask >>> j) & 1) best = Math.max(best, biteGain(c, j, 0));
  return best;
}

/** Ценность нового узника (t, b) в камере и его лучшего действия сегодня. */
function newInmateValue(t: number, b: number): number {
  const dev = F[(t * 4 + b) * 2]! - val[t]!;
  if (!swapReady) {
    for (let u = 0; u < 5; u++) swapNew[u] = swapGain(u, -1);
    swapReady = true;
  }
  return val[t]! + Math.max(0, dev, swapNew[t]!);
}

/** Узник за запертой дверью d: ожидаемая ценность с действием дня. */
function doorInmateValue(d: number): number {
  const fl = m[FLAGS + d]!;
  if (fl & F_VIS_TIER) {
    const t = m[PRE_TIER + d]!;
    if (fl & F_VIS_BEAST) return newInmateValue(t, m[PRE_BEAST + d]!);
    let v = 0;
    for (let b = 0; b < 4; b++) v += newInmateValue(t, b);
    return v / 4;
  }
  let sum = 0;
  let norm = 0;
  const floor = fl & F_VIS_RARE ? 2 : 0;
  for (let t = floor; t < 5; t++) {
    const q = pDoor[t]!;
    if (q === 0) continue;
    let v = 0;
    for (let b = 0; b < 4; b++) v += newInmateValue(t, b);
    sum += (q * v) / 4;
    norm += q;
  }
  return norm > 0 ? sum / norm : 0;
}

function bestowValue(): number {
  return avgRise;
}

function instigateValue(): number {
  let free = 0;
  for (let c = 1; c < CELLS; c++) if (m[EVT + c] === 0) free++;
  return Math.min(P.instigateDoors, free) * W[W_INSTIGATE]!;
}

/** Ценность прихода в камеру c (без орудий хода). */
function cellValue(c: number): number {
  if (c === OFFICE) {
    const bv = bestowValue();
    const iv = instigateValue();
    // «Злоупотребление властью» (клиент 301): ещё автоматически Подстрекнуть и Наградить
    const auto = m[START] === START_EVENT.tyranny ? P.tyrannyExtra * (bv + iv) : 0;
    return officeRounds(S, P) * Math.max(bv, iv) + auto;
  }
  let v = m[EVT + c] !== 0 ? W[W_EVENT]! : 0;
  if (m[LOCK + c] !== 1) return v + manageValue(c);
  v += doorInmateValue(c) - W[W_DOOR]! * frac;
  // орудия при открытии обходом
  if (has(TOOL.dogtag)) v += P.dogtagChance * avgRise;
  if (has(TOOL.keys)) {
    const l = m[LOCK + ((c + CELLS - 1) & (CELLS - 1))] === 1 ? 1 : 0;
    const r = m[LOCK + ((c + 1) & (CELLS - 1))] === 1 ? 1 : 0;
    v += P.keysChance * (l + r) * openV;
  }
  if (has(TOOL.forged)) v += P.forgedChance * openV;
  if (has(TOOL.fire)) v += P.fireChance * openV;
  if (has(TOOL.blacklist) && lockedCount - 1 <= P.blacklistLocked) v += P.blacklistCount * avgRise;
  return v;
}

/** Притягательность камер для обхода: ценность прихода (без орудий хода), не меньше 0. */
const attr = new Float64Array(CELLS);

function fillAttr(): void {
  for (let c = 0; c < CELLS; c++) attr[c] = Math.max(0, cellValue(c));
}

/**
 * Ценность хода к двери c. Кроме самой камеры — что окажется впереди
 * (завтрашние двери — на 1–6 шагов за ней) и что ход проскочит: камеры по
 * пути станут доступны только через круг.
 */
function doorValue(from: number, c: number): number {
  const steps = dist(from, c);
  let v = cellValue(c) + W[W_FAR]! * steps;
  if (W[W_AHEAD]! !== 0 || W[W_SKIP]! !== 0) {
    let ahead = 0;
    for (let k = 1; k <= P.doorReach; k++) ahead += attr[(c + k) & (CELLS - 1)]!;
    let skipped = 0;
    for (let k = 1; k < steps; k++) skipped += attr[(from + k) & (CELLS - 1)]!;
    v += (W[W_AHEAD]! * ahead) / P.doorReach - W[W_SKIP]! * skipped;
  }
  if (has(TOOL.shortchain) && steps <= P.shortchainSteps) v += P.shortchainChance * openV;
  if (has(TOOL.shackles) && steps >= P.shacklesSteps) v += P.shacklesChance * avgRise;
  return v;
}

// ── оценка доски ────────────────────────────────────────────────────────────

const cnt2 = new Int32Array(24);

/**
 * Сколько узников доски x может кого-то съесть. Считается по составу
 * «редкость × зверь», а не через targets() для каждого: это горячая часть
 * пробных применений. Когти и гильотина не учитываются.
 */
function fedCount(x: Int32Array): number {
  cnt2.fill(0);
  for (let c = 1; c < CELLS; c++) {
    const t = x[TIER + c]!;
    if (t >= 0) cnt2[t * 4 + x[BEAST + c]!] = cnt2[t * 4 + x[BEAST + c]!]! + 1;
  }
  let fed = 0;
  for (let c = 1; c < CELLS; c++) {
    const t = x[TIER + c]!;
    if (t < 0) continue;
    const b = x[BEAST + c]!;
    let ok = false;
    if (anyTier) {
      for (let u = 0; u <= t && !ok; u++) ok = cnt2[u * 4 + FIRST_FOOD[b]!]! > 0 || (SECOND_FOOD[b]! >= 0 && cnt2[u * 4 + SECOND_FOOD[b]!]! > 0);
    } else {
      const row = t * 4;
      ok = cnt2[row + FIRST_FOOD[b]!]! > 0 || (SECOND_FOOD[b]! >= 0 && cnt2[row + SECOND_FOOD[b]!]! > 0);
      if (!ok && b === LION && crown) ok = cnt2[row]! + cnt2[row + 1]! + cnt2[row + 2]! + cnt2[row + 3]! > 1;
      if (!ok && b === RAT && skewer) ok = cnt2[row + RAT]! > 1;
      if (!ok && b === MAMMOTH && maul) for (let u = t + 1; u < 5 && !ok; u++) ok = cnt2[u * 4 + LION]! + cnt2[u * 4 + WOLF]! > 0;
    }
    if (ok) fed++;
  }
  return fed;
}

/** Оценка доски (те же веса и день, что у подготовленного состояния). */
export function boardValue(s: State): number {
  const x = s.m;
  let v = x[STORAGE]! + x[PICK_GIFTS]! * W[W_GIFT]! + x[PICK_TOOLS]! * W[W_TOOLPICK]!;
  for (let c = 1; c < CELLS; c++) {
    if (x[LOCK + c] === 1) v += W[W_DOOR]! * frac;
    if (x[EVT + c] !== 0) v += W[W_EVENT]! * frac;
    const t = x[TIER + c]!;
    if (t >= 0) v += val[t]!;
  }
  return v + fedCount(x) * W[W_FED]! * frac;
}

// ── решения ─────────────────────────────────────────────────────────────────

/** Почему выбран ход: для подписи. */
export const R_TOOL = 1, R_REROLL = 2, R_GIFT = 3, R_HUNT = 4, R_DOOR_EAT = 5, R_DOOR_NEW = 6, R_DOOR_EVENT = 7,
  R_DOOR_OFFICE = 8, R_DOOR_PRISM = 9, R_DEVOUR = 10, R_DEVOUR_PRISM = 11, R_CHAIN = 12, R_STOP = 13, R_SWAP = 14,
  R_END = 15, R_BESTOW = 16, R_INSTIGATE = 17, R_ACCEPT = 18, R_SKIP = 19, R_RATWAY = 20, R_NONE = 0;
let why = R_NONE;

const code = (kind: number, arg = 0) => (kind << 6) | arg;

function pickTool(): number {
  let best = -1;
  let bestV = -Infinity;
  for (let i = 0; i < m[OFFER_N]!; i++) {
    const id = m[OFFER + i]!;
    const v = W[W_TOOL + id]!;
    if (v > bestV) {
      bestV = v;
      best = id;
    }
  }
  if (m[REROLLS]! > 0 && bestV < W[W_REROLL]!) {
    why = R_REROLL;
    return code(A_REROLL);
  }
  why = R_TOOL;
  return code(A_TOOL, best);
}

/** Укус «Медного рога»: без цепочки, цель — та, что дана. */
function hornBite(e: number, j: number): number {
  const te = m[TIER + e]!;
  const be = m[BEAST + e]!;
  if (m[LOCK + j] === 1) return riseV(te, P.clawsGain) - val[te]!;
  const tt = m[TIER + j]!;
  const bt = m[BEAST + j]!;
  const food = bt === FIRST_FOOD[be] || (te >= LEGENDARY && bt === SECOND_FOOD[be]);
  return -val[tt]! + riseV(te, baseGain(be, te, food, tt)) - val[te]!;
}

/**
 * Ценность подарка по доске — без пробного применения (подарков за забег
 * много, «Изобилие» втрое, а проба «Клейма» дорогая): Кольцо — открытые
 * двери, Рог — по укусу каждого, у кого есть еда (цель случайная), Вино —
 * +1 всем ниже Легендарной, Клеймо — еда для голодных.
 */
function giftValue(s: State, g: number): number {
  ensureChain();
  let v = 0;
  switch (g) {
    case 0:
      return Math.min(P.ringOpens, lockedCount) * (openV + W[W_RING]!);
    case 1:
      for (let c = 1; c < CELLS; c++) {
        if (m[TIER + c]! < 0) continue;
        const mask = targets(s, c);
        if (!mask) continue;
        let sum = 0;
        let k = 0;
        for (let j = 1; j < CELLS; j++) {
          if (!((mask >>> j) & 1)) continue;
          sum += hornBite(c, j);
          k++;
        }
        v += sum / k;
      }
      return v;
    case 2:
      for (let c = 1; c < CELLS; c++) {
        const t = m[TIER + c]!;
        if (t >= 0 && t < LEGENDARY) v += riseV(t, 1) - val[t]!;
      }
      return v;
    case 3: {
      let hungry = 0;
      for (let c = 1; c < CELLS; c++) if (m[TIER + c]! >= 0 && targets(s, c) === 0) hungry++;
      return Math.min(P.brandCount, hungry) * W[W_BRAND]! * frac;
    }
  }
  return v;
}

function pickGift(s: State): number {
  let best = 0;
  let bestV = -Infinity;
  for (let i = 0; i < m[OFFER_N]!; i++) {
    const g = m[OFFER + i]!;
    const v = giftValue(s, g);
    if (v > bestV) {
      bestV = v;
      best = g;
    }
  }
  why = R_GIFT;
  return code(A_GIFT, best);
}

/** Лучшая добыча для «Выслеживания» львом надзирателя: камера и выгода (в huntJ / huntGain). */
let huntJ = -1;
let huntGain = -Infinity;
function bestHunt(s: State): void {
  huntJ = -1;
  huntGain = -Infinity;
  const mask = huntTargets(s);
  if (mask === 0) return;
  const tl = m[TIER + m[WARDEN]!]!;
  const n = P.trapMornings;
  for (let c = 1; c < CELLS; c++) {
    if (!((mask >>> c) & 1)) continue;
    const tp = m[TIER + c]!;
    const v = riseV(tp, n) - val[tp]! + riseV(tl, n) - val[tl]!;
    if (v > huntGain) {
      huntGain = v;
      huntJ = c;
    }
  }
}

function pickDoor(): number {
  ensureChain();
  if (W[W_AHEAD]! !== 0 || W[W_SKIP]! !== 0) fillAttr();
  const from = m[WARDEN]!;
  let best = m[DOORS]!;
  let bestV = -Infinity;
  for (let i = 0; i < m[DOORS_N]!; i++) {
    const c = m[DOORS + i]!;
    const v = doorValue(from, c);
    if (v > bestV) {
      bestV = v;
      best = c;
    }
  }
  why = doorReason(best);
  return code(A_PATROL, best);
}

function doorReason(c: number): number {
  if (c === OFFICE) return R_DOOR_OFFICE;
  if (m[EVT + c] !== 0) return R_DOOR_EVENT;
  if (m[LOCK + c] !== 1 && m[TIER + c]! >= 0 && targets(S, c) !== 0) {
    const t = m[TIER + c]!;
    return F[(t * 4 + m[BEAST + c]!) * 2]! >= prismV * 0.5 ? R_DOOR_PRISM : R_DOOR_EAT;
  }
  return R_DOOR_NEW;
}

function pickRatway(): number {
  ensureChain();
  const w = m[WARDEN]!;
  let best = -1;
  let bestV = -Infinity;
  for (let c = 1; c < CELLS; c++) {
    if (c === w) continue;
    const v = cellValue(c);
    if (v > bestV) {
      bestV = v;
      best = c;
    }
  }
  why = R_RATWAY;
  return code(A_PATROL, best);
}

/** Лучший укус едока e: камера и выгода (в bestJ / bestGain). */
let bestJ = -1;
let bestGain = -Infinity;
function bestTarget(s: State, e: number, chain: number): void {
  ensureChain();
  bestJ = -1;
  bestGain = -Infinity;
  const mask = targets(s, e);
  for (let j = 1; j < CELLS; j++) {
    if (!((mask >>> j) & 1)) continue;
    const g = biteGain(e, j, chain);
    if (g > bestGain) {
      bestGain = g;
      bestJ = j;
    }
  }
}

function pickManage(s: State): number {
  const e = m[WARDEN]!;
  const t = m[TIER + e]!;
  bestTarget(s, e, 0); // и таблицы
  const sw = swapGain(t, e);
  bestHunt(s);
  if (huntJ >= 0 && huntGain > bestGain && huntGain > sw && huntGain > 0) {
    why = R_HUNT;
    return code(A_HUNT, huntJ);
  }
  if (bestJ >= 0 && bestGain >= sw && bestGain >= 0) {
    why = t + 1 >= 5 || (m[LOCK + bestJ] === 1 && t + P.clawsGain >= 5) ? R_DEVOUR_PRISM : R_DEVOUR;
    return code(A_DEVOUR, bestJ);
  }
  if (sw > 0) {
    why = R_SWAP;
    return code(A_SWAP);
  }
  why = R_END;
  return code(A_END);
}

function pickChain(s: State): number {
  const e = m[CHAIN_EATER]!;
  bestTarget(s, e, 1);
  if (bestJ >= 0 && bestGain + W[W_CHAIN]! > 0) {
    why = R_CHAIN;
    return code(A_CHAIN, bestJ);
  }
  why = R_STOP;
  return code(A_STOPCHAIN);
}

/** Событие пропустить нельзя (в игре только «Подтвердить»). */
function pickEvent(_s: State): number {
  why = R_ACCEPT;
  return code(A_ACCEPT);
}

function pickOffice(): number {
  const bestow = bestowValue() >= instigateValue();
  why = bestow ? R_BESTOW : R_INSTIGATE;
  return code(bestow ? A_BESTOW : A_INSTIGATE);
}

/** Код хода мгновенной стратегии. Без аллокаций (кроме редких пробных применений на готовой копии). */
export function instantCode(s: State, p: Params = DEFAULT_PARAMS, w: Float64Array = DEFAULT_WEIGHTS): number {
  prepare(s, p, w);
  switch (m[PHASE]) {
    case P_PICK:
      return m[OFFER_KIND] === OFFER_GIFT ? pickGift(s) : pickTool();
    case P_PATROL:
      return pickDoor();
    case P_EVENT:
      return pickEvent(s);
    case P_OFFICE:
      return pickOffice();
    case P_RATWAY:
      return pickRatway();
    case P_MANAGE:
      return pickManage(s);
    case P_CHAIN:
      return pickChain(s);
  }
  throw new Error('тюрьма: забег окончен, ходов нет');
}

/** Ход мгновенной стратегии. */
export function instant(s: State, p: Params = DEFAULT_PARAMS, w: Float64Array = DEFAULT_WEIGHTS): Action {
  return decode(instantCode(s, p, w));
}

/** Доиграть забег мгновенной стратегией; вернуть счёт. */
export function policyPlayout(s: State, r: Rng, p: Params = DEFAULT_PARAMS, w: Float64Array = DEFAULT_WEIGHTS): number {
  while (s.m[PHASE] !== P_END) applyCode(s, instantCode(s, p, w), r, p, false);
  return s.m[STORAGE]!;
}

// ── подпись ─────────────────────────────────────────────────────────────────

const SHORT_TOOL = TOOL_IDS.map((id) => TOOL_NAMES[id].split(':')[0]!);
const GIFT_NAMES = ['Трёхглавое кольцо', 'Медный боевой рог', 'Багряное вино', 'Клеймо греха'];

function fit(text: string): string {
  return text.length <= 40 ? text : `${text.slice(0, 39)}…`;
}

/** Ход и короткое объяснение (≤ 40 символов) для подписи в Горне. */
export function advise(s: State, p: Params = DEFAULT_PARAMS, w: Float64Array = DEFAULT_WEIGHTS): { action: Action; text: string } {
  const c = instantCode(s, p, w);
  const arg = c & 63;
  const n = arg + 1; // игроку камеры с 1
  let text: string;
  switch (why) {
    case R_TOOL: text = `Взять «${SHORT_TOOL[arg]}»`; break;
    case R_REROLL: text = 'Обновить: все три карты слабые'; break;
    case R_GIFT: text = `Подарок: ${GIFT_NAMES[arg]}`; break;
    case R_HUNT: text = `Выслеживание: узник в камере ${n}`; break;
    case R_DOOR_PRISM: text = `Камера ${n}: цепочка к призматическому`; break;
    case R_DOOR_EAT: text = `Камера ${n}: узник съест соседа`; break;
    case R_DOOR_EVENT: text = `Камера ${n}: событие`; break;
    case R_DOOR_OFFICE: text = 'В допросную'; break;
    case R_DOOR_NEW: text = arg === OFFICE ? 'В допросную' : `Камера ${n}: новый узник`; break;
    case R_DEVOUR_PRISM: text = `Съесть ${n} → Призматический`; break;
    case R_DEVOUR: text = `Съесть узника в камере ${n}`; break;
    case R_CHAIN: text = `Есть дальше: камера ${n}`; break;
    case R_STOP: text = 'Отменить: дальше невыгодно'; break;
    case R_SWAP: text = 'Заменить узника'; break;
    case R_END: text = 'Завершить день'; break;
    case R_BESTOW: text = 'Наградить случайного узника'; break;
    case R_INSTIGATE: text = 'Подстрекнуть: события за дверями'; break;
    case R_ACCEPT: text = 'Принять событие'; break;
    case R_SKIP: text = 'Пропустить событие'; break;
    case R_RATWAY: text = `Тропа: в камеру ${n}`; break;
    default: text = '';
  }
  return { action: decode(c), text: fit(text) };
}
