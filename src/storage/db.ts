import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

import type { PriceRecord } from '../core/priceStore.js';
import type { Listing, Receipt } from '../core/trade.js';
import type { ConfigBaseId, Run } from '../core/types.js';

export type { Listing, Receipt };

/**
 * Хранилище разобранной истории.
 *
 * Зачем оно нужно именно здесь: игра ротирует логи и удаляет старые бэкапы.
 * За один день у тестовой машины исчезли два файла. Всё, что не сохранено,
 * теряется навсегда, поэтому ретро-скан обязан складывать результат к себе.
 *
 * Используется встроенный в Node модуль node:sqlite — без нативных
 * зависимостей и без шага сборки.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id    INTEGER,
  area_id      INTEGER NOT NULL,
  asset        TEXT,
  level_type   INTEGER,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  duration_ms  INTEGER,
  is_hub       INTEGER NOT NULL,
  UNIQUE (started_at, area_id)
);

CREATE TABLE IF NOT EXISTS drop_item (
  run_id          INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  config_base_id  INTEGER NOT NULL,
  qty             INTEGER NOT NULL,
  proto           TEXT NOT NULL,
  ts              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drop_run ON drop_item(run_id);

CREATE TABLE IF NOT EXISTS cost_item (
  run_id          INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  config_base_id  INTEGER NOT NULL,
  qty             INTEGER NOT NULL,
  ts              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_run ON cost_item(run_id);

CREATE TABLE IF NOT EXISTS price (
  config_base_id  INTEGER NOT NULL,
  season_id       INTEGER,
  fe              REAL NOT NULL,
  median          REAL NOT NULL,
  min_price       REAL NOT NULL,
  sample_size     INTEGER NOT NULL,
  observed_at     INTEGER NOT NULL,
  PRIMARY KEY (config_base_id, season_id, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_price_item ON price(config_base_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS listing (
  ts              INTEGER NOT NULL,
  config_base_id  INTEGER NOT NULL,
  qty             INTEGER NOT NULL,
  UNIQUE (ts, config_base_id, qty)
);

CREATE TABLE IF NOT EXISTS receipt (
  ts  INTEGER NOT NULL,
  fe  INTEGER NOT NULL,
  UNIQUE (ts, fe)
);

-- Позиция чтения каждого файла лога, чтобы не разбирать заново.
CREATE TABLE IF NOT EXISTS log_cursor (
  path        TEXT PRIMARY KEY,
  position    INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
`;

/**
 * node:sqlite грузим через createRequire: сборщики (Vite под vitest) не знают
 * про этот встроенный модуль, срезают префикс `node:` и пытаются искать
 * пакет `sqlite` в node_modules. Динамическая загрузка обходит их анализ.
 */
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

