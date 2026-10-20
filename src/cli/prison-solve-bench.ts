/**
 * Замер советов тюрьмы на позициях из самоигры.
 *
 *   npx tsx src/cli/prison-solve-bench.ts [--games 12] [--every 2] [--min 256] [--max ∞] [--cap 300] [--threads 1]
 *
 * Позиции — решения мгновенной стратегии в её же забегах (берётся каждое
 * --every-е, где ходов больше одного). На каждой: время мгновенного
 * совета, время проверки вариантами до остановки, раунды, сменила ли
 * проверка мгновенный совет.
 *
 * --threads N — решатель в пуле из N потоков (вместе с главным; 1 — один
 * поток, как было). Оценки при том же числе раундов те же, меняется
 * только число раундов за время.
 *
 * --rate [--stride 5]: раундов за 300 мс и за 1,5 с без остановки (каждая
 * --stride-я позиция) — чистая скорость решателя.
 *
 * --regret [--ref файл] [--ref-rounds 20000] [--ref-threads 14]: regret
 * совета как в потоке подсказок (300 мс, досчёт до 1,5 с, выбор орудий —
 * до 4 с и не меньше 1500 раундов, правило смены) против эталона — той же
 * Монте-Карло на --ref-rounds раундов с другим зерном. Эталон считается
 * один раз и кладётся в --ref (JSON), дальше берётся оттуда.
 */
import { DEFAULT_PARAMS, START_EVENT_IDS } from '../core/prison/model.js';
import { applyCode, codeBuffer, encode, legalCodes, startRun } from '../core/prison/engine/actions.js';
import { Rng } from '../core/prison/engine/rng.js';
import { OFFER_KIND, OFFER_TOOL, PHASE, PHASE_NAMES, P_END, P_PICK, STORAGE, State, clone } from '../core/prison/engine/state.js';
import { constants, setPriority } from 'node:os';
import { instantCode } from '../core/prison/policy/instant.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { startDevSolvePool } from '../core/prison/solver/devPool.js';
import { stopSolvePool } from '../core/prison/solver/pool.js';
import { clearSolveCache, clearlyBetter, solve, type Search } from '../core/prison/solver/solve.js';
import { PICK_BUDGET_MS, PICK_ROUNDS, QUICK_MS } from '../main/prison/ownAdvisor.js';

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

/**
 * --play N [--from K] [--mode new|old|instant]: сыграть N забегов (с K-го)
 * мгновенной стратегией и с проверкой вариантами на каждом ходу, вывести
 * счёт каждого: «номер мгновенная проверка». Режимы проверки:
 *   new — как в потоке подсказок: правило остановки по умолчанию, показ
 *         через ≤ 300 мс, досчёт до 1,5 с (выбор орудий — до PICK_BUDGET_MS и
 *         не меньше PICK_ROUNDS раундов), смена хода, если новый заметно лучше;
 *   flat — то же, но выбор орудий как любой ход;
 *   old — прежнее правило (64 раунда, 3 SE, ε 0,1, отсечение 4 SE),
 *         ход — окончательный (до остановки или 1,5 с).
 */
const buf = codeBuffer();
const threads = arg('--threads', 1);

/** Пул на n потоков; ждёт, пока потоки поднимутся (tsx грузит модули), иначе первые позиции считал бы один главный. */
function startPool(n: number): void {
  stopSolvePool();
  if (n <= 1) return;
  if (!startDevSolvePool(n)) throw new Error('пул решателя не запустился');
  const t = performance.now();
  while (performance.now() - t < 1500) {
    // ждём
  }
}
startPool(threads);

/** Совет как в потоке подсказок: показ через QUICK_MS, досчёт до 1,5 с (выбор орудий — до 4 с), смена — если заметно лучше. */
function adviseLike(s: State, seed: number): { code: number; firstMs: number } {
  const toolPick = s.m[PHASE] === P_PICK && s.m[OFFER_KIND] === OFFER_TOOL;
  const t0 = performance.now();
  const search: Search = solve(s, { seed, ...(toolPick ? { minRounds: PICK_ROUNDS } : {}) });
  let res = search.step(QUICK_MS);
  const firstMs = performance.now() - t0;
  const shown = encode(res.best);
  if (res.done) return { code: shown, firstMs };
  res = search.step((toolPick ? PICK_BUDGET_MS : 1500) - QUICK_MS);
  const best = encode(res.best);
  return { code: best !== shown && clearlyBetter(search, best, shown) ? best : shown, firstMs };
}

