import { describe, expect, it } from 'vitest';

import {
  activeDuration,
  groupByStrategy,
  missingPrices,
  rollingNorm,
  runNet,
  strategyKey,
} from '../src/core/analysis.js';
import type { ItemDelta, Run } from '../src/core/types.js';

const T0 = 1_700_000_000_000;

function delta(configBaseId: number, qty: number, ts: number, cost = false): ItemDelta {
  return {
    ts,
    configBaseId,
    qty,
    proto: cost ? 'Spv3Open' : 'PickItem',
    kind: cost ? 'mapCost' : 'loot',
    pageId: 100,
    slotId: 0,
  };
}

function run(opts: Partial<Run> & { startedAt: number; endedAt: number }): Run {
  return {
    areaId: 5348,
    asset: 'YL_MaNeiLaYuLin100',
    levelType: 3,
    isHub: false,
    durationMs: opts.endedAt - opts.startedAt,
    drops: [],
    costs: [],
    ...opts,
  };
}

describe('простой не должен раздувать знаменатель', () => {
  it('забег без пауз считается целиком', () => {
    const r = run({
      startedAt: T0,
      endedAt: T0 + 90_000,
      drops: [delta(100300, 10, T0 + 30_000), delta(100300, 10, T0 + 60_000)],
    });
    expect(activeDuration(r)).toBe(90_000);
  });

  it('десятиминутный простой внутри карты обрезается порогом', () => {
    // Зашёл, что-то подобрал, ушёл пить чай на 10 минут, вернулся и вышел.
    const r = run({
      startedAt: T0,
      endedAt: T0 + 660_000,
      drops: [delta(100300, 5, T0 + 20_000), delta(100300, 5, T0 + 640_000)],
    });

    // Без обрезки вышло бы 11 минут и смехотворный темп.
    expect(activeDuration(r)).toBe(20_000 + 180_000 + 20_000);
  });

  it('карта без единого события не засчитывается больше порога', () => {
    const r = run({ startedAt: T0, endedAt: T0 + 3_600_000 });
    expect(activeDuration(r)).toBe(180_000);
  });

  it('короткая карта без событий засчитывается целиком', () => {
    const r = run({ startedAt: T0, endedAt: T0 + 45_000 });
    expect(activeDuration(r)).toBe(45_000);
  });

  it('открытый забег меряется до указанного момента', () => {
    const r = { ...run({ startedAt: T0, endedAt: T0 }), endedAt: null, durationMs: null };
    expect(activeDuration(r, 180_000, T0 + 30_000)).toBe(30_000);
  });
});

describe('стратегия определяется по тому, чем открыта карта', () => {
  it('подпись собирается из вложенных предметов и не зависит от порядка', () => {
    const a = run({
      startedAt: T0,
      endedAt: T0 + 1000,
      costs: [delta(10022, 1, T0, true), delta(400000, 1, T0, true)],
    });
    const b = run({
      startedAt: T0,
      endedAt: T0 + 1000,
      costs: [delta(400000, 1, T0, true), delta(10022, 1, T0, true)],
    });
    expect(strategyKey(a)).toBe(strategyKey(b));
  });

  it('карта без вложений — отдельная стратегия', () => {
    expect(strategyKey(run({ startedAt: T0, endedAt: T0 + 1000 }))).toBe('none');
  });

  it('стратегии сравниваются с размером выборки', () => {
    const priceOf = (id: number) => (id === 100300 ? 1 : id === 10022 ? 30 : null);

    const cheap = [1, 2, 3].map((i) =>
      run({
        startedAt: T0 + i * 100_000,
        endedAt: T0 + i * 100_000 + 60_000,
        drops: [delta(100300, 40, T0 + i * 100_000 + 30_000)],
      }),
    );
    const juiced = [1, 2].map((i) =>
      run({
        startedAt: T0 + 1_000_000 + i * 100_000,
        endedAt: T0 + 1_000_000 + i * 100_000 + 60_000,
        costs: [delta(10022, 1, T0 + 1_000_000 + i * 100_000, true)],
        drops: [delta(100300, 120, T0 + 1_000_000 + i * 100_000 + 30_000)],
      }),
    );

    const groups = groupByStrategy([...cheap, ...juiced], priceOf);
    expect(groups).toHaveLength(2);

    const withCompass = groups.find((g) => g.key === '10022')!;
    const without = groups.find((g) => g.key === 'none')!;

    expect(withCompass.runs).toBe(2);
    expect(withCompass.costPerRun).toBe(30);
    // 120 добыто минус 30 вложено = 90 чистыми за минуту.
    expect(withCompass.netPerRun).toBe(90);
    expect(Math.round(withCompass.rate.median)).toBe(5400);

    expect(without.costPerRun).toBe(0);
    expect(without.netPerRun).toBe(40);
    expect(Math.round(without.rate.median)).toBe(2400);
  });
});

