import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventParser } from '../src/core/eventParser.js';
import { PriceStore } from '../src/core/priceStore.js';
import { RunSegmenter } from '../src/core/runSegmenter.js';
import { seasonName, seasonShort } from '../src/core/seasons.js';
import { FE_ID, type PriceObservationEvent, type Run } from '../src/core/types.js';
import { Storage } from '../src/storage/db.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

const SS13 = 1501;
const SS14 = 1601;
const DAY = 86_400_000;
const SEASON_START = Date.UTC(2026, 9, 16, 9, 0);

function run(startedAt: number, seasonId: number | null, playerId: string | null = null): Run {
  return {
    areaId: 5348,
    asset: 'YL_MaNeiLaYuLin100',
    levelType: 3,
    startedAt,
    endedAt: startedAt + 84_000,
    durationMs: 84_000,
    isHub: false,
    playerId,
    seasonId,
    drops: [
      {
        ts: startedAt + 1000,
        configBaseId: FE_ID,
        qty: 10,
        proto: 'PickItem',
        kind: 'loot',
        pageId: 102,
        slotId: 0,
      },
    ],
    costs: [],
  };
}

function seasonsOf(db: Storage): Array<number | null> {
  return db.loadRuns().map((r) => r.seasonId);
}

describe('названия сезонов', () => {
  it('известные сезоны — по имени, будущие — хотя бы по номеру', () => {
    expect(seasonName(1601)).toBe('SS14 Tartarus');
    expect(seasonName(1501)).toBe('SS13 Afterlight');
    expect(seasonName(1701)).toBe('SS15');
    expect(seasonName(null)).toBeNull();
    expect(seasonShort(1601)).toBe('SS14');
  });
});

describe('сезон у каждого забега свой', () => {
  it('забег получает сезон из профиля персонажа', () => {
    const seg = new RunSegmenter();
    seg.setPlayer('979862815672193024');
    seg.setSeason(SS14);
    seg.enterLevel({ kind: 'enterLevel', ts: SEASON_START, line: 1, areaId: 5348 });
    expect(seg.finish(SEASON_START + 60_000)[0]!.seasonId).toBe(SS14);
  });

  it('профиль GetPlayerData несёт сезон SS14', () => {
    const parser = new EventParser();
    const events = [
      '[2026.10.17-07.47.10:000][  1]TLNetGame: Display: [Game] ----Socket RecvMessage STT----GetPlayerData----SynId = 8',
      '+player+SeasonId [1601]',
      '|      +PlayerId [979862815672193024]',
      '|      +HeroId [1300]',
      '|      +Level [95]',
      '|      +Name [VLPZDC#3664]',
      '[2026.10.17-07.47.10:001][  1]TLNetGame: Display: [Game] ----Socket RecvMessage End----',
    ]
      .map((l) => parser.parse(l))
      .filter(Boolean);
    expect(events[0]).toMatchObject({ kind: 'playerInfo', seasonId: SS14, heroId: 1300 });
  });
});

describe('база помнит сезон забега и цены', () => {
  let dir: string;
  let db: Storage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gorn-seasons-'));
    db = new Storage(join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('пересканирование логов прошлого сезона не переносит забеги в текущий', () => {
    db.saveRuns([run(SEASON_START - DAY, SS13)], SS13);
    // Первый запуск в новом сезоне: старый лог ещё на диске, сезон «по
    // последнему файлу» — SS14. Раньше он затирал сезон всех забегов пачки.
    db.saveRuns([run(SEASON_START - DAY, SS13), run(SEASON_START + DAY, SS14)], SS14);
    expect(seasonsOf(db)).toEqual([SS13, SS14]);
  });

  it('забег без профиля в логе получает сезон файла, но не затирает известный', () => {
    db.saveRuns([run(SEASON_START, null)], SS14);
    expect(seasonsOf(db)).toEqual([SS14]);
    db.saveRuns([run(SEASON_START, SS13)], SS14);
    db.saveRuns([run(SEASON_START, null)], SS14);
    expect(seasonsOf(db)).toEqual([SS13]);
  });

  it('цены отдаются только своего сезона, и тренд — тоже', () => {
    const observe = (store: PriceStore, ts: number, price: number, season: number) => {
      const ev: PriceObservationEvent = {
        kind: 'priceObservation',
        ts,
        line: 1,
        configBaseId: 5028,
        currency: FE_ID,
        unitPrices: [price],
        synId: 1,
      };
      return store.observe(ev, season)!;
    };
    const store = new PriceStore(null);
    db.savePrices([
      observe(store, SEASON_START - DAY, 0.9, SS13),
      observe(store, SEASON_START + DAY, 0.07, SS14),
    ]);

    expect(db.loadPrices(SS14).map((p) => p.fe)).toEqual([0.07]);
    expect(db.loadPrices(SS13).map((p) => p.fe)).toEqual([0.9]);
    // Сезон неизвестен — как раньше: свежая по предмету.
    expect(db.loadPrices(null).map((p) => p.fe)).toEqual([0.07]);
    expect(db.priceHistory(5028, 60, SS14)).toEqual([{ t: SEASON_START + DAY, fe: 0.07 }]);
  });
});

describe('миграция базы прежних версий', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gorn-migrate-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('пробивкам без сезона сезон ставится по забегам, забегам — по персонажу', () => {
    const path = join(dir, 'gorn.db');
    // База, записанная прежней версией: цены с сезоном 0, у части забегов
    // сезон неизвестен, но известен персонаж.
    const first = new Storage(path);
    first.saveRuns([run(SEASON_START - 10 * DAY, SS13)], null);
    first.saveRuns([run(SEASON_START + DAY, null, '979862815672193024')], null);
    first.savePlayers([
      {
        playerId: '979862815672193024',
        name: 'VLPZDC#3664',
        heroId: 1300,
        level: 95,
        seasonId: SS14,
        lastSeenAt: SEASON_START + DAY,
      },
    ]);
    first.close();

    const raw = new DatabaseSync(path);
    const insert = raw.prepare(
      `INSERT INTO price (config_base_id, season_id, fe, median, min_price, sample_size, observed_at)
       VALUES (?, 0, ?, ?, ?, 1, ?)`,
    );
    insert.run(5028, 0.9, 0.9, 0.9, SEASON_START - 9 * DAY); // после забега SS13
    insert.run(5028, 0.07, 0.07, 0.07, SEASON_START + 2 * DAY); // после забега SS14
    insert.run(10330, 5, 5, 5, SEASON_START - 20 * DAY); // раньше всех забегов
    raw.close();

    const db = new Storage(path);
    try {
      expect(seasonsOf(db)).toEqual([SS13, SS14]);
      expect(db.loadPrices(SS14).map((p) => [p.configBaseId, p.fe])).toEqual([[5028, 0.07]]);
      expect(db.loadPrices(SS13).map((p) => [p.configBaseId, p.fe])).toEqual([[5028, 0.9]]);
    } finally {
      db.close();
    }
  });
});
