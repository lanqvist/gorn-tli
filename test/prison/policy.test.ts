import { describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS, EVENT, LION, MAMMOTH, RAT, TOOL, WOLF } from '../../src/core/prison/model.js';
import { applyCode, codeBuffer, encode, legalCodes, settle, startRun } from '../../src/core/prison/engine/actions.js';
import { Rng } from '../../src/core/prison/engine/rng.js';
import {
  CHAIN_EATER, DAY, DOORS, DOORS_N, EVT, NEXT, OFFER, OFFER_KIND, OFFER_N, OFFER_TOOL, PHASE, PICK_GIFTS, P_CHAIN,
  P_END, P_EVENT, P_PATROL, P_PICK, REROLLS, STORAGE, State, WARDEN, clone,
} from '../../src/core/prison/engine/state.js';
import { greedyPlayout } from '../../src/core/prison/policy/greedy.js';
import { advise, instant, instantCode, policyPlayout } from '../../src/core/prison/policy/instant.js';
import { DEFAULT_WEIGHTS, W_REROLL, W_TOOL } from '../../src/core/prison/policy/weights.js';
import { P, blank, manageAt, put } from './engine-helpers.js';

/** Надзиратель в from, пункты назначения — doors. */
function doors(s: State, from: number, ...cells: number[]): void {
  s.m[WARDEN] = from;
  cells.forEach((c, i) => (s.m[DOORS + i] = c));
  s.m[DOORS_N] = cells.length;
  s.m[PHASE] = P_PATROL;
}

describe('мгновенная стратегия: явные позиции', () => {
  it('съесть, когда укус делает узника Призматическим', () => {
    const s = blank();
    put(s, 1, MAMMOTH, 4);
    put(s, 2, LION, 4);
    put(s, 6, WOLF, 0);
    manageAt(s, 1);
    expect(instant(s, P)).toEqual({ type: 'devour', to: 2 });
    expect(advise(s, P).text).toBe('Съесть 3 → Призматический');
  });

  it('цепочка до Призматического: есть дальше', () => {
    const s = blank();
    put(s, 1, RAT, 4);
    put(s, 2, MAMMOTH, 4);
    s.m[CHAIN_EATER] = 1;
    s.m[NEXT] = P_CHAIN;
    settle(s, new Rng(1), P);
    expect(s.m[PHASE]).toBe(P_CHAIN);
    expect(instant(s, P)).toEqual({ type: 'chain', to: 2 });
  });

  it('«Отменить», когда дальше хуже: хранилище полно, укус ничего не даёт, а еду съест', () => {
    const s = blank();
    s.m[STORAGE] = 10;
    put(s, 1, RAT, 4);
    put(s, 2, MAMMOTH, 4);
    s.m[CHAIN_EATER] = 1;
    s.m[NEXT] = P_CHAIN;
    settle(s, new Rng(1), P);
    expect(instant(s, P)).toEqual({ type: 'stopchain' });
    expect(advise(s, P).text).toBe('Отменить: дальше невыгодно');
  });

  it('«Обновить», когда все три карты слабые и обновление есть', () => {
    const s = blank();
    const w = Float64Array.from(DEFAULT_WEIGHTS);
    w[W_REROLL] = 1;
    for (const t of ['forged', 'dogtag', 'fire'] as const) w[W_TOOL + TOOL[t]] = 0.1;
    w[W_TOOL + TOOL.crown] = 2;
    s.m[PHASE] = P_PICK;
    s.m[OFFER_KIND] = OFFER_TOOL;
    s.m[OFFER_N] = 3;
    s.m[OFFER] = TOOL.forged;
    s.m[OFFER + 1] = TOOL.dogtag;
    s.m[OFFER + 2] = TOOL.fire;
    s.m[REROLLS] = 1;
    expect(instant(s, P, w)).toEqual({ type: 'reroll' });
    expect(advise(s, P, w).text).toBe('Обновить: все три карты слабые');
    s.m[REROLLS] = 0;
    expect(instant(s, P, w).type).toBe('choose');
    s.m[OFFER + 2] = TOOL.crown;
    s.m[REROLLS] = 1;
    expect(instant(s, P, w)).toEqual({ type: 'choose', id: 'crown' });
  });

  it('обход в последний день: к узнику, который съест соседа до Призматического, а не в запертую камеру', () => {
    // Раньше выгоднее открывать двери: пару Величайших никто не съест, решатель тоже за дверь.
    const s = blank();
    s.m[DAY] = 19;
    put(s, 3, MAMMOTH, 4);
    put(s, 9, LION, 4);
    doors(s, 0, 2, 3, 4);
    expect(instant(s, P)).toEqual({ type: 'patrol', cell: 3 });
    expect(advise(s, P).text).toBe('Камера 4: цепочка к призматическому');
  });

  it('подарок: Рог в последний день, когда он сразу даёт Призматического', () => {
    const s = blank();
    s.m[DAY] = 19; // раньше пара Величайших и так почти равна призматическому
    put(s, 1, MAMMOTH, 4);
    put(s, 2, LION, 4);
    put(s, 5, WOLF, 4);
    s.m[PICK_GIFTS] = 1;
    settle(s, new Rng(1), P);
    expect(s.m[PHASE]).toBe(P_PICK);
    expect(instant(s, P)).toEqual({ type: 'choose', id: 'horn' });
  });

  it('событие «Вкус свободы» принимается', () => {
    const s = blank();
    put(s, 4, WOLF, 1);
    s.m[WARDEN] = 4;
    s.m[EVT + 4] = EVENT.freedom + 1;
    s.m[PHASE] = P_EVENT;
    expect(instant(s, P)).toEqual({ type: 'event', accept: true });
  });
});

