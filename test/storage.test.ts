import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Storage } from '../src/storage/db.js';
import type { Run } from '../src/core/types.js';

function run(startedAt: number, areaId: number, drops: Array<[number, number]> = []): Run {
  return {
    areaId,
    asset: 'YL_MaNeiLaYuLin100',
    levelType: 3,
    startedAt,
    endedAt: startedAt + 84_000,
    durationMs: 84_000,
    isHub: false,
    drops: drops.map(([configBaseId, qty]) => ({
      ts: startedAt + 1000,
      configBaseId,
      qty,
      proto: 'PickItem',
      kind: 'loot' as const,
      pageId: 102,
      slotId: 0,
    })),
    costs: [],
  };
}

describe('хранилище', () => {
  let dir: string;
  let db: Storage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gorn-'));
    db = new Storage(join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('повторный скан того же лога не создаёт дублей', () => {
    // Ретро-скан запускается при каждом старте, а логи перекрываются.
    const runs = [run(1000, 5348, [[100300, 44]]), run(2000, 5351)];

    db.saveRuns(runs, 1501);
    db.saveRuns(runs, 1501);
    db.saveRuns(runs, 1501);

    expect(db.counts().runs).toBe(2);
    // Состав дропа тоже не должен размножиться.
    expect(db.counts().drops).toBe(1);
  });

  it('повторный разбор уточняет состав забега, а не добавляет к нему', () => {
    db.saveRuns([run(1000, 5348, [[100300, 44]])], 1501);
    db.saveRuns([run(1000, 5348, [[100300, 44], [100200, 234]])], 1501);
    expect(db.counts().drops).toBe(2);
  });

  it('выплаты и лоты не дублируются', () => {
    const listings = [{ ts: 1, configBaseId: 10042, qty: 3 }];
    const receipts = [
      { ts: 10, fe: 18 },
      { ts: 11, fe: 25 },
    ];
    db.saveTrade(listings, receipts);
    db.saveTrade(listings, receipts);

    expect(db.counts().listings).toBe(1);
    expect(db.counts().receipts).toBe(2);
    expect(db.realizedFe()).toBe(43);
  });

  it('две одинаковые выплаты в одну миллисекунду сохраняются обе', () => {
    // Выкуп двух одинаковых лотов — две выплаты. UNIQUE(ts, fe) их терял.
    db.saveTrade([], [
      { ts: 10, fe: 30 },
      { ts: 10, fe: 30 },
    ]);
    db.saveTrade([], [
      { ts: 10, fe: 30 },
      { ts: 10, fe: 30 },
    ]);
    expect(db.counts().receipts).toBe(2);
    expect(db.realizedFe()).toBe(60);
  });

  it('усечённая копия забега не затирает полную', () => {
    // Копия из оборванного при ротации файла короче настоящей.
    const full = run(1000, 5348, [[100300, 44], [100200, 10]]);
    db.saveRuns([full], 1501);

    const truncated = { ...run(1000, 5348, [[100300, 20]]), durationMs: 30_000, endedAt: 31_000 };
    db.saveRuns([truncated], 1501);

    expect(db.counts().drops).toBe(2);
    const loaded = db.loadRuns().find((r) => r.startedAt === 1000)!;
    expect(loaded.durationMs).toBe(84_000);
  });

  it('цены с неизвестным сезоном не плодят дублей при повторном сохранении', () => {
    // season_id участвует в первичном ключе, а NULL != NULL в SQLite:
    // раньше каждый запуск добавлял полный дубль всех цен.
    const record = {
      configBaseId: 10042,
      fe: 5,
      median: 6,
      min: 4,
      sampleSize: 100,
      observedAt: 1000,
      seasonId: null,
    };
    db.savePrices([record]);
    db.savePrices([record]);
    db.savePrices([record]);
    expect(db.counts().priceRows).toBe(1);
    expect(db.latestPrice(10042)).toBe(5);
  });

  it('история цен хранит наблюдения, а последняя цена берётся по времени', () => {
    db.savePrices([
      {
        configBaseId: 10042,
        fe: 5,
        median: 6,
        min: 4,
        sampleSize: 100,
        observedAt: 1000,
        seasonId: 1501,
      },
      {
        configBaseId: 10042,
        fe: 9,
        median: 10,
        min: 8,
        sampleSize: 100,
        observedAt: 2000,
        seasonId: 1501,
      },
    ]);
    expect(db.latestPrice(10042)).toBe(9);
    expect(db.counts().prices).toBe(1);
  });

  it('позиция чтения лога переживает перезапуск', () => {
    db.setCursor('C:/logs/UE_game.log', 12_345, 99_999);
    expect(db.getCursor('C:/logs/UE_game.log')).toEqual({ position: 12_345, size: 99_999 });
    expect(db.getCursor('C:/logs/other.log')).toBeNull();
  });
});
