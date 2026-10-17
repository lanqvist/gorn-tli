import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Storage } from '../src/storage/db.js';
import type { Run } from '../src/core/types.js';

/**
 * Сохранённое должно читаться обратно. Логи игра ротирует и удаляет,
 * поэтому база — единственный источник истории старше пары часов.
 * Пока чтения не было, хранилище не выполняло свою единственную задачу.
 */
describe('история переживает исчезновение логов', () => {
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

  const run: Run = {
    areaId: 5348,
    asset: 'YL_MaNeiLaYuLin100',
    levelType: 3,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_084_000,
    durationMs: 84_000,
    isHub: false,
    // Настоящий id: больше 2^53, обязан пережить базу без потери разрядов.
    playerId: '956082728577617920',
    seasonId: 1601,
    drops: [
      {
        ts: 1_700_000_010_000,
        configBaseId: 100300,
        qty: 44,
        proto: 'PickItem',
        kind: 'loot',
        pageId: 102,
        slotId: 0,
      },
    ],
    costs: [
      {
        ts: 1_700_000_001_000,
        configBaseId: 10022,
        qty: 1,
        proto: 'Spv3Open',
        kind: 'mapCost',
        pageId: 100,
        slotId: 3,
      },
    ],
  };

  it('забег читается обратно вместе с дропом и расходом', () => {
    db.saveRuns([run], 1501);
    const loaded = db.loadRuns();

    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.areaId).toBe(5348);
    expect(loaded[0]!.asset).toBe('YL_MaNeiLaYuLin100');
    expect(loaded[0]!.durationMs).toBe(84_000);
    expect(loaded[0]!.isHub).toBe(false);
    expect(loaded[0]!.drops).toHaveLength(1);
    expect(loaded[0]!.drops[0]!.configBaseId).toBe(100300);
    expect(loaded[0]!.drops[0]!.qty).toBe(44);
    expect(loaded[0]!.costs[0]!.configBaseId).toBe(10022);
    // Строка, не number: в double id теряет младшие разряды.
    expect(loaded[0]!.playerId).toBe('956082728577617920');
  });

  it('профиль персонажа читается обратно, пустые поля не затирают известные', () => {
    db.savePlayers([
      {
        playerId: '956082728577617920',
        name: 'VLPZDC#3648',
        heroId: 1700,
        level: 84,
        seasonId: 1501,
        lastSeenAt: 2000,
      },
    ]);
    // Событие входа без профиля: только id и время.
    db.savePlayers([
      {
        playerId: '956082728577617920',
        name: null,
        heroId: null,
        level: null,
        seasonId: null,
        lastSeenAt: 3000,
      },
    ]);

    const players = db.loadPlayers();
    expect(players).toHaveLength(1);
    expect(players[0]!.playerId).toBe('956082728577617920');
    expect(players[0]!.name).toBe('VLPZDC#3648');
    expect(players[0]!.heroId).toBe(1700);
    expect(players[0]!.level).toBe(84);
    expect(players[0]!.lastSeenAt).toBe(3000);
  });

  it('лоты и выплаты читаются обратно', () => {
    db.saveTrade([{ ts: 5, configBaseId: 10042, qty: 3 }], [{ ts: 9, fe: 82 }]);
    const trade = db.loadTrade();

    expect(trade.listings).toEqual([{ ts: 5, configBaseId: 10042, qty: 3 }]);
    expect(trade.receipts).toEqual([{ ts: 9, fe: 82 }]);
  });

  it('цена читается самая свежая по каждому предмету', () => {
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
      {
        configBaseId: 200028,
        fe: 6.4,
        median: 6.5,
        min: 6,
        sampleSize: 80,
        observedAt: 1500,
        seasonId: 1501,
      },
    ]);

    const prices = db.loadPrices().sort((a, b) => a.configBaseId - b.configBaseId);
    expect(prices).toHaveLength(2);
    expect(prices[0]!.fe).toBe(9);
    expect(prices[1]!.fe).toBe(6.4);
  });
});
