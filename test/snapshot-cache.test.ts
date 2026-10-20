import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OWN_PRICE_TTL_MS, PriceStore } from '../src/core/priceStore.js';
import type { RetroScanResult } from '../src/core/retroScan.js';
import { TradeLedger } from '../src/core/trade.js';
import { FE_ID, type ItemDelta, type Run } from '../src/core/types.js';

/**
 * Срез собирается из кэша агрегатов истории и досчитанного поверх открытого
 * забега. Проверяется, что такой срез совпадает с собранным с нуля после
 * всего, что меняет историю или её оценку, — и что пульс без событий
 * историю не пересчитывает.
 */

const ITEM = 5000;
const RARE = 5001;
const JUNK = 5002;
const BEACON = 5003;
const SS14 = 1601;
const MIN = 60_000;
const HOUR = 60 * MIN;
// Середина дня по UTC: до полуночи по местному времени далеко в любом поясе
// России, и ряд дней не сдвигается сам по себе посреди теста.
const NOW = Date.UTC(2026, 9, 20, 9, 0, 0);

const scan = vi.hoisted(() => ({ result: null as unknown }));
const feeds = vi.hoisted(() => ({
  prices: new Map<number, number>(),
  updatedAt: 0,
}));

vi.mock('electron', () => ({ net: {}, protocol: {} }));
vi.mock('../src/main/tailer.js', () => ({
  LogTailer: class {
    start(): void {}
    stop(): void {}
  },
}));
vi.mock('../src/core/retroScan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/retroScan.js')>()),
  retroScan: async () => scan.result,
}));
vi.mock('../src/main/communityPrices.js', () => ({
  CommunityPriceFeed: class {
    onUpdate(): void {}
    start(): void {}
    loadOnce(): void {}
    stop(): void {}
    get size(): number {
      return feeds.prices.size;
    }
    get fetchedAtMs(): number | null {
      return null;
    }
    get stale(): boolean {
      return false;
    }
    all() {
      return [...feeds.prices].map(([id, fe]) => this.row(id, fe));
    }
    priceOf(id: number) {
      const fe = feeds.prices.get(id);
      return fe === undefined ? null : this.row(id, fe);
    }
    private row(configBaseId: number, fe: number) {
      return {
        configBaseId,
        fe,
        p10: fe,
        submissions: 1,
        devices: 1,
        updatedAt: new Date(feeds.updatedAt).toISOString(),
      };
    }
  },
}));

const { Engine } = await import('../src/main/engine.js');
type Snapshot = import('../src/main/engine.js').Snapshot;

function delta(configBaseId: number, qty: number, ts: number, kind: 'loot' | 'mapCost' = 'loot'): ItemDelta {
  return { ts, configBaseId, qty, proto: 'PickItem', kind, pageId: 100, slotId: 0 };
}

function run(startedAt: number, asset: string, drops: ItemDelta[], costs: ItemDelta[] = []): Run {
  return {
    areaId: 5348,
    asset,
    levelType: 3,
    startedAt,
    endedAt: startedAt + 10 * MIN,
    durationMs: 10 * MIN,
    isHub: false,
    playerId: 'p1',
    seasonId: SS14,
    drops,
    costs,
  };
}

