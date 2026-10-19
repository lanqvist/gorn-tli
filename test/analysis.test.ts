import { describe, expect, it } from 'vitest';

import {
  activeDuration,
  groupByStrategy,
  isFarmingRun,
  mergeRuns,
  missingPrices,
  rollingNorm,
  runFe,
  runNet,
  strategyKey,
  topDrops,
} from '../src/core/analysis.js';
import {
  FE_ID,
  mergePlayerInfo,
  mergePlayerProfile,
  type ItemDelta,
  type Run,
} from '../src/core/types.js';

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
    playerId: null,
    seasonId: null,
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

describe('общие хелперы забегов', () => {
  it('фарм — не город и не проход через зону', () => {
    expect(isFarmingRun(run({ startedAt: T0, endedAt: T0 + 60_000 }))).toBe(true);
    expect(isFarmingRun(run({ startedAt: T0, endedAt: T0 + 4_000 }))).toBe(false);
    expect(isFarmingRun(run({ startedAt: T0, endedAt: T0 + 60_000, isHub: true }))).toBe(false);
  });

  it('ФЕ считается только по самой валюте', () => {
    const r = run({
      startedAt: T0,
      endedAt: T0 + 60_000,
      drops: [delta(FE_ID, 30, T0 + 1), delta(FE_ID, 12, T0 + 2), delta(5028, 1, T0 + 3)],
    });
    expect(runFe(r)).toBe(42);
  });

  it('слияние забегов: поздний список побеждает, порядок по времени', () => {
    const old = run({ startedAt: T0 + 1000, endedAt: T0 + 2000, playerId: null });
    const fresh = { ...old, playerId: '956082728577617920' };
    const earlier = run({ startedAt: T0, endedAt: T0 + 500 });
    const merged = mergeRuns([old], [fresh, earlier]);
    expect(merged.map((r) => r.startedAt)).toEqual([T0, T0 + 1000]);
    expect(merged[1]!.playerId).toBe('956082728577617920');
  });
});

describe('профиль персонажа', () => {
  const full = {
    playerId: '956082728577617920',
    name: 'VLPZDC#3648',
    heroId: 1700,
    level: 84,
    seasonId: 1501,
    lastSeenAt: T0,
  };

  it('вход без профиля не стирает известные поля', () => {
    const merged = mergePlayerInfo(full, {
      kind: 'playerInfo',
      ts: T0 + 1000,
      line: 1,
      playerId: full.playerId,
    });
    expect(merged).toEqual({ ...full, lastSeenAt: T0 + 1000 });
  });

  it('свежие значения побеждают, время не откатывается назад', () => {
    const merged = mergePlayerProfile(full, {
      ...full,
      level: 85,
      name: null,
      lastSeenAt: T0 - 1,
    });
    expect(merged.level).toBe(85);
    expect(merged.name).toBe('VLPZDC#3648');
    expect(merged.lastSeenAt).toBe(T0);
  });
});

describe('забеги разных сезонов — по ценам своего сезона', () => {
  const ITEM = 5000;
  const BEACON = 5001;
  // В SS13 предмет стоил 2 ФЕ, в SS14 — 5; маяк есть только в ценах SS13.
  const prices = new Map<number, Map<number, number>>([
    [1501, new Map([[ITEM, 2], [BEACON, 4]])],
    [1601, new Map([[ITEM, 5]])],
  ]);
  const pricing = {
    forRun: (r: Run) => (id: number) => prices.get(r.seasonId ?? 1601)?.get(id) ?? null,
  };
  const ss13 = run({
    startedAt: T0,
    endedAt: T0 + 600_000,
    seasonId: 1501,
    drops: [delta(ITEM, 10, T0 + 1000)],
    costs: [delta(BEACON, 1, T0, true)],
  });
  const ss14 = run({
    startedAt: T0 + 3_600_000,
    endedAt: T0 + 4_200_000,
    seasonId: 1601,
    drops: [delta(ITEM, 10, T0 + 3_601_000)],
    costs: [delta(BEACON, 1, T0 + 3_600_000, true)],
  });

  it('чистая стоимость — по таблице сезона забега', () => {
    expect(runNet(ss13, pricing)).toBe(20 - 4);
    expect(runNet(ss14, pricing)).toBe(50);
  });

  it('стратегия складывает забеги, оценённые каждый своими ценами', () => {
    const [s] = groupByStrategy([ss13, ss14], pricing);
    expect(s!.runs).toBe(2);
    expect(s!.netPerRun).toBe((16 + 50) / 2);
    expect(s!.costPerRun).toBe(4 / 2);
  });

  it('нет цены — только там, где её нет в сезоне забега', () => {
    const missing = missingPrices([ss13, ss14], pricing);
    expect(missing).toEqual([{ configBaseId: BEACON, qty: 1, runs: 1, isCost: true }]);
  });

  it('одна таблица на всех по-прежнему работает', () => {
    const flat = (id: number) => (id === ITEM ? 5 : null);
    expect(runNet(ss13, flat)).toBe(50);
  });
});

describe('крупное за сессию', () => {
  const prices: Record<number, number> = { 200028: 6.4, 5028: 3, 100300: 1, 7001: 51 };
  const priceOf = (id: number) => prices[id] ?? null;

  it('штуки предмета в забеге складываются, дорогие первыми, не больше лимита', () => {
    const a = run({
      startedAt: T0,
      endedAt: T0 + 90_000,
      drops: [
        delta(200028, 1, T0 + 10_000),
        delta(200028, 1, T0 + 40_000),
        delta(5028, 1, T0 + 20_000),
      ],
    });
    const b = run({
      startedAt: T0 + 200_000,
      endedAt: T0 + 290_000,
      drops: [delta(7001, 1, T0 + 250_000), delta(5028, 2, T0 + 260_000)],
    });
    const top = topDrops([a, b], priceOf, 2);
    expect(top.map((t) => [t.configBaseId, t.totalFe])).toEqual([
      [7001, 51],
      [200028, 12.8],
    ]);
    expect(top[1]!.at).toBe(T0 + 40_000);
    expect(top[1]!.run).toBe(a);
  });

  it('ФЕ, предметы без цены и израсходованное не в счёт', () => {
    const r = run({
      startedAt: T0,
      endedAt: T0 + 90_000,
      drops: [
        delta(FE_ID, 300, T0 + 1_000),
        delta(9999, 5, T0 + 2_000),
        delta(5028, -1, T0 + 3_000),
      ],
    });
    expect(topDrops([r], priceOf)).toEqual([]);
  });
});