describe('чистая стоимость забега', () => {
  it('вложения вычитаются из добычи', () => {
    const priceOf = (id: number) => (id === 100300 ? 1 : id === 10022 ? 34 : null);
    const r = run({
      startedAt: T0,
      endedAt: T0 + 60_000,
      drops: [delta(100300, 100, T0 + 10_000)],
      costs: [delta(10022, 2, T0, true)],
    });
    expect(runNet(r, priceOf)).toBe(100 - 68);
  });

  it('предмет без цены не считается бесплатным приобретением', () => {
    const r = run({
      startedAt: T0,
      endedAt: T0 + 60_000,
      drops: [delta(999999, 5, T0 + 10_000)],
    });
    expect(runNet(r, () => null)).toBe(0);
  });
});

describe('что пробить следующим', () => {
  it('порядок по количеству выпавшего, а не по алфавиту', () => {
    const priceOf = (id: number) => (id === 100300 ? 1 : null);
    const runs = [
      run({
        startedAt: T0,
        endedAt: T0 + 60_000,
        drops: [delta(100200, 200, T0 + 1000), delta(6002, 1, T0 + 2000), delta(100300, 5, T0)],
      }),
      run({
        startedAt: T0 + 100_000,
        endedAt: T0 + 160_000,
        drops: [delta(100200, 34, T0 + 101_000), delta(200028, 15, T0 + 102_000)],
      }),
    ];

    const missing = missingPrices(runs, priceOf);
    expect(missing.map((m) => m.configBaseId)).toEqual([100200, 200028, 6002]);
    expect(missing[0]).toEqual({ configBaseId: 100200, qty: 234, runs: 2, isCost: false });
    // ФЕ стоит сам себя, в список не попадает.
    expect(missing.some((m) => m.configBaseId === 100300)).toBe(false);
  });
});

describe('что пробить: расходники важнее числа штук', () => {
  it('неоценённый маяк идёт выше 305 песчинок по 0,0001', () => {
    // Песок наверху был ошибкой ранжирования: он ничего не стоит,
    // а маяк тратится на каждую карту и занижает прибыль напрямую.
    const runs = [
      run({
        startedAt: T0,
        endedAt: T0 + 60_000,
        drops: [delta(100200, 305, T0 + 1000)],
        costs: [delta(400033, 1, T0, true)],
      }),
    ];

    const missing = missingPrices(runs, () => null);
    expect(missing[0]!.configBaseId).toBe(400033);
    expect(missing[0]!.isCost).toBe(true);
    expect(missing[1]!.configBaseId).toBe(100200);
  });

  it('среди дропа порядок по числу забегов, а не по штукам', () => {
    const runs = [
      run({ startedAt: T0, endedAt: T0 + 60_000, drops: [delta(1, 500, T0 + 1000)] }),
      run({ startedAt: T0 + 100_000, endedAt: T0 + 160_000, drops: [delta(2, 3, T0 + 101_000)] }),
      run({ startedAt: T0 + 200_000, endedAt: T0 + 260_000, drops: [delta(2, 3, T0 + 201_000)] }),
    ];
    const missing = missingPrices(runs, () => null);
    expect(missing[0]!.configBaseId).toBe(2);
  });
});

describe('норма для сравнения', () => {
  it('берётся медиана окна, а не лучший результат', () => {
    const rates = [100, 200, 300, 9000];
    expect(rollingNorm(rates)).toBe(250);
  });

  it('старые забеги за пределами окна не тянут норму', () => {
    const old = Array.from({ length: 30 }, () => 100);
    const recent = Array.from({ length: 20 }, () => 900);
    expect(rollingNorm([...old, ...recent], 20)).toBe(900);
  });

  it('пустая история даёт ноль, а не деление на ноль', () => {
    expect(rollingNorm([])).toBe(0);
  });
});