if (process.argv.includes('--play')) {
  try {
    // Замер долгий: процессор — игре и всему остальному.
    setPriority(constants.priority.PRIORITY_LOW);
  } catch {
    // без прав — как есть
  }
  const n = arg('--play', 10);
  const from = arg('--from', 0);
  const mode = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : 'new';
  const p = DEFAULT_PARAMS;
  const OLD = { minRounds: 64, maxRounds: 1500, zStop: 3, zPrune: 4, pruneFrom: 32, eps: 0.1 };
  const choose = (s: State, seed: number): number => {
    if (mode === 'old') return encode(solve(s, { ...OLD, seed }).step(1500).best);
    // Выбор орудий — свой бюджет и больше раундов (как в потоке подсказок).
    const toolPick = s.m[PHASE] === P_PICK && s.m[OFFER_KIND] === OFFER_TOOL && mode !== 'flat';
    if (mode === 'new') return adviseLike(s, seed).code;
    const search = solve(s, { seed, ...(toolPick ? { minRounds: PICK_ROUNDS } : {}) });
    let res = search.step(300);
    const shown = encode(res.best);
    if (res.done) return shown;
    res = search.step((toolPick ? PICK_BUDGET_MS : 1500) - 300);
    const best = encode(res.best);
    return best !== shown && clearlyBetter(search, best, shown) ? best : shown;
  };
  let sumI = 0;
  let sumS = 0;
  for (let g = from; g < from + n; g++) {
    const scores: number[] = [];
    for (const useSolver of [false, true]) {
      const s = new State();
      const r = new Rng(777_000 + g);
      startRun(s, r, p, { start: START_EVENT_IDS[g % START_EVENT_IDS.length]! });
      let move = 0;
      while (s.m[PHASE] !== P_END) {
        const c = useSolver && legalCodes(s, buf) > 1 ? choose(s, g * 1000 + move) : instantCode(s, p);
        applyCode(s, c, r, p);
        move++;
      }
      scores.push(s.m[STORAGE]!);
    }
    sumI += scores[0]!;
    sumS += scores[1]!;
    console.log(`${g} ${scores[0]} ${scores[1]}`);
  }
  console.log(`# ${mode}: забегов ${n}, мгновенная ${(sumI / n).toFixed(3)}, с проверкой ${(sumS / n).toFixed(3)}`);
  process.exit(0);
}

const games = arg('--games', 12);
const every = arg('--every', 2);
const minRounds = arg('--min', 256);
const maxRounds = arg('--max', Infinity);
const cap = arg('--cap', 300);
const p = DEFAULT_PARAMS;

// позиции
const positions: State[] = [];
for (let g = 0; g < games; g++) {
  const s = new State();
  const r = new Rng(4242 + g);
  startRun(s, r, p, { start: START_EVENT_IDS[g % START_EVENT_IDS.length]! });
  let k = 0;
  while (s.m[PHASE] !== P_END) {
    if (legalCodes(s, buf) > 1 && k++ % every === 0) positions.push(clone(s));
    applyCode(s, instantCode(s, p), r, p);
  }
}
// --positions N — первые N позиций (580 — набор аудита: --games 18 --positions 580).
positions.length = Math.min(positions.length, arg('--positions', Infinity));

const q = (a: number[], f: number) => {
  const b = [...a].sort((x, y) => x - y);
  return b[Math.min(b.length - 1, Math.floor(b.length * f))]!;
};
const f = (x: number) => x.toFixed(x < 1 ? 3 : 1);
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

if (process.argv.includes('--rate')) {
  const stride = arg('--stride', 5);
  const at300: number[] = [];
  const at1500: number[] = [];
  // Без остановки — только скорость (отсечение как в приложении).
  const free = { minRounds: Infinity, zStop: Infinity, eps: -1 };
  for (let i = 0; i < positions.length; i += stride) {
    clearSolveCache();
    const search = solve(positions[i]!, { ...free, seed: 1000 + i });
    at300.push(search.step(300).rounds);
    at1500.push(search.step(1200).rounds);
  }
  console.log(`потоков ${threads}, позиций ${at300.length} (каждая ${stride}-я из ${positions.length})`);
  console.log(`раундов за 300 мс: медиана ${q(at300, 0.5)}, среднее ${avg(at300).toFixed(0)}, p10 ${q(at300, 0.1)}`);
  console.log(`раундов за 1,5 с: медиана ${q(at1500, 0.5)}, среднее ${avg(at1500).toFixed(0)}, p10 ${q(at1500, 0.1)}`);
  stopSolvePool();
  process.exit(0);
}

