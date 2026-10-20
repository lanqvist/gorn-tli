import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { activeDuration } from '../src/core/analysis.js';
import { PriceStore } from '../src/core/priceStore.js';
import type { RetroScanResult } from '../src/core/retroScan.js';
import type { SegmenterState } from '../src/core/runSegmenter.js';
import { perHour } from '../src/core/stats.js';
import { TradeLedger } from '../src/core/trade.js';
import { FE_ID, type ItemDelta, type Run } from '../src/core/types.js';

/**
 * Движок целиком, без игры и без сети: разбор логов, дочитывание и лента
 * сообщества подменены. Проверяются сбои старта, продолжение нарезки
 * после запуска, «в час» и отзывы лотов через перезапуск.
 */

const SS14 = 1601;
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 20, 9, 0, 0);
const MAP = 'YL_MaNeiLaYuLin100';
const ITEM = 5000;

const scan = vi.hoisted(() => ({ result: null as unknown, error: null as Error | null }));
const locate = vi.hoisted(() => ({ dir: null as string | null }));

vi.mock('electron', () => ({ net: {}, protocol: {} }));
vi.mock('../src/main/tailer.js', () => ({
  LogTailer: class {
    start(): void {}
    stop(): void {}
  },
}));
vi.mock('../src/core/retroScan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/retroScan.js')>()),
  retroScan: async () => {
    if (scan.error) throw scan.error;
    return scan.result;
  },
}));
vi.mock('../src/core/locate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/locate.js')>()),
  findLogDirectory: () => locate.dir,
}));
vi.mock('../src/main/communityPrices.js', () => ({
  CommunityPriceFeed: class {
    onUpdate(): void {}
    start(): void {}
    loadOnce(): void {}
    stop(): void {}
    get size(): number {
      return 0;
    }
    get fetchedAtMs(): number | null {
      return null;
    }
    get stale(): boolean {
      return false;
    }
    all() {
      return [];
    }
    priceOf() {
      return null;
    }
  },
}));

const { Engine } = await import('../src/main/engine.js');
type Snapshot = import('../src/main/engine.js').Snapshot;
type EngineInternals = {
  buildSnapshot(): Snapshot;
  consume(lines: string[]): void;
  trade: TradeLedger;
};

function drop(ts: number, qty: number, configBaseId = FE_ID): ItemDelta {
  return { ts, configBaseId, qty, proto: 'PickItem', kind: 'loot', pageId: 102, slotId: 0 };
}

function run(startedAt: number, durationMs: number, drops: ItemDelta[]): Run {
  return {
    areaId: 5348,
    asset: MAP,
    levelType: 3,
    startedAt,
    endedAt: startedAt + durationMs,
    durationMs,
    isHub: false,
    playerId: 'p1',
    seasonId: SS14,
    drops,
    costs: [],
  };
}

function scanResult(over: Partial<RetroScanResult> = {}): RetroScanResult {
  return {
    runs: [],
    prices: new PriceStore(),
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
    ...over,
  };
}

