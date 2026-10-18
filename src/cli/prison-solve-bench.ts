/**
 * Замер советов тюрьмы на позициях из самоигры.
 *
 *   npx tsx src/cli/prison-solve-bench.ts [--games 12] [--every 2] [--min 256] [--max ∞] [--cap 300]
 *
 * Позиции — решения мгновенной стратегии в её же забегах (берётся каждое
 * --every-е, где ходов больше одного). На каждой: время мгновенного
 * совета, время проверки вариантами до остановки (один поток), раунды,
 * сменила ли проверка мгновенный совет.
 */
import { DEFAULT_PARAMS, START_EVENT_IDS } from '../core/prison/model.js';
import { applyCode, codeBuffer, encode, legalCodes, startRun } from '../core/prison/engine/actions.js';
import { Rng } from '../core/prison/engine/rng.js';
import { PHASE, PHASE_NAMES, P_END, STORAGE, State, clone } from '../core/prison/engine/state.js';
import { constants, setPriority } from 'node:os';
import { instantCode } from '../core/prison/policy/instant.js';
import { clearlyBetter, solve } from '../core/prison/solver/solve.js';

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

/**
 * --play N [--from K] [--mode new|old|instant]: сыграть N забегов (с K-го)
 * мгновенной стратегией и с проверкой вариантами на каждом ходу, вывести
 * счёт каждого: «номер мгновенная проверка». Режимы проверки:
 *   new — как в потоке подсказок: правило остановки по умолчанию, показ
 *         через ≤ 300 мс, досчёт до 1,5 с, смена хода, если новый заметно лучше;
 *   old — прежнее правило (64 раунда, 3 SE, ε 0,1, отсечение 4 SE),
 *         ход — окончательный (до остановки или 1,5 с).
 */
const buf = codeBuffer();

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
    const search = solve(s, { seed });
    let res = search.step(300);
    const shown = encode(res.best);
    if (res.done) return shown;
    res = search.step(1200);
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

const q = (a: number[], f: number) => {
  const b = [...a].sort((x, y) => x - y);
  return b[Math.min(b.length - 1, Math.floor(b.length * f))]!;
};

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

const f = (x: number) => x.toFixed(x < 1 ? 3 : 1);
console.log(`позиций: ${positions.length} (забегов ${games}), раунды ${minRounds}…${maxRounds}`);
console.log(`мгновенный совет: медиана ${f(q(instantMs, 0.5))} мс, p95 ${f(q(instantMs, 0.95))} мс, max ${f(q(instantMs, 1))} мс`);
console.log(`проверка вариантами до остановки: медиана ${f(q(solveMs, 0.5))} мс, p95 ${f(q(solveMs, 0.95))} мс, max ${f(q(solveMs, 1))} мс`);
console.log(`раундов: медиана ${q(rounds, 0.5)}, p95 ${q(rounds, 0.95)}; упёрлись в потолок: ${capped} (${((100 * capped) / positions.length).toFixed(1)} %)`);
console.log(`проверка сменила мгновенный совет: ${changed} из ${positions.length} (${((100 * changed) / positions.length).toFixed(1)} %)`);
for (const [ph, st] of byPhase) console.log(`  ${ph}: ${st.changed} из ${st.n}`);
