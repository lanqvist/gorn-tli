/**
 * Проверка вариантами: Монте-Карло по кандидатам-ходам с общими костями.
 *
 * Раунд: для каждого живого кандидата берётся копия позиции, скрытое
 * будущее перебрасывается одинаково для всех (неоткрытые двери, события за
 * «!», дальнейший ГСЧ), ход применяется, забег доигрывается мгновенной
 * стратегией. Кости общие: ГСЧ перезаправляется в начале каждого дня от
 * (зерно раунда, день), поэтому после разных ходов будущее кандидатов снова
 * совпадает с утра. Сравнение — по парам раундов: SE разницы с лидером в
 * разы меньше SE каждого среднего.
 *
 * Остановка (не раньше 256 раундов): каждый соперник позади лидера на
 * ≥ 4 SE либо не может обогнать его больше чем на 0,01 призм. (разница +
 * 2 SE < 0,01). Явно худшие (≥ 5 SE позади, со 128 раундов) отсекаются и
 * больше не играют. Потолок — время, которое даёт вызывающий (step(ms)).
 * Пороги подобраны аудитом против эталона на 20–80 тыс. раундов: прежние
 * (64 раунда, 3 SE, 0,1) останавливались на минимуме и теряли ~0,5 призм.
 * за забег.
 *
 * Счёт доигрывания — призматические плюс малая добавка за выполненные цели
 * и прогресс цели: при полном хранилище лучшие ходы часто равны точно, и
 * без добавки выбирался бы просто первый легальный.
 *
 * Тот же кадр снова (та же позиция, те же зерно и настройки) — продолжаем
 * накопленный поиск, а не начинаем заново.
 */

import { CELLS, DEFAULT_PARAMS, EVENT, EVENT_POOL, type Action, type Params } from '../model.js';
import { applyCode, decode, legalCodes } from '../engine/actions.js';
import { instantCode } from '../policy/instant.js';
import { Rng } from '../engine/rng.js';
import {
  DAY, EVT, FLAGS, F_VIS_BEAST, F_VIS_TIER, LOCK, OBJ_DONE, OBJ_PROGRESS, PHASE, PRE_BEAST, PRE_TIER, P_END, P_EVENT,
  STORAGE, State, USURP, WARDEN, copy,
} from '../engine/state.js';
import { DEFAULT_WEIGHTS } from '../policy/weights.js';

export interface SolveOptions {
  seed: number;
  /** Раундов до первой проверки остановки (256). */
  minRounds?: number;
  /** Потолок раундов (по умолчанию нет — потолок временем через step(ms)). */
  maxRounds?: number;
  /** Остановка: соперник позади на столько SE (4). */
  zStop?: number;
  /** Отсечение: соперник позади на столько SE (5)… */
  zPrune?: number;
  /** …начиная с этого раунда (128). */
  pruneFrom?: number;
  /** Остановка: соперник не лучше лидера больше чем на столько призм. (0,01). */
  eps?: number;
  params?: Readonly<Params>;
  weights?: Float64Array;
  /** Виды событий за «!» известны (по умолчанию нет — перебрасываются). */
  knownEvents?: boolean;
}

export interface SolveOption {
  action: Action;
  /** Среднее призматических к концу забега. */
  mean: number;
  /** Отставание от лидера в SE парной разницы (у лидера 0). */
  gapSe: number;
  rounds: number;
  pruned: boolean;
}

export interface SolveStep {
  best: Action;
  options: SolveOption[];
  done: boolean;
  rounds: number;
}

export interface Search {
  step(ms: number): SolveStep;
}

const POOL = EVENT_POOL.map((id) => EVENT[id]);

/** ГСЧ раунда: каждое утро перезаправляется от (зерно раунда, день). */
class DayRng extends Rng {
  round = 0;
  override morning(day: number): void {
    this.seed(mix(this.round, 0x10000 + day));
  }
}

export const STOP_DEFAULTS = { minRounds: 256, maxRounds: Infinity, zStop: 4, zPrune: 5, pruneFrom: 128, eps: 0.01 } as const;

/** Добавка к счёту за выполненную цель (и её квадрат — за единицу прогресса цели). */
const TIE = 1e-3;