/** Строка лога с меткой времени (UTC, как пишет игра). */
function line(ts: number, text: string): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}-` +
    `${p(d.getUTCHours())}.${p(d.getUTCMinutes())}.${p(d.getUTCSeconds())}:${p(d.getUTCMilliseconds(), 3)}`;
  return `[${stamp}][  1]TLLua: Display: [Game] ${text}`;
}

function enter(ts: number, asset: string, areaId = 5348): string[] {
  return [
    line(ts, `LevelMgr@:LevelPath, Model = Content/Art/Maps/X/${asset}/${asset}.umap World'/Game/X'`),
    line(ts, `LevelMgr:_EnterLevelSuccess() ${areaId}`),
  ];
}

/** Пробивка цены на бирже: запрос и ответ, связанные по SynId. */
function priceCheck(ts: number, id: number, fe: number): string[] {
  const net = (text: string) => line(ts, text).replace('TLLua', 'TLNetGame');
  return [
    net('----Socket SendMessage STT----XchgSearchPrice----SynId = 7'),
    net(''),
    '+typ3 [13]',
    `+filters+1+refer [${id}]`,
    '|       | +key [16]',
    net('----Socket SendMessage End----'),
    net('----Socket RecvMessage STT----XchgSearchPrice----SynId = 7'),
    net(''),
    `+prices+1+currency [${FE_ID}]`,
    `|      | +unitPrices+1 [${fe}]`,
    net('----Socket RecvMessage End----'),
  ];
}

let dir: string;
let engine: InstanceType<typeof Engine>;
// Закрытые методы движка — сборка среза и сброс кэша.
let internals: {
  buildSnapshot(): Snapshot;
  invalidate(): void;
  consume(lines: string[]): void;
  segmenter: { addDelta(d: ItemDelta): void };
};
let last: Snapshot | null;

/** Срез с нуля: все кэши сброшены. */
function fresh(): Snapshot {
  internals.invalidate();
  return internals.buildSnapshot();
}

/** Пачка строк лога → срез, который ушёл в интерфейс. */
function feed(lines: string[]): Snapshot {
  last = null;
  internals.consume(lines);
  expect(last).not.toBeNull();
  return last!;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW - 30 * HOUR);
  dir = mkdtempSync(join(tmpdir(), 'gorn-snapshot-cache-'));

  // Сообщество знает предмет дороже своей пробивки и свежее неё:
  // когда пробивка устареет, цена переключится на сообщество.
  feeds.prices = new Map([
    [ITEM, 20],
    [RARE, 100],
  ]);
  feeds.updatedAt = NOW - HOUR;
  const prices = new PriceStore();
  prices.observe(
    {
      kind: 'priceObservation',
      ts: NOW - OWN_PRICE_TTL_MS + HOUR,
      line: 0,
      configBaseId: ITEM,
      currency: FE_ID,
      unitPrices: [5],
      synId: 1,
    },
    SS14,
  );

  const runs: Run[] = [];
  for (let i = 0; i < 12; i++) {
    const t = NOW - 40 * HOUR + i * 3 * HOUR;
    runs.push(
      run(
        t,
        i % 5 === 4 ? 'ZhongZuiDiYu01' : `YL_Map${i % 3}_100`,
        [delta(FE_ID, 10 + i, t + MIN), delta(ITEM, 3, t + 2 * MIN), delta(i % 2 ? RARE : JUNK, 1, t + 4 * MIN)],
        i % 3 === 0 ? [delta(BEACON, 1, t, 'mapCost')] : [],
      ),
    );
  }

  scan.result = {
    runs,
    prices,
    trade: new TradeLedger(),
    filesScanned: 1,
    linesScanned: 0,
    seasonIds: new Set([SS14]),
    elapsedMs: 0,
    unknownProtos: new Map(),
    failed: [],
    slots: [],
    latestSeasonId: SS14,
    players: [{ playerId: 'p1', name: null, heroId: null, level: 90, seasonId: SS14, lastSeenAt: NOW - HOUR }],
    lastPlayerId: 'p1',
    currentLog: null,
    segmenter: null,
  } satisfies RetroScanResult;

  engine = new Engine(dir, [
    { id: ITEM, name: 'Item', icon: null },
    { id: RARE, name: 'Rare', icon: null },
    { id: JUNK, name: 'Junk', icon: null },
    { id: BEACON, name: 'Voidlands Beacon (Timemark 8)', icon: null },
  ]);
  internals = engine as unknown as typeof internals;
  engine.on('snapshot', (s: Snapshot) => (last = s));
  await engine.start(dir);

  // Три сессии: история, прошлая и текущая.
  engine.resetSession();
  vi.setSystemTime(NOW - 8 * HOUR);
  engine.resetSession();
  vi.setSystemTime(NOW - 10 * MIN);

  // Открытая карта с добычей.
  feed(enter(NOW - 10 * MIN, 'YL_Map1_100'));
  internals.segmenter.addDelta(delta(FE_ID, 7, NOW - 9 * MIN));
  internals.segmenter.addDelta(delta(RARE, 2, NOW - 8 * MIN));
  vi.setSystemTime(NOW);
});

afterEach(() => {
  engine.stop();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('кэш агрегатов истории', () => {
  it('пульс досчитывает открытый забег, не пересобирая историю', () => {
    const before = internals.buildSnapshot();

    // Подбор на карте: только открытый забег и счётчики сессии.
    internals.segmenter.addDelta(delta(JUNK, 4, NOW - MIN));
    internals.segmenter.addDelta(delta(ITEM, 2, NOW - 30_000));
    const pulse = internals.buildSnapshot();
    expect(pulse.current!.drops.map((d) => d.configBaseId)).toContain(JUNK);
    expect(pulse.totals.valueFe).toBe(before.totals.valueFe + 2 * 5);
    expect(pulse.missing.find((m) => m.configBaseId === JUNK)!.qty).toBe(
      before.missing.find((m) => m.configBaseId === JUNK)!.qty + 4,
    );
    // Агрегаты взяты из кэша — тот же объект.
    expect(pulse.strategies).toBe(before.strategies);
    expect(pulse.recent).toBe(before.recent);

    expect(pulse).toEqual(fresh());
  });

  it('после закрытия забега', () => {
    const before = internals.buildSnapshot();
    const closed = feed(enter(NOW, 'YJ_YuJinZhiXiBiNanSuo200', 110));
    expect(closed.current).toBeNull();
    expect(closed.recent).toHaveLength(before.recent.length + 1);
    expect(closed.recent[0]!.startedAt).toBe(NOW - 10 * MIN);
    expect(closed.totals.runs).toBe(before.totals.runs);
    expect(closed).toEqual(fresh());

    // Возврат порталом: закрытый забег снова открыт.
    vi.setSystemTime(NOW + MIN);
    const resumed = feed(enter(NOW + MIN, 'YL_Map1_100'));
    expect(resumed.current!.startedAt).toBe(NOW - 10 * MIN);
    expect(resumed.recent).toEqual(before.recent);
    expect(resumed).toEqual(fresh());
  });

  it('после новой пробивки известного предмета', () => {
    const before = internals.buildSnapshot();
    const repriced = feed(priceCheck(NOW, ITEM, 50));
    expect(repriced.totals.valueFe).not.toBe(before.totals.valueFe);
    expect(repriced.rate).not.toEqual(before.rate);
    // Число цен то же — порог «дорогой находки» всё равно пересчитан.
    expect(repriced.diagnostics.pricedItems).toBe(before.diagnostics.pricedItems);
    expect(repriced.jackpotAutoFe).not.toBe(before.jackpotAutoFe);
    expect(repriced).toEqual(fresh());
  });

  it('после пробивки предмета без цены', () => {
    expect(internals.buildSnapshot().missing.map((m) => m.configBaseId)).toContain(JUNK);
    const priced = feed(priceCheck(NOW, JUNK, 1));
    expect(priced.missing.map((m) => m.configBaseId)).not.toContain(JUNK);
    expect(priced).toEqual(fresh());
  });

  it('после исключения предмета и смены фильтра', () => {
    engine.setExcluded(RARE, true);
    expect(last!.recent.flatMap((r) => r.drops).find((d) => d.configBaseId === RARE)!.priceSource).toBe(
      'excluded',
    );
    expect(last).toEqual(fresh());

    engine.setRunScope({ playerId: null, allSeasons: true });
    expect(last).toEqual(fresh());
  });

  it('своя пробивка устарела — без событий, по времени', () => {
    const before = internals.buildSnapshot();
    expect(before.recent[0]!.drops.find((d) => d.configBaseId === ITEM)!.priceSource).toBe('own');

    vi.setSystemTime(NOW + 2 * HOUR);
    const later = internals.buildSnapshot();
    expect(later.recent[0]!.drops.find((d) => d.configBaseId === ITEM)!.priceSource).toBe('community');
    expect(later).toEqual(fresh());
  });

  it('полночь сдвигает ряд дней', () => {
    internals.buildSnapshot();
    vi.setSystemTime(NOW + 24 * HOUR);
    const tomorrow = internals.buildSnapshot();
    const fromScratch = fresh();
    expect(tomorrow.days.map((d) => d.day)).toEqual(fromScratch.days.map((d) => d.day));
    expect(tomorrow).toEqual(fromScratch);
  });
});
