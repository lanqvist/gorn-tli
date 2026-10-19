import { describe, expect, it } from 'vitest';

import { toCsv } from '../src/core/csv.js';
import { dailyTotals, dayStart, groupByMap, sessionTotals } from '../src/core/history.js';
import { choosePrice, OWN_PRICE_TTL_MS } from '../src/core/priceStore.js';
import { FE_ID, type Run } from '../src/core/types.js';

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 11, 20, 0).getTime();
const priceOf = (id: number) => (id === FE_ID ? 1 : null);

/** Забег длиной в минуту, принёсший `fe` валюты. Конец — `endedAt`. */
function run(endedAt: number, fe: number, asset = 'YL_MaNeiLaYuLin100'): Run {
  const startedAt = endedAt - 60_000;
  return {
    areaId: 5348,
    asset,
    levelType: 3,
    startedAt,
    endedAt,
    durationMs: 60_000,
    isHub: false,
    playerId: null,
    seasonId: null,
    drops: [
      {
        ts: startedAt + 30_000,
        configBaseId: FE_ID,
        qty: fe,
        proto: 'PickItem',
        kind: 'loot',
        pageId: 102,
        slotId: 0,
      },
    ],
    costs: [],
  };
}

describe('выбор цены', () => {
  const community = (fe: number, updatedAt: number) => ({ fe, updatedAtMs: () => updatedAt });

  it('свежая своя пробивка побеждает', () => {
    const own = { fe: 10, observedAt: NOW - DAY };
    expect(choosePrice(own, community(20, NOW), NOW)).toEqual({ fe: 10, source: 'own' });
  });

  it('устаревшая своя уступает более новой цене сообщества', () => {
    const own = { fe: 10, observedAt: NOW - OWN_PRICE_TTL_MS - 1 };
    expect(choosePrice(own, community(20, NOW - DAY), NOW)).toEqual({
      fe: 20,
      source: 'community',
    });
  });

  it('устаревшая своя остаётся, если сообщество ещё старше или молчит', () => {
    const own = { fe: 10, observedAt: NOW - 5 * DAY };
    expect(choosePrice(own, community(20, NOW - 9 * DAY), NOW)?.source).toBe('own');
    expect(choosePrice(own, null, NOW)?.source).toBe('own');
    expect(choosePrice(own, community(20, Number.NaN), NOW)?.source).toBe('own');
  });

  it('без своей — цена сообщества, без обеих — ничего', () => {
    expect(choosePrice(null, community(20, NOW), NOW)?.source).toBe('community');
    expect(choosePrice(null, null, NOW)).toBeNull();
  });

  it('время сообщества не разбирается, пока своя свежая', () => {
    let parsed = 0;
    const lazy = { fe: 20, updatedAtMs: () => (parsed++, NOW) };
    choosePrice({ fe: 10, observedAt: NOW }, lazy, NOW);
    expect(parsed).toBe(0);
  });
});

describe('срезы истории', () => {
  it('карты группируются по имени, больше времени — выше', () => {
    const runs = [
      run(NOW - 3_000_000, 10, 'YL_MaNeiLaYuLin100'),
      run(NOW - 2_000_000, 30, 'YL_MaNeiLaYuLin100'),
      run(NOW - 1_000_000, 50, 'XZ_XiDiChongGu01'),
    ];
    const maps = groupByMap(runs, (r) => r.asset!.replace(/^[A-Z]+_|\d+$/g, ''), priceOf);
    expect(maps.map((m) => [m.name, m.runs])).toEqual([
      ['MaNeiLaYuLin', 2],
      ['XiDiChongGu', 1],
    ]);
    expect(maps[0]!.netPerRun).toBe(20);
    expect(maps[0]!.rate.median).toBe(1200);
  });

  it('дни: ровный ряд с пустыми днями, забег — по дню окончания', () => {
    const today = dayStart(NOW);
    const runs = [run(today + 3_600_000, 40), run(today - DAY + 3_600_000, 15)];
    const days = dailyTotals(runs, priceOf, 3, NOW);
    expect(days.map((d) => d.day)).toEqual([
      dayStart(today - 2 * DAY + 12 * 3_600_000),
      dayStart(today - DAY + 12 * 3_600_000),
      today,
    ]);
    expect(days.map((d) => d.netFe)).toEqual([0, 15, 40]);
    expect(days[2]!.inMapMs).toBe(60_000);
  });

  it('сессии: забег на границе — в той, где закончился; пустые отброшены', () => {
    const sessions = [
      { startedAt: 0, endedAt: 1_000_000 },
      { startedAt: 1_000_000, endedAt: 1_100_000 },
      { startedAt: 1_100_000, endedAt: 1_500_000 },
      { startedAt: 1_500_000, endedAt: null },
    ];
    // Второй забег закончился ровно в момент сброса — он уже во второй сессии.
    const runs = [run(500_000, 5), run(1_000_000, 7), run(2_000_000, 9)];
    const totals = sessionTotals(sessions, runs, priceOf);
    expect(totals.map((s) => [s.startedAt, s.runs, s.netFe])).toEqual([
      [1_500_000, 1, 9],
      [1_000_000, 1, 7],
      [0, 1, 5],
    ]);
  });
});