function mix(a: number, b: number): number {
  let x = Math.imul(a ^ Math.imul(b, 0x9e3779b1), 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Перебросить то, чего игрок не видит: закреплённых без показа узников за
 * дверями, зверя при показанной только редкости, виды событий. Событие в
 * окне (фаза события, камера надзирателя) игрок видит — оно остаётся.
 * Пул переброса — как у движка: постоянные события и текущая ступень
 * Узурпации.
 */
export function redeterminize(s: State, r: Rng, knownEvents: boolean): void {
  const m = s.m;
  const shown = m[PHASE] === P_EVENT ? m[WARDEN]! : -1;
  const usurp = m[USURP]!;
  const n = POOL.length + (usurp >= 0 ? 1 : 0);
  for (let c = 1; c < CELLS; c++) {
    if (m[LOCK + c] === 1 && m[PRE_TIER + c]! >= 0) {
      const fl = m[FLAGS + c]!;
      if (!(fl & F_VIS_TIER)) {
        m[PRE_TIER + c] = -1;
        m[PRE_BEAST + c] = -1;
      } else if (!(fl & F_VIS_BEAST)) {
        m[PRE_BEAST + c] = r.int(4);
      }
    }
    if (!knownEvents && c !== shown && m[EVT + c] !== 0) {
      const k = r.int(n);
      m[EVT + c] = (k < POOL.length ? POOL[k]! : usurp) + 1;
    }
  }
}

class MonteCarlo implements Search {
  private readonly root = new State();
  private readonly work = new State();
  private readonly rng = new DayRng(1);
  private readonly det = new Rng(1);
  private readonly codes: Int32Array;
  private readonly k: number;
  private readonly sum: Float64Array;
  private readonly cross: Float64Array;
  private readonly count: Float64Array;
  private readonly active: Uint8Array;
  private readonly xs: Float64Array;
  private readonly p: Readonly<Params>;
  private readonly w: Float64Array;
  private n = 0;
  private done = false;
  private leader = 0;
  private readonly stop: Required<Omit<SolveOptions, 'seed' | 'params' | 'weights' | 'knownEvents'>>;

  constructor(s: State, private readonly opts: SolveOptions) {
    this.stop = {
      minRounds: opts.minRounds ?? STOP_DEFAULTS.minRounds,
      maxRounds: opts.maxRounds ?? STOP_DEFAULTS.maxRounds,
      zStop: opts.zStop ?? STOP_DEFAULTS.zStop,
      zPrune: opts.zPrune ?? STOP_DEFAULTS.zPrune,
      pruneFrom: opts.pruneFrom ?? STOP_DEFAULTS.pruneFrom,
      eps: opts.eps ?? STOP_DEFAULTS.eps,
    };
    if (s.m[PHASE] === P_END) throw new Error('тюрьма: забег окончен, проверять нечего');
    copy(s, this.root);
    this.p = opts.params ?? DEFAULT_PARAMS;
    this.w = opts.weights ?? DEFAULT_WEIGHTS;
    const buf = new Int32Array(32);
    this.k = legalCodes(s, buf);
    this.codes = buf.slice(0, this.k);
    this.sum = new Float64Array(this.k);
    this.cross = new Float64Array(this.k * this.k);
    this.count = new Float64Array(this.k);
    this.active = new Uint8Array(this.k).fill(1);
    this.xs = new Float64Array(this.k);
    if (this.k <= 1) this.done = true;
  }

  private round(): void {
    const { k, active, xs, work, det } = this;
    const seed = mix(this.opts.seed, this.n);
    for (let i = 0; i < k; i++) {
      if (!active[i]) continue;
      copy(this.root, work);
      det.seed(seed);
      redeterminize(work, det, this.opts.knownEvents ?? false);
      xs[i] = this.playout(seed, this.codes[i]!);
    }
    for (let i = 0; i < k; i++) {
      if (!active[i]) continue;
      const x = xs[i]!;
      this.sum[i] = this.sum[i]! + x;
      this.count[i] = this.count[i]! + 1;
      for (let j = 0; j < k; j++) if (active[j]) this.cross[i * k + j] = this.cross[i * k + j]! + x * xs[j]!;
    }
    this.n++;
  }

  /** Ход-кандидат и доигрывание с костями, общими по дням. */
  private playout(seed: number, first: number): number {
    const { work, rng, p, w } = this;
    const m = work.m;
    rng.round = seed;
    rng.seed(mix(seed, 0x5bd1e995));
    applyCode(work, first, rng, p);
    // Кости решения зависят от (день, фаза, номер решения за день): у
    // кандидатов, которые дошли до того же решения, исход совпадёт.
    let day = -1;
    let k = 0;
    while (m[PHASE] !== P_END) {
      if (m[DAY] !== day) {
        day = m[DAY]!;
        k = 0;
      }
      const c = instantCode(work, p, w);
      rng.seed(mix(seed, (day << 12) | (m[PHASE]! << 8) | k++));
      applyCode(work, c, rng, p, false);
    }
    return m[STORAGE]! + TIE * m[OBJ_DONE]! + TIE * TIE * m[OBJ_PROGRESS]!;
  }

  private mean(i: number): number {
    return this.count[i]! > 0 ? this.sum[i]! / this.count[i]! : 0;
  }

  /** Отставание кандидата i от лидера L и SE парной разницы (оба живы с начала). */
  private gap(L: number, i: number): { d: number; se: number } {
    const k = this.k;
    const n = this.n;
    const d = this.mean(L) - this.mean(i);
    const sq = (this.cross[L * k + L]! - 2 * this.cross[L * k + i]! + this.cross[i * k + i]!) / n;
    return { d, se: Math.sqrt(Math.max(0, sq - d * d) / n) };
  }

  /** Лидер, отсечение, проверка остановки. */
  private check(): void {
    const { k, active } = this;
    let L = -1;
    for (let i = 0; i < k; i++) if (active[i] && (L < 0 || this.mean(i) > this.mean(L))) L = i;
    this.leader = L;
    const st = this.stop;
    if (this.n >= st.maxRounds) {
      this.done = true;
      return;
    }
    const enough = this.n >= st.minRounds;
    const canPrune = this.n >= st.pruneFrom;
    let settled = true;
    for (let i = 0; i < k; i++) {
      if (!active[i] || i === L) continue;
      const { d, se } = this.gap(L, i);
      if (canPrune && d > 0 && d >= st.zPrune * se) {
        active[i] = 0;
        continue;
      }
      if (!(d >= st.zStop * se && d > 0) && !(-d + 2 * se < st.eps)) settled = false;
    }
    if (enough && settled) this.done = true;
  }

  step(ms: number): SolveStep {
    const deadline = performance.now() + ms;
    while (!this.done) {
      this.round();
      this.check();
      if (performance.now() >= deadline) break;
    }
    return this.result();
  }

  private result(): SolveStep {
    const L = this.leader;
    const options: SolveOption[] = [];
    for (let i = 0; i < this.k; i++) {
      let gapSe = 0;
      if (i !== L && this.n > 0 && this.active[i]) {
        const { d, se } = this.gap(L, i);
        gapSe = se > 0 ? d / se : d > 0 ? Infinity : 0;
      } else if (i !== L && !this.active[i]) {
        gapSe = Infinity;
      }
      options.push({
        action: decode(this.codes[i]!),
        mean: this.mean(i),
        gapSe,
        rounds: this.count[i]!,
        pruned: !this.active[i],
      });
    }
    return { best: decode(this.codes[L]!), options, done: this.done, rounds: this.n };
  }
}

// ── кэш поисков ─────────────────────────────────────────────────────────────

const CACHE_SIZE = 16;
const cache = new Map<string, MonteCarlo>();
const ids = new WeakMap<object, number>();
let nextId = 1;

function idOf(o: object): number {
  let id = ids.get(o);
  if (id === undefined) ids.set(o, (id = nextId++));
  return id;
}

/** Ключ позиции: два независимых 32-битных хеша содержимого. */
export function stateKey(s: State): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  const m = s.m;
  for (let i = 0; i < m.length; i++) {
    a = Math.imul(a ^ m[i]!, 0x01000193);
    b = Math.imul(b ^ m[i]!, 0x5bd1e995) ^ (b >>> 15);
  }
  return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
}

/** Начать (или продолжить для того же кадра) проверку вариантами. */
export function solve(s: State, opts: SolveOptions): Search {
  const key = [
    stateKey(s), opts.seed, opts.minRounds, opts.maxRounds, opts.zStop, opts.zPrune, opts.pruneFrom, opts.eps, opts.knownEvents ? 1 : 0,
    idOf(opts.params ?? DEFAULT_PARAMS), idOf(opts.weights ?? DEFAULT_WEIGHTS),
  ].join(':');
  let search = cache.get(key);
  if (search) {
    cache.delete(key);
  } else {
    search = new MonteCarlo(s, opts);
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  }
  cache.set(key, search);
  return search;
}

/** Забыть накопленные поиски (новый забег, смена настроек). */
export function clearSolveCache(): void {
  cache.clear();
}