describe('мгновенная стратегия: забег целиком', () => {
  it('детерминирована: та же позиция — тот же ход, тот же ГСЧ — тот же забег', () => {
    const a = new State();
    startRun(a, new Rng(12), DEFAULT_PARAMS);
    const b = clone(a);
    expect(instantCode(a)).toBe(instantCode(b));
    expect(policyPlayout(a, new Rng(5))).toBe(policyPlayout(b, new Rng(5)));
    expect(Array.from(a.m)).toEqual(Array.from(b.m));
  });

  it('ход всегда легальный, подпись не длиннее 40 символов', () => {
    const s = new State();
    const buf = codeBuffer();
    const r = new Rng(77);
    for (let run = 0; run < 40; run++) {
      startRun(s, r, DEFAULT_PARAMS, { start: (['none', 'cagefight', 'tyranny', 'abundance'] as const)[run % 4]! });
      while (s.m[PHASE] !== P_END) {
        const { action, text } = advise(s);
        const c = encode(action);
        const n = legalCodes(s, buf);
        expect(Array.from(buf.subarray(0, n))).toContain(c);
        expect(text.length).toBeGreaterThan(0);
        expect(text.length).toBeLessThanOrEqual(40);
        applyCode(s, c, r, DEFAULT_PARAMS);
      }
    }
  });

  it('сильнее жадной и случайной на одних и тех же забегах', () => {
    const s = new State();
    let pol = 0;
    let greedy = 0;
    for (let i = 0; i < 300; i++) {
      startRun(s, new Rng(500 + i), DEFAULT_PARAMS);
      pol += policyPlayout(s, new Rng(900 + i));
      startRun(s, new Rng(500 + i), DEFAULT_PARAMS);
      greedy += greedyPlayout(s, new Rng(900 + i), DEFAULT_PARAMS);
    }
    expect(pol).toBeGreaterThan(greedy * 1.2);
  });

  it('мгновенный совет быстрее 5 мс', () => {
    const s = new State();
    const r = new Rng(3);
    const times: number[] = [];
    for (let run = 0; run < 20; run++) {
      startRun(s, r, DEFAULT_PARAMS);
      while (s.m[PHASE] !== P_END) {
        const t0 = performance.now();
        const c = instantCode(s);
        times.push(performance.now() - t0);
        applyCode(s, c, r, DEFAULT_PARAMS);
      }
    }
    // p95, а не максимум: под нагрузкой (параллельные тесты, сборщик мусора)
    // единичный ход бывает и дольше — это не скорость стратегии.
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(5);
  });
});