if (process.argv.includes('--regret')) {
  const refFile = process.argv.includes('--ref') ? process.argv[process.argv.indexOf('--ref') + 1]! : 'prison-solve-ref.json';
  const refRounds = arg('--ref-rounds', 20_000);
  type Ref = { rounds: number; games: number; every: number; means: Record<string, number>[] };
  let ref: Ref | null = existsSync(refFile) ? (JSON.parse(readFileSync(refFile, 'utf8')) as Ref) : null;
  if (ref && (ref.rounds !== refRounds || ref.games !== games || ref.every !== every || ref.means.length !== positions.length)) {
    throw new Error(`эталон ${refFile} — для других позиций или раундов`);
  }
  if (!ref) {
    startPool(arg('--ref-threads', 14));
    const t0 = performance.now();
    const means: Record<string, number>[] = [];
    for (let i = 0; i < positions.length; i++) {
      clearSolveCache();
      const res = solve(positions[i]!, { seed: 900_000 + i, minRounds: refRounds, maxRounds: refRounds, zStop: Infinity, eps: -1 }).step(Infinity);
      means.push(Object.fromEntries(res.options.map((o) => [String(encode(o.action)), o.mean])));
      if (i % 50 === 49) console.log(`эталон: ${i + 1} из ${positions.length}, ${((performance.now() - t0) / 1000).toFixed(0)} с`);
    }
    ref = { rounds: refRounds, games, every, means };
    writeFileSync(refFile, JSON.stringify(ref));
    startPool(threads);
  }
  const regretOf = (i: number, code: number) => {
    const m = ref!.means[i]!;
    return Math.max(...Object.values(m)) - m[String(code)]!;
  };
  const firstMs: number[] = [];
  const reg: number[] = [];
  const regI: number[] = [];
  const byPh = new Map<string, number[]>();
  for (let i = 0; i < positions.length; i++) {
    const s = positions[i]!;
    clearSolveCache();
    const a = adviseLike(s, 1000 + i);
    firstMs.push(a.firstMs);
    const r = regretOf(i, a.code);
    reg.push(r);
    regI.push(regretOf(i, instantCode(s, p)));
    const ph = s.m[PHASE] === P_PICK && s.m[OFFER_KIND] === OFFER_TOOL ? 'выбор орудий' : PHASE_NAMES[s.m[PHASE]!]!;
    byPh.set(ph, [...(byPh.get(ph) ?? []), r]);
  }
  console.log(`потоков ${threads}, позиций ${positions.length} (забегов ${games}, каждое ${every}-е), эталон ${refRounds} раундов`);
  console.log(`regret решателя ${avg(reg).toFixed(4)}, мгновенной ${avg(regI).toFixed(4)}`);
  for (const [ph, a] of byPh) console.log(`  ${ph}: ${avg(a).toFixed(4)} (${a.length})`);
  console.log(`первый совет: медиана ${f(q(firstMs, 0.5))} мс, p95 ${f(q(firstMs, 0.95))} мс`);
  stopSolvePool();
  process.exit(0);
}

const instantMs: number[] = [];
const solveMs: number[] = [];
const rounds: number[] = [];
let changed = 0;
let capped = 0;
const byPhase = new Map<string, { n: number; changed: number }>();
for (let i = 0; i < positions.length; i++) {
  const s = positions[i]!;
  let t0 = performance.now();
  const ic = instantCode(s, p);
  instantMs.push(performance.now() - t0);
  t0 = performance.now();
  const res = solve(s, { seed: 1000 + i, minRounds, maxRounds }).step(cap);
  solveMs.push(performance.now() - t0);
  rounds.push(res.rounds);
  if (res.rounds >= maxRounds) capped++;
  const ph = PHASE_NAMES[s.m[PHASE]!]!;
  const st = byPhase.get(ph) ?? { n: 0, changed: 0 };
  st.n++;
  if (encode(res.best) !== ic) {
    changed++;
    st.changed++;
  }
  byPhase.set(ph, st);
}

console.log(`позиций: ${positions.length} (забегов ${games}), раунды ${minRounds}…${maxRounds}`);
console.log(`мгновенный совет: медиана ${f(q(instantMs, 0.5))} мс, p95 ${f(q(instantMs, 0.95))} мс, max ${f(q(instantMs, 1))} мс`);
console.log(`проверка вариантами до остановки: медиана ${f(q(solveMs, 0.5))} мс, p95 ${f(q(solveMs, 0.95))} мс, max ${f(q(solveMs, 1))} мс`);
console.log(`раундов: медиана ${q(rounds, 0.5)}, p95 ${q(rounds, 0.95)}; упёрлись в потолок: ${capped} (${((100 * capped) / positions.length).toFixed(1)} %)`);
console.log(`проверка сменила мгновенный совет: ${changed} из ${positions.length} (${((100 * changed) / positions.length).toFixed(1)} %)`);
for (const [ph, st] of byPhase) console.log(`  ${ph}: ${st.changed} из ${st.n}`);
