import { describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS, START_EVENT_IDS, TOOL_IDS, type ToolId } from '../../src/core/prison/model.js';
import {
  applyCode, codeBuffer, legalCodes, randomPlayout, startRun,
} from '../../src/core/prison/engine/actions.js';
import { Rng } from '../../src/core/prison/engine/rng.js';
import {
  DAY, DAY_LIMIT, LOCK, NEST, PHASE, PRE_TIER, P_END, STORAGE, State, TIER, TOOLS, copy, score,
} from '../../src/core/prison/engine/state.js';

const p = DEFAULT_PARAMS;

/** Инварианты состояния; возвращает текст нарушения или null. */
function broken(s: State): string | null {
  const m = s.m;
  if (m[LOCK] !== 0 || m[TIER] !== -1) return 'допросная заперта или в ней узник';
  if (m[STORAGE]! > p.storage) return `хранилище ${m[STORAGE]}`;
  if (m[DAY]! > m[DAY_LIMIT]!) return `день ${m[DAY]} > ${m[DAY_LIMIT]}`;
  if (m[TOOLS]! >>> TOOL_IDS.length !== 0) return 'лишние биты орудий';
  for (let c = 1; c < 16; c++) {
    const t = m[TIER + c]!;
    if (t > 4) return `редкость ${t} в камере ${c}`;
    if (m[LOCK + c] === 1 && t !== -1) return `узник за запертой дверью ${c}`;
    if (m[LOCK + c] === 0 && (m[PRE_TIER + c] !== -1 || m[NEST + c] !== 0)) return `метки двери на открытой ${c}`;
  }
  return null;
}

function randomTools(r: Rng): ToolId[] {
  return TOOL_IDS.filter(() => r.chance(0.3));
}

describe('ГСЧ', () => {
  it('детерминированный: то же зерно — те же числа', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('int в диапазоне, float в [0, 1), среднее около 0,5', () => {
    const r = new Rng(1);
    let sum = 0;
    for (let i = 0; i < 100000; i++) {
      const k = r.int(6);
      expect(k >= 0 && k < 6).toBe(true);
      const f = r.float();
      expect(f >= 0 && f < 1).toBe(true);
      sum += f;
    }
    expect(sum / 100000).toBeCloseTo(0.5, 2);
  });

  it('потоки по метке: воспроизводимы, независимы от родителя и друг от друга', () => {
    const r = new Rng(7);
    r.next();
    r.next();
    const a = r.stream('doors');
    const b = new Rng(7).stream('doors');
    const c = new Rng(7).stream('events');
    const xs = [a.next(), a.next(), a.next()];
    expect([b.next(), b.next(), b.next()]).toEqual(xs);
    expect([c.next(), c.next(), c.next()]).not.toEqual(xs);
    const into = new Rng(0);
    new Rng(7).streamInto('doors', into);
    expect([into.next(), into.next(), into.next()]).toEqual(xs);
  });
});

describe('полный забег', () => {
  it('случайные ходы до конца без ошибок, инварианты после каждого хода', () => {
    const r = new Rng(2026);
    const s = new State();
    const buf = codeBuffer();
    for (let run = 0; run < 600; run++) {
      startRun(s, r, p, { start: START_EVENT_IDS[run % START_EVENT_IDS.length]!, tools: randomTools(r) });
      let moves = 0;
      while (s.m[PHASE] !== P_END) {
        const n = legalCodes(s, buf);
        expect(n).toBeGreaterThan(0);
        applyCode(s, buf[r.int(n)]!, r, p);
        const bad = broken(s);
        if (bad) throw new Error(`забег ${run}, ход ${moves}: ${bad}`);
        expect(++moves).toBeLessThan(2000);
      }
      expect(s.m[DAY]).toBe(s.m[DAY_LIMIT]);
    }
  });

  it('со всеми орудиями сразу', () => {
    const r = new Rng(5);
    const s = new State();
    const buf = codeBuffer();
    for (let run = 0; run < 500; run++) {
      startRun(s, r, p, { tools: [...TOOL_IDS], start: START_EVENT_IDS[run % START_EVENT_IDS.length]! });
      randomPlayout(s, r, p, buf);
      expect(broken(s)).toBeNull();
    }
  });

  it('тот же ГСЧ — тот же забег; копия состояния играет так же, как оригинал', () => {
    const s = new State();
    const t = new State();
    const buf = codeBuffer();
    startRun(s, new Rng(99), p);
    copy(s, t);
    expect(randomPlayout(s, new Rng(100), p, buf)).toBe(randomPlayout(t, new Rng(100), p, buf));
    expect(Array.from(s.m)).toEqual(Array.from(t.m));
  });

  // Таймаут с запасом: под vitest и рядом с тестами других копий прогон в разы медленнее.
  it('скорость плейаута (цель ≤ 0,1 мс на забег)', { timeout: 60_000 }, () => {
    const r = new Rng(1);
    const start = new State();
    const s = new State();
    const buf = codeBuffer();
    startRun(start, r, p);
    let total = 0;
    for (let i = 0; i < 2000; i++) {
      copy(start, s);
      total += randomPlayout(s, r, p, buf);
    }
    const N = 20000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      copy(start, s);
      total += randomPlayout(s, r, p, buf);
    }
    const us = ((performance.now() - t0) * 1000) / N;
    console.log(`плейаут: ${us.toFixed(1)} мкс на забег, в среднем ${(total / (N + 2000)).toFixed(2)} призм.`);
    expect(score(s)).toBeGreaterThanOrEqual(0);
    expect(us).toBeLessThan(1000); // мягкий порог против медленных машин CI
  });
});