export class Storage {
  private db: DatabaseSyncType;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  /**
   * Сохраняет забеги. Повторный скан того же лога не создаёт дублей:
   * забег опознаётся по времени старта и зоне.
   */
  saveRuns(runs: Run[], seasonId: number | null): number {
    const insertRun = this.db.prepare(`
      INSERT OR IGNORE INTO run
        (season_id, area_id, asset, level_type, started_at, ended_at, duration_ms, is_hub)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const findRun = this.db.prepare(
      'SELECT id FROM run WHERE started_at = ? AND area_id = ?',
    );
    const insertDrop = this.db.prepare(`
      INSERT INTO drop_item (run_id, config_base_id, qty, proto, ts) VALUES (?, ?, ?, ?, ?)
    `);
    const insertCost = this.db.prepare(`
      INSERT INTO cost_item (run_id, config_base_id, qty, ts) VALUES (?, ?, ?, ?)
    `);
    const clearDrops = this.db.prepare('DELETE FROM drop_item WHERE run_id = ?');
    const clearCosts = this.db.prepare('DELETE FROM cost_item WHERE run_id = ?');

    let saved = 0;
    this.db.exec('BEGIN');
    try {
      for (const run of runs) {
        insertRun.run(
          seasonId,
          run.areaId,
          run.asset,
          run.levelType,
          run.startedAt,
          run.endedAt,
          run.durationMs,
          run.isHub ? 1 : 0,
        );
        const row = findRun.get(run.startedAt, run.areaId) as { id: number } | undefined;
        if (!row) continue;

        // Перезаписываем состав: повторный разбор мог стать точнее.
        clearDrops.run(row.id);
        clearCosts.run(row.id);
        for (const d of run.drops) {
          insertDrop.run(row.id, d.configBaseId, d.qty, d.proto, d.ts);
        }
        for (const c of run.costs) {
          insertCost.run(row.id, c.configBaseId, c.qty, c.ts);
        }
        saved++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return saved;
  }

  savePrices(records: PriceRecord[]): number {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO price
        (config_base_id, season_id, fe, median, min_price, sample_size, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.exec('BEGIN');
    try {
      for (const r of records) {
        stmt.run(r.configBaseId, r.seasonId, r.fe, r.median, r.min, r.sampleSize, r.observedAt);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return records.length;
  }

  saveTrade(listings: Listing[], receipts: Receipt[]): void {
    const insertListing = this.db.prepare(
      'INSERT OR IGNORE INTO listing (ts, config_base_id, qty) VALUES (?, ?, ?)',
    );
    const insertReceipt = this.db.prepare(
      'INSERT OR IGNORE INTO receipt (ts, fe) VALUES (?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      for (const l of listings) insertListing.run(l.ts, l.configBaseId, l.qty);
      for (const r of receipts) insertReceipt.run(r.ts, r.fe);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Забеги из базы вместе с составом дропа и расхода.
   *
   * Без этого сохранённая история никому не нужна: логи ротируются, старые
   * файлы игра удаляет, и на экране остаётся только то, что уцелело в файлах.
   */
  loadRuns(): Run[] {
    const rows = this.db
      .prepare(
        `SELECT id, area_id, asset, level_type, started_at, ended_at, duration_ms, is_hub
         FROM run ORDER BY started_at`,
      )
      .all() as Array<{
      id: number;
      area_id: number;
      asset: string | null;
      level_type: number | null;
      started_at: number;
      ended_at: number | null;
      duration_ms: number | null;
      is_hub: number;
    }>;

    const dropStmt = this.db.prepare(
      'SELECT config_base_id, qty, proto, ts FROM drop_item WHERE run_id = ?',
    );
    const costStmt = this.db.prepare(
      'SELECT config_base_id, qty, ts FROM cost_item WHERE run_id = ?',
    );

    return rows.map((row) => ({
      areaId: row.area_id,
      asset: row.asset,
      levelType: row.level_type,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMs: row.duration_ms,
      isHub: row.is_hub === 1,
      drops: (
        dropStmt.all(row.id) as Array<{
          config_base_id: number;
          qty: number;
          proto: string;
          ts: number;
        }>
      ).map((d) => ({
        ts: d.ts,
        configBaseId: d.config_base_id,
        qty: d.qty,
        proto: d.proto,
        kind: 'loot' as const,
        pageId: 0,
        slotId: 0,
      })),
      costs: (
        costStmt.all(row.id) as Array<{ config_base_id: number; qty: number; ts: number }>
      ).map((c) => ({
        ts: c.ts,
        configBaseId: c.config_base_id,
        qty: c.qty,
        proto: 'Spv3Open',
        kind: 'mapCost' as const,
        pageId: 0,
        slotId: 0,
      })),
    }));
  }

  loadTrade(): { listings: Listing[]; receipts: Receipt[] } {
    const listings = (
      this.db.prepare('SELECT ts, config_base_id, qty FROM listing').all() as Array<{
        ts: number;
        config_base_id: number;
        qty: number;
      }>
    ).map((r) => ({ ts: r.ts, configBaseId: r.config_base_id, qty: r.qty }));

    const receipts = (
      this.db.prepare('SELECT ts, fe FROM receipt').all() as Array<{ ts: number; fe: number }>
    ).map((r) => ({ ts: r.ts, fe: r.fe }));

    return { listings, receipts };
  }

  /** Сохранённые цены — чтобы не терять их вместе с логами. */
  loadPrices(): PriceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT config_base_id, season_id, fe, median, min_price, sample_size, observed_at
         FROM price p
         WHERE observed_at = (
           SELECT MAX(observed_at) FROM price WHERE config_base_id = p.config_base_id
         )`,
      )
      .all() as Array<{
      config_base_id: number;
      season_id: number | null;
      fe: number;
      median: number;
      min_price: number;
      sample_size: number;
      observed_at: number;
    }>;

    return rows.map((r) => ({
      configBaseId: r.config_base_id,
      fe: r.fe,
      median: r.median,
      min: r.min_price,
      sampleSize: r.sample_size,
      observedAt: r.observed_at,
      seasonId: r.season_id,
    }));
  }

  /** Последняя известная цена предмета. */
  latestPrice(configBaseId: ConfigBaseId): number | null {
    const row = this.db
      .prepare('SELECT fe FROM price WHERE config_base_id = ? ORDER BY observed_at DESC LIMIT 1')
      .get(configBaseId) as { fe: number } | undefined;
    return row?.fe ?? null;
  }

  counts(): Record<string, number> {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      runs: one('SELECT COUNT(*) AS n FROM run'),
      farmingRuns: one('SELECT COUNT(*) AS n FROM run WHERE is_hub = 0'),
      drops: one('SELECT COUNT(*) AS n FROM drop_item'),
      prices: one('SELECT COUNT(DISTINCT config_base_id) AS n FROM price'),
      listings: one('SELECT COUNT(*) AS n FROM listing'),
      receipts: one('SELECT COUNT(*) AS n FROM receipt'),
    };
  }

  /** Реально полученные ФЕ за всю сохранённую историю. */
  realizedFe(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(fe), 0) AS n FROM receipt').get() as {
      n: number;
    };
    return row.n;
  }

  setCursor(path: string, position: number, size: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO log_cursor (path, position, size, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(path, position, size, Date.now());
  }

  getCursor(path: string): { position: number; size: number } | null {
    const row = this.db
      .prepare('SELECT position, size FROM log_cursor WHERE path = ?')
      .get(path) as { position: number; size: number } | undefined;
    return row ?? null;
  }

  close(): void {
    this.db.close();
  }
}
