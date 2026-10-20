import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS, START_EVENT_IDS } from '../../src/core/prison/model.js';
import { applyCode, codeBuffer, legalCodes, startRun } from '../../src/core/prison/engine/actions.js';
import { Rng } from '../../src/core/prison/engine/rng.js';
import { PHASE, P_END, State, clone } from '../../src/core/prison/engine/state.js';
import { instantCode } from '../../src/core/prison/policy/instant.js';
import { startDevSolvePool } from '../../src/core/prison/solver/devPool.js';
import { defaultSolveThreads, solvePool, stopSolvePool } from '../../src/core/prison/solver/pool.js';
import { clearSolveCache, solve, type SolveOptions, type SolveStep } from '../../src/core/prison/solver/solve.js';

/** Позиции из забега мгновенной стратегии: каждое пятое решение, где ходов больше одного. */
function positions(seed: number, every: number): State[] {
  const buf = codeBuffer();
  const out: State[] = [];
  const s = new State();
  const r = new Rng(seed);
  startRun(s, r, DEFAULT_PARAMS, { start: START_EVENT_IDS[seed % START_EVENT_IDS.length]! });
  let k = 0;
  while (s.m[PHASE] !== P_END) {
    if (legalCodes(s, buf) > 1 && k++ % every === 0) out.push(clone(s));
    applyCode(s, instantCode(s, DEFAULT_PARAMS), r, DEFAULT_PARAMS);
  }
  return out;
}

/** Решить до конца короткими шагами: границы шагов (слив, остановка потоков) — в середине поиска. */
function run(s: State, opts: SolveOptions, ms: number): SolveStep {
  clearSolveCache();
  const search = solve(s, opts);
  let res = search.step(ms);
  while (!res.done) res = search.step(ms);
  return res;
}

const POS = positions(4242, 9).slice(0, 8);

beforeEach(() => clearSolveCache());
afterAll(() => stopSolvePool());

describe('пул потоков решателя', () => {
  it('потоков по умолчанию: ядра − 2, от 1 до 4', () => {
    expect(defaultSolveThreads(1)).toBe(1);
    expect(defaultSolveThreads(3)).toBe(1);
    expect(defaultSolveThreads(4)).toBe(2);
    expect(defaultSolveThreads(16)).toBe(4);
  });

  it('при том же числе раундов оценки ходов совпадают с одним потоком', () => {
    expect(POS.length).toBeGreaterThanOrEqual(6);
    // Отсечение рано и часто, остановка — только по числу раундов.
    const fixed: SolveOptions = { seed: 7, minRounds: 400, maxRounds: 400, pruneFrom: 16, zPrune: 2, zStop: Infinity, eps: -1 };
    stopSolvePool();
    const one = POS.map((s, i) => run(s, { ...fixed, seed: 7 + i }, 5));
    for (const threads of [2, 4]) {
      const pool = startDevSolvePool(threads);
      expect(solvePool()?.threads).toBe(threads);
      const many = POS.map((s, i) => run(s, { ...fixed, seed: 7 + i }, 5));
      expect(many).toEqual(one);
      expect(many.every((r) => r.rounds === 400)).toBe(true);
      expect(many.some((r) => r.options.some((o) => o.pruned))).toBe(true);
      // Раунды правда делились: часть сыграли потоки пула.
      expect(pool!.workerRounds).toBeGreaterThan(0);
    }
  }, 120_000);

  it('ранняя остановка — на том же раунде и с тем же ходом', () => {
    const early: SolveOptions = { seed: 3, minRounds: 32, pruneFrom: 16, maxRounds: 600 };
    stopSolvePool();
    const one = POS.map((s, i) => run(s, { ...early, seed: 3 + i }, 3));
    startDevSolvePool(3);
    const many = POS.map((s, i) => run(s, { ...early, seed: 3 + i }, 3));
    expect(many).toEqual(one);
  }, 120_000);
});
