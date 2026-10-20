import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS, EVENT, EVENT_POOL, LION, MAMMOTH, WOLF } from '../../src/core/prison/model.js';
import { startRun } from '../../src/core/prison/engine/actions.js';
import { Rng } from '../../src/core/prison/engine/rng.js';
import { eventWeight } from '../../src/core/prison/engine/rules.js';
import {
  DAY, DOORS, DOORS_N, EVT, FLAGS, F_VIS_TIER, PHASE, PRE_BEAST, PRE_TIER, P_EVENT, P_PATROL, State, USURP, WARDEN,
} from '../../src/core/prison/engine/state.js';
import { clearSolveCache, redeterminize, solve, stateKey } from '../../src/core/prison/solver/solve.js';
import { blank, manageAt, put } from './engine-helpers.js';

beforeEach(() => clearSolveCache());

describe('проверка вариантами', () => {
  it('детерминирована при том же зерне', () => {
    const s = new State();
    startRun(s, new Rng(4), DEFAULT_PARAMS);
    const a = solve(s, { seed: 9, minRounds: 20, maxRounds: 60 }).step(10_000);
    clearSolveCache();
    const b = solve(s, { seed: 9, minRounds: 20, maxRounds: 60 }).step(10_000);
    expect(b.rounds).toBe(a.rounds);
    expect(b.options.map((o) => o.mean)).toEqual(a.options.map((o) => o.mean));
    expect(b.best).toEqual(a.best);
  });

  it('ранняя остановка, когда лучший ход очевиден', () => {
    const s = blank();
    s.m[DAY] = 19; // последний день: съесть до Призматического или ничего
    put(s, 1, MAMMOTH, 4);
    put(s, 2, LION, 4);
    manageAt(s, 1);
    const res = solve(s, { seed: 1, minRounds: 32, maxRounds: 5000 }).step(10_000);
    expect(res.done).toBe(true);
    expect(res.rounds).toBeLessThan(5000);
    expect(res.best).toEqual({ type: 'devour', to: 2 });
    const best = res.options.find((o) => o.action.type === 'devour')!;
    expect(best.mean).toBe(1);
    for (const o of res.options) if (o !== best) expect(o.gapSe).toBeGreaterThanOrEqual(3);
  });

  it('один легальный ход — готово сразу, без раундов', () => {
    const s = blank();
    s.m[WARDEN] = 0;
    s.m[DOORS] = 3;
    s.m[DOORS_N] = 1;
    s.m[PHASE] = P_PATROL;
    const res = solve(s, { seed: 1, minRounds: 10, maxRounds: 100 }).step(1000);
    expect(res.done).toBe(true);
    expect(res.rounds).toBe(0);
    expect(res.best).toEqual({ type: 'patrol', cell: 3 });
  });

  it('тот же кадр снова — поиск продолжается, а не начинается заново', () => {
    const s = new State();
    startRun(s, new Rng(8), DEFAULT_PARAMS);
    const first = solve(s, { seed: 3, minRounds: 400, maxRounds: 400 });
    const r1 = first.step(0);
    const again = solve(s, { seed: 3, minRounds: 400, maxRounds: 400 });
    expect(again).toBe(first);
    const r2 = again.step(0);
    expect(r2.rounds).toBe(r1.rounds + 1);
    expect(solve(s, { seed: 4, minRounds: 400, maxRounds: 400 })).not.toBe(first);
  });

  it('скрытое перебрасывается, видимое остаётся', () => {
    const s = blank();
    s.m[PRE_TIER + 3] = 4; // закреплён, но не показан
    s.m[PRE_BEAST + 3] = WOLF;
    s.m[PRE_TIER + 5] = 2; // показана редкость
    s.m[PRE_BEAST + 5] = LION;
    s.m[FLAGS + 5] = F_VIS_TIER;
    s.m[EVT + 7] = EVENT.ratway + 1;
    // Пул — как у движка: постоянные события и текущая ступень Узурпации.
    const pool = [...EVENT_POOL.map((id) => EVENT[id] + 1), s.m[USURP]! + 1];
    const beasts = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const t = new State();
      t.m.set(s.m);
      redeterminize(t, new Rng(i), false);
      expect(t.m[PRE_TIER + 3]).toBe(-1);
      expect(t.m[PRE_TIER + 5]).toBe(2);
      beasts.add(t.m[PRE_BEAST + 5]!);
      expect(pool).toContain(t.m[EVT + 7]);
    }
    expect(beasts.size).toBeGreaterThan(1);
    const k = new State();
    k.m.set(s.m);
    redeterminize(k, new Rng(1), true);
    expect(k.m[EVT + 7]).toBe(EVENT.ratway + 1);
  });

  it('вид события за «!» перебрасывается по весам движка, а не поровну', () => {
    const s = blank();
    s.m[EVT + 7] = EVENT.ratway + 1; // камера 7 заперта
    const seen = new Map<number, number>();
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const t = new State();
      t.m.set(s.m);
      redeterminize(t, new Rng(i), false);
      const e = t.m[EVT + 7]! - 1;
      seen.set(e, (seen.get(e) ?? 0) + 1);
    }
    const pool = [...EVENT_POOL.map((id) => EVENT[id]), s.m[USURP]!];
    let total = 0;
    for (const e of pool) total += eventWeight(s, DEFAULT_PARAMS, e, 7);
    for (const e of pool) {
      const w = eventWeight(s, DEFAULT_PARAMS, e, 7);
      const n = seen.get(e) ?? 0;
      // Недопустимое для запертой камеры не выпадает; прочее — по своей доле.
      if (w === 0) expect(n).toBe(0);
      else expect(Math.abs(n / N - w / total)).toBeLessThan(0.03);
    }
  });

  it('событие в окне (фаза события, камера надзирателя) не перебрасывается', () => {
    const s = blank();
    put(s, 4, WOLF, 1);
    s.m[WARDEN] = 4;
    s.m[EVT + 4] = EVENT.ratway + 1;
    s.m[EVT + 9] = EVENT.ratway + 1;
    s.m[PHASE] = P_EVENT;
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const t = new State();
      t.m.set(s.m);
      redeterminize(t, new Rng(i), false);
      expect(t.m[EVT + 4]).toBe(EVENT.ratway + 1);
      seen.add(t.m[EVT + 9]!);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('ключ позиции различает состояния', () => {
    const a = blank();
    const b = blank();
    expect(stateKey(a)).toBe(stateKey(b));
    put(b, 4, WOLF, 1);
    expect(stateKey(a)).not.toBe(stateKey(b));
  });
});