describe('CSV для Excel', () => {
  it('BOM, точка с запятой, дробная запятая, экранирование', () => {
    const csv = toCsv(['Карта', 'ФЕ'], [
      ['Пустотные земли; метка 8', 12.345],
      ['Сказал "привет"', null],
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split('\r\n')).toEqual([
      'Карта;ФЕ',
      '"Пустотные земли; метка 8";12,35',
      '"Сказал ""привет""";',
      '',
    ]);
  });

  it('английский диалект: запятая между полями, точка в дробях', () => {
    const csv = toCsv(['Map', 'FE'], [['Voidlands, Timemark 8', 12.345]], 'en');
    expect(csv.slice(1).split('\r\n')).toEqual(['Map,FE', '"Voidlands, Timemark 8",12.35', '']);
  });
});

describe('история по ценам сезона забега', () => {
  const ITEM = 5000;
  const priceIn = (season: number | null) => (id: number) =>
    id === ITEM ? (season === 1501 ? 2 : 5) : null;
  const pricing = { forRun: (r: Run) => priceIn(r.seasonId) };
  const base = (startedAt: number, seasonId: number): Run => ({
    areaId: 1,
    asset: 'YL_MaNeiLaYuLin100',
    levelType: 3,
    startedAt,
    endedAt: startedAt + 600_000,
    durationMs: 600_000,
    isHub: false,
    playerId: null,
    seasonId,
    drops: [
      {
        ts: startedAt + 1000,
        configBaseId: ITEM,
        qty: 10,
        proto: 'PickItem',
        kind: 'loot',
        pageId: 100,
        slotId: 0,
      },
    ],
    costs: [],
  });
  const now = new Date(2026, 9, 17, 12).getTime();
  const runs = [base(now - 2 * 3_600_000, 1501), base(now - 3_600_000, 1601)];

  it('карты, дни и сессии суммируют забеги по ценам их сезонов', () => {
    expect(groupByMap(runs, () => 'map', pricing)[0]!.netPerRun).toBe((20 + 50) / 2);
    expect(dailyTotals(runs, pricing, 1, now)[0]!.netFe).toBe(70);
    expect(sessionTotals([{ startedAt: 0, endedAt: null }], runs, pricing)[0]!.netFe).toBe(70);
  });
});

describe('тюрьма — в итоге, но не в темпе', () => {
  it('добыча тюрьмы входит в итог дня и сессии, время и число забегов — нет', () => {
    const runs = [run(NOW - 60 * 60_000, 20), run(NOW - 30 * 60_000, 171, 'ZhongZuiDiYu')];
    const [session] = sessionTotals([{ startedAt: 0, endedAt: null }], runs, priceOf);
    expect(session).toMatchObject({ netFe: 191, prisonFe: 171, prisonRuns: 1, runs: 1, inMapMs: 60_000 });
    const today = dailyTotals(runs, priceOf, 1, NOW)[0]!;
    expect(today).toMatchObject({ netFe: 191, prisonFe: 171, runs: 1, inMapMs: 60_000 });
  });

  it('сессия только с тюрьмой не теряется', () => {
    const runs = [run(NOW - 10 * 60_000, 50, 'ZhongZuiDiYu')];
    expect(sessionTotals([{ startedAt: 0, endedAt: null }], runs, priceOf)).toHaveLength(1);
  });

  it('карты считаются без тюрьмы, если движок отдаёт им забеги в темп', () => {
    const runs = [run(NOW - 60 * 60_000, 20), run(NOW - 30 * 60_000, 171, 'ZhongZuiDiYu')];
    const rated = runs.filter((r) => !r.asset?.startsWith('ZhongZuiDiYu'));
    expect(groupByMap(rated, (r) => r.asset ?? '', priceOf).map((m) => m.name)).toEqual([
      'YL_MaNeiLaYuLin100',
    ]);
  });
});