function line(ts: number, text: string): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}-` +
    `${p(d.getUTCHours())}.${p(d.getUTCMinutes())}.${p(d.getUTCSeconds())}:${p(d.getUTCMilliseconds(), 3)}`;
  return `[${stamp}][  1]TLLua: Display: [Game] ${text}`;
}

function enter(ts: number, asset: string, areaId: number): string[] {
  return [
    line(ts, `LevelMgr@:LevelPath, Model = Content/Art/Maps/X/${asset}/${asset}.umap World'/Game/X'`),
    line(ts, `LevelMgr:_EnterLevelSuccess() ${areaId}`),
  ];
}

let dir: string;
let engines: Array<InstanceType<typeof Engine>> = [];
let last: Snapshot | null = null;

function makeEngine(): InstanceType<typeof Engine> {
  const engine = new Engine(dir, [{ id: ITEM, name: 'Item', icon: null }]);
  engine.on('snapshot', (s: Snapshot) => (last = s));
  engines.push(engine);
  return engine;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  dir = mkdtempSync(join(tmpdir(), 'gorn-engine-integrity-'));
  scan.result = scanResult();
  scan.error = null;
  locate.dir = null;
  last = null;
});

afterEach(() => {
  for (const e of engines) e.stop();
  engines = [];
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('сбой старта', () => {
  it('ошибка разбора снимает флаг запуска и показывает «ищу игру» с причиной', async () => {
    const engine = makeEngine();
    scan.error = Object.assign(new Error("ENOENT: no such file or directory, scandir 'X:\\Logs'"), {
      code: 'ENOENT',
    });
    await expect(engine.start(dir)).rejects.toThrow('ENOENT');
    expect(engine.isBooted).toBe(false);
    expect(last?.status).toBe('searching');
    expect(last?.hint).toContain('ENOENT');

    // Автоповтор поиска запускает движок, когда папка снова на месте.
    scan.error = null;
    await engine.start(dir);
    expect(engine.isBooted).toBe(true);
  });

  it('исчезнувшая вручную заданная папка — откат на автопоиск', async () => {
    locate.dir = dir;
    const engine = makeEngine();
    await engine.start(join(dir, 'нет-такой-папки'));
    expect(engine.isBooted).toBe(true);
    expect(engine.logDirectory).toBe(dir);
  });
});

describe('продолжение нарезки после запуска', () => {
  it('открытый забег из разбора продолжается живым дочитыванием', async () => {
    const open: Run = { ...run(NOW - 5 * MIN, 0, [drop(NOW - 4 * MIN, 100)]), endedAt: null, durationMs: null };
    const state: SegmenterState = {
      current: open,
      resumable: [],
      pendingCosts: [],
      pendingAsset: null,
      pendingLevelType: null,
      playerId: 'p1',
      seasonId: SS14,
    };
    scan.result = scanResult({ segmenter: state });
    const engine = makeEngine();
    await engine.start(dir);
    const internals = engine as unknown as EngineInternals;

    expect(internals.buildSnapshot().current?.feGained).toBe(100);

    // Выход в город закрывает тот же забег — со всей добычей.
    internals.consume(enter(NOW, 'XZ_YuJinZhiXiBiNanSuo200', 110));
    const snap = internals.buildSnapshot();
    expect(snap.recent).toHaveLength(1);
    expect(snap.recent[0]!.startedAt).toBe(NOW - 5 * MIN);
    expect(snap.recent[0]!.feGained).toBe(100);
  });

  it('возврат порталом в карту из разбора не считает её добычу дважды', async () => {
    // Карта закрыта разбором (ушли в город), её копия — и в истории,
    // и в окне возврата у живой нарезки.
    const closed = run(NOW - 5 * MIN, 2 * MIN, [drop(NOW - 4 * MIN, 100)]);
    const state: SegmenterState = {
      current: null,
      resumable: [{ ...closed, drops: [...closed.drops] }],
      pendingCosts: [],
      pendingAsset: null,
      pendingLevelType: null,
      playerId: 'p1',
      seasonId: SS14,
    };
    scan.result = scanResult({ runs: [closed], segmenter: state });
    const engine = makeEngine();
    await engine.start(dir);
    const internals = engine as unknown as EngineInternals;

    internals.consume(enter(NOW - MIN, MAP, 5348));
    const reopened = internals.buildSnapshot();
    // Карта снова открыта: её добыча — в текущем забеге, не ещё раз в истории.
    expect(reopened.current?.startedAt).toBe(NOW - 5 * MIN);
    expect(reopened.recent).toHaveLength(0);
    expect(reopened.totals.feGained).toBe(100);

    internals.consume(enter(NOW, 'XZ_YuJinZhiXiBiNanSuo200', 110));
    const after = internals.buildSnapshot();
    expect(after.recent).toHaveLength(1);
    expect(after.totals.feGained).toBe(100);
  });
});

describe('«в час»', () => {
  it('у забега с простоем совпадает с нормой и считается по активному времени', async () => {
    // Двадцать минут в карте, из них пятнадцать — перекур без единого подбора.
    const runs = [0, 1, 2].map((i) => {
      const t = NOW - (3 - i) * HOUR;
      return run(t, 20 * MIN, [drop(t + MIN, 30), drop(t + 2 * MIN, 30), drop(t + 19 * MIN, 30)]);
    });
    scan.result = scanResult({ runs });
    const engine = makeEngine();
    await engine.start(dir);
    const snap = (engine as unknown as EngineInternals).buildSnapshot();

    const view = snap.recent[0]!;
    const active = activeDuration(runs[2]!);
    expect(active).toBeLessThan(20 * MIN);
    expect(view.activeMs).toBe(active);
    expect(view.durationMs).toBe(20 * MIN);
    expect(view.perHour).toBeCloseTo(perHour(90, active));
    expect(view.perHour).toBeCloseTo(snap.norm);
  });
});

describe('отзыв лота через перезапуск', () => {
  function tradeWith(listings: TradeLedger['listings'], recalls: TradeLedger['recalls']): TradeLedger {
    const t = new TradeLedger();
    t.listings.push(...listings);
    t.recalls.push(...recalls);
    return t;
  }

  it('отозванный лот не воскресает, частично отозванный не задваивается', async () => {
    const listings = [
      { ts: NOW - 50 * MIN, configBaseId: ITEM, qty: 4 },
      { ts: NOW - 40 * MIN, configBaseId: ITEM + 1, qty: 10 },
    ];
    const recalls = [
      { ts: NOW - 30 * MIN, configBaseId: ITEM, qty: 4 },
      { ts: NOW - 20 * MIN, configBaseId: ITEM + 1, qty: 3 },
    ];
    scan.result = scanResult({ trade: tradeWith(listings, recalls) });
    const first = makeEngine();
    await first.start(dir);
    const expected = [{ ts: NOW - 40 * MIN, configBaseId: ITEM + 1, qty: 7 }];
    expect((first as unknown as EngineInternals).trade.activeListings()).toEqual(expected);
    first.stop();

    // Перезапуск: лог тот же — разбор даёт те же события.
    scan.result = scanResult({ trade: tradeWith(listings, recalls) });
    const second = makeEngine();
    await second.start(dir);
    expect((second as unknown as EngineInternals).trade.activeListings()).toEqual(expected);
    second.stop();

    // Лог удалён игрой: всё знание — из базы.
    scan.result = scanResult();
    const third = makeEngine();
    await third.start(dir);
    expect((third as unknown as EngineInternals).trade.activeListings()).toEqual(expected);
  });

  it('отзыв, пойманный живым дочитыванием, тоже доходит до базы', async () => {
    const listings = [{ ts: NOW - 50 * MIN, configBaseId: ITEM, qty: 4 }];
    scan.result = scanResult({ trade: tradeWith(listings, []) });
    const first = makeEngine();
    await first.start(dir);
    (first as unknown as EngineInternals).trade.add({
      ts: NOW - 10 * MIN,
      configBaseId: ITEM,
      qty: 4,
      proto: 'XchgRecall',
      kind: 'trade',
      pageId: 102,
      slotId: 0,
    });
    first.stop();

    scan.result = scanResult();
    const second = makeEngine();
    await second.start(dir);
    expect((second as unknown as EngineInternals).trade.activeListings()).toEqual([]);
  });
});
