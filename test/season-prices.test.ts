import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PriceStore } from '../src/core/priceStore.js';
import type { RetroScanResult } from '../src/core/retroScan.js';
import { TradeLedger } from '../src/core/trade.js';
import { FE_ID, type ItemDelta, type Run } from '../src/core/types.js';

/**
 * Движок целиком, без игры и без сети: разбор логов, дочитывание
 * и лента сообщества подменены. Проверяется, что забег прошлого сезона
 * в «Все сезоны» оценивается ценами своего сезона.
 */

const ITEM = 5000;
const RARE = 5001;
const SS13 = 1501;
const SS14 = 1601;
const HOUR = 3_600_000;

const scan = vi.hoisted(() => ({ result: null as unknown }));
const feeds = vi.hoisted(() => ({
  /** Цены сообщества по сезонам. */
  prices: new Map<number, Map<number, number>>(),
  /** Какие сезоны запрашивались разово — лента прошлого сезона. */
  loadedOnce: [] as number[],
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
    private season: number | null = null;
    onUpdate(): void {}
    start(season: number): void {
      this.season = season;
    }
    loadOnce(season: number): void {
      this.season = season;
      feeds.loadedOnce.push(season);
    }
    stop(): void {}
    get size(): number {
      return this.table().size;
    }
    get fetchedAtMs(): number | null {
      return null;
    }
    get stale(): boolean {
      return false;
    }
    all() {
      return [...this.table()].map(([configBaseId, fe]) => this.row(configBaseId, fe));
    }
    priceOf(id: number) {
      const fe = this.table().get(id);
      return fe === undefined ? null : this.row(id, fe);
    }
    private table(): Map<number, number> {
      return (this.season !== null && feeds.prices.get(this.season)) || new Map();
    }
    private row(configBaseId: number, fe: number) {
      return { configBaseId, fe, p10: fe, submissions: 1, devices: 1, updatedAt: new Date(0).toISOString() };
    }
  },
}));

const { Engine } = await import('../src/main/engine.js');
type Snapshot = import('../src/main/engine.js').Snapshot;

function drop(configBaseId: number, qty: number, ts: number): ItemDelta {
  return { ts, configBaseId, qty, proto: 'PickItem', kind: 'loot', pageId: 100, slotId: 0 };
}

function farmRun(startedAt: number, seasonId: number, playerId: string, drops: ItemDelta[]): Run {
  return {
    areaId: 5348,
    asset: 'YL_MaNeiLaYuLin100',
    levelType: 3,
    startedAt,
    endedAt: startedAt + 600_000,
    durationMs: 600_000,
    isHub: false,
    playerId,
    seasonId,
    drops,
    costs: [],
  };
}

function observe(prices: PriceStore, id: number, fe: number, ts: number, season: number): void {
  prices.observe(
    { kind: 'priceObservation', ts, line: 0, configBaseId: id, currency: FE_ID, unitPrices: [fe], synId: 1 },
    season,
  );
}

let dir: string;
let engine: InstanceType<typeof Engine>;
let last: Snapshot | null;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gorn-season-prices-'));
  feeds.loadedOnce = [];
  // Сообщество: в SS13 редкий предмет стоил 3 ФЕ, в SS14 — 100.
  feeds.prices = new Map([
    [SS13, new Map([[RARE, 3]])],
    [SS14, new Map([[RARE, 100]])],
  ]);

  const now = Date.now();
  const ss13Start = now - 60 * 24 * HOUR;
  const ss14Start = now - 2 * HOUR;
  // Свои пробивки: предмет 2 ФЕ в SS13 и 5 ФЕ в SS14.
  const prices = new PriceStore();
  observe(prices, ITEM, 2, ss13Start - HOUR, SS13);
  observe(prices, ITEM, 5, now - HOUR, SS14);

  scan.result = {
    runs: [
      farmRun(ss13Start, SS13, 'p13', [drop(ITEM, 10, ss13Start + 1000), drop(RARE, 1, ss13Start + 2000)]),
      farmRun(ss14Start, SS14, 'p14', [drop(ITEM, 10, ss14Start + 1000)]),
    ],
    prices,
    trade: new TradeLedger(),
    filesScanned: 1,
    linesScanned: 0,
    seasonIds: new Set([SS13, SS14]),
    elapsedMs: 0,
    unknownProtos: new Map(),
    failed: [],
    slots: [],
    latestSeasonId: SS14,
    players: [
      { playerId: 'p13', name: null, heroId: null, level: 90, seasonId: SS13, lastSeenAt: ss13Start },
      { playerId: 'p14', name: null, heroId: null, level: 60, seasonId: SS14, lastSeenAt: ss14Start },
    ],
    lastPlayerId: 'p14',
    currentLog: null,
    segmenter: null,
  } satisfies RetroScanResult;

  engine = new Engine(dir, [
    { id: ITEM, name: 'Item', icon: null },
    { id: RARE, name: 'Rare', icon: null },
  ]);
  last = null;
  engine.on('snapshot', (s: Snapshot) => (last = s));
  await engine.start(dir);
});

afterEach(() => {
  engine.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('цены сезона забега', () => {
  it('текущий сезон — по текущим ценам, прошлый не запрашивается', () => {
    expect(last!.recent.map((r) => r.valueFe)).toEqual([50]);
    expect(feeds.loadedOnce).toEqual([]);
  });

  it('«Все сезоны»: забег SS13 — по своим пробивкам и сообществу SS13', () => {
    engine.setRunScope({ playerId: null, allSeasons: true });
    const [ss14, ss13] = last!.recent;
    expect(ss14!.valueFe).toBe(50);
    expect(ss13!.valueFe).toBe(10 * 2 + 3);
    expect(ss13!.drops.find((d) => d.configBaseId === RARE)).toMatchObject({
      unitFe: 3,
      priceSource: 'community',
    });
    expect(ss13!.drops.find((d) => d.configBaseId === ITEM)).toMatchObject({
      unitFe: 2,
      priceSource: 'own',
    });
    // Лента прошлого сезона поднята один раз, при первом показе.
    expect(feeds.loadedOnce).toEqual([SS13]);

    const [strategy] = last!.strategies;
    expect(strategy!.netPerRun).toBe((50 + 23) / 2);
    expect(last!.rate.sampleSize).toBe(2);
  });

  it('персонаж прошлого сезона — по ценам его сезона, «Пробить цену» молчит', () => {
    engine.setRunScope({ playerId: 'p13', allSeasons: false });
    expect(last!.recent.map((r) => r.valueFe)).toEqual([23]);
    expect(last!.missing).toEqual([]);
  });

  it('поиск и CSV оценивают забеги так же, как срез', () => {
    engine.setRunScope({ playerId: null, allSeasons: true });
    expect(engine.queryRuns('').netFe).toBe(50 + 23);
    const csv = engine.exportRunsCsv();
    expect(csv).toContain('23');
  });
});
