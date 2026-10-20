import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

import type { PriceRecord } from '../core/priceStore.js';
import type { Listing, Recall, Receipt } from '../core/trade.js';
import type { ConfigBaseId, PlayerProfile, Run } from '../core/types.js';

export type { Listing, Recall, Receipt };

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
  -- Персонаж хранится СТРОКОЙ: id вида 956082728577617920 не помещается
  -- в double, а INTEGER-колонку node:sqlite отдал бы как number.
  player_id    TEXT,
  UNIQUE (started_at, area_id)
);

-- Известные персонажи: ник аккаунта, класс и уровень для показа в интерфейсе.
CREATE TABLE IF NOT EXISTS player (
  player_id    TEXT PRIMARY KEY,
  name         TEXT,
  hero_id      INTEGER,
  level        INTEGER,
  season_id    INTEGER,
  last_seen_at INTEGER NOT NULL
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

-- season_id участвует в первичном ключе, а в SQLite NULL != NULL,
-- поэтому NULL здесь запрещён: неизвестный сезон записывается нулём.
-- Иначе INSERT OR REPLACE никогда не срабатывал и каждый запуск
-- добавлял полный дубль всех цен.
CREATE TABLE IF NOT EXISTS price (
  config_base_id  INTEGER NOT NULL,
  season_id       INTEGER NOT NULL DEFAULT 0,
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

-- Отзывы лотов — событиями, как в логе: действующие лоты получаются
-- вычитанием при загрузке (applyRecalls). seq — как у выплат.
CREATE TABLE IF NOT EXISTS listing_recall (
  ts              INTEGER NOT NULL,
  config_base_id  INTEGER NOT NULL,
  qty             INTEGER NOT NULL,
  seq             INTEGER NOT NULL DEFAULT 0,
  UNIQUE (ts, config_base_id, qty, seq)
);

-- seq различает одинаковые выплаты в одну миллисекунду: выкуп двух
-- одинаковых лотов — это две выплаты, а не одна.
CREATE TABLE IF NOT EXISTS receipt (
  ts   INTEGER NOT NULL,
  fe   INTEGER NOT NULL,
  seq  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (ts, fe, seq)
);

-- Сессии игрока: граница отсчёта для счётчиков на экране. Забеги при
-- сбросе не трогаются — сессия лишь помнит, С КАКОГО момента считать.
-- Активная сессия — единственная с ended_at IS NULL.
CREATE TABLE IF NOT EXISTS session (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);
`;

/**
 * Миграции баз, созданных прошлыми версиями. Номер выполненной лежит
 * в PRAGMA user_version, каждая выполняется один раз, в своей транзакции.
 *
 * До появления номера (user_version = 0) миграции гонялись на каждом
 * запуске, поэтому каждая проверяет схему сама и на уже приведённой базе
 * ничего не делает: так версия старой базы определяется по её схеме,
 * а новая база, созданная SCHEMA, проходит их вхолостую.
 *
 * Добавлять — только в конец: номер миграции — её место в списке.
 */
const MIGRATIONS: Array<(db: DatabaseSyncType) => void> = [
  // 1. Цены: season_id был NULL, а NULL в SQLite не равен NULL, поэтому
  //    «PRIMARY KEY» не дедуплицировал и каждый запуск плодил дубли.
  //    Убираем дубли (GROUP BY считает NULL-ы равными) и переводим
  //    неизвестный сезон в 0.
  (db) => {
    db.exec(`
      DELETE FROM price WHERE rowid NOT IN (
        SELECT MAX(rowid) FROM price
        GROUP BY config_base_id, season_id, observed_at
      )`);
    db.exec('UPDATE price SET season_id = 0 WHERE season_id IS NULL');
  },

  // 2. Забеги: добавилась колонка player_id. Старым забегам персонаж
  //    неизвестен — они остаются NULL и показываются только в режиме
  //    «все персонажи»; ретро-скан уцелевших логов проставит их заново.
  (db) => {
    if (!hasColumn(db, 'run', 'player_id')) {
      db.exec('ALTER TABLE run ADD COLUMN player_id TEXT');
    }
  },

  // 3. Выплаты: добавилась колонка seq. UNIQUE-ограничение старой таблицы
  //    снять нельзя, поэтому таблица пересоздаётся.
  (db) => {
    if (hasColumn(db, 'receipt', 'seq')) return;
    db.exec(`
      CREATE TABLE receipt_migrated (
        ts   INTEGER NOT NULL,
        fe   INTEGER NOT NULL,
        seq  INTEGER NOT NULL DEFAULT 0,
        UNIQUE (ts, fe, seq)
      );
      INSERT INTO receipt_migrated (ts, fe, seq) SELECT ts, fe, 0 FROM receipt;
      DROP TABLE receipt;
      ALTER TABLE receipt_migrated RENAME TO receipt;
    `);
  },

  // 4. Позиции чтения логов (log_cursor) так и не понадобились: хвост
  //    читается от конца файла, история — ретро-сканом.
  (db) => {
    db.exec('DROP TABLE IF EXISTS log_cursor');
  },
];

function hasColumn(db: DatabaseSyncType, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

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
    this.migrate();
  }

  /** Приведение баз, созданных прошлыми версиями, к текущей схеме. */
  private migrate(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        MIGRATIONS[v]!(this.db);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
    this.repairSeasons();
  }

  /**
   * Досведение сезонов — не миграция, а ремонт данных: на каждом запуске.
   * Строки без сезона пишет и нынешний код — ретро-скан файла без строки
   * профиля, забег до первой строки с сезоном, — и чинятся они, когда
   * сезон становится известен по соседним данным. Без подходящих строк
   * оба запроса ничего не меняют.
   */
  private repairSeasons(): void {
    // Сезон забега: если в файле не было профиля, сезон NULL. Персонаж
    // живёт ровно в одном сезоне — сезон берём у него. Только для NULL:
    // уже проставленный сезон не трогаем.
    this.db.exec(`
      UPDATE run SET season_id = (
        SELECT p.season_id FROM player p WHERE p.player_id = run.player_id
      )
      WHERE season_id IS NULL AND player_id IS NOT NULL`);

    // Свои пробивки без сезона (0): иначе цена прошлого сезона тихо
    // подставлялась бы в новом. Сезон пробивки — сезон последнего забега,
    // начатого до неё; пробивки старше всех забегов остаются 0 и в оценку
    // текущего сезона не попадают.
    //
    // OR IGNORE, а не OR REPLACE: при конфликте REPLACE молча удалял уже
    // лежащую строку с сезоном. Конфликт значит, что та же пробивка
    // (предмет, время) уже записана с сезоном, — удаляем явно бессезонный
    // двойник, а строка с сезоном остаётся.
    this.db.exec('BEGIN');
    try {
      this.db.exec(`
        UPDATE OR IGNORE price SET season_id = (
          SELECT r.season_id FROM run r
          WHERE r.season_id IS NOT NULL AND r.started_at <= price.observed_at
          ORDER BY r.started_at DESC LIMIT 1
        )
        WHERE season_id = 0 AND EXISTS (
          SELECT 1 FROM run r
          WHERE r.season_id IS NOT NULL AND r.started_at <= price.observed_at
        )`);
      this.db.exec(`
        DELETE FROM price WHERE season_id = 0 AND EXISTS (
          SELECT 1 FROM price p
          WHERE p.config_base_id = price.config_base_id
            AND p.observed_at = price.observed_at
            AND p.season_id <> 0
        )`);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    // 6. Половины карт, записанные отдельным забегом рядом с целой картой.
    this.dropNestedRuns();

    // 7. Частично отозванный лот прошлые версии уменьшали на месте, и
    //    повторный разбор лога дописывал его второй строкой с меньшим
    //    количеством. Одно выставление — одна строка лога: из строк
    //    с тем же временем и предметом настоящая — с наибольшим количеством.
    this.db.exec(`
      DELETE FROM listing WHERE EXISTS (
        SELECT 1 FROM listing o
        WHERE o.ts = listing.ts AND o.config_base_id = listing.config_base_id
          AND o.qty > listing.qty
      )`);
  }

  /**
   * Удаляет забеги, целиком лежащие внутри другого забега той же зоны
   * (см. mergeRuns): прошлые версии писали вторую половину карты после
   * захода через портал отдельно, а повторный разбор — карту целиком.
   * Состав удаляется каскадом.
   */
  private dropNestedRuns(): void {
    this.db.exec(`
      DELETE FROM run WHERE id IN (
        SELECT id FROM (
          SELECT id, ended_at,
                 MAX(ended_at) OVER (
                   PARTITION BY area_id ORDER BY started_at
                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                 ) AS reach
          FROM run WHERE is_hub = 0 AND ended_at IS NOT NULL
        ) WHERE reach IS NOT NULL AND ended_at <= reach
      )`);
  }

  /**
   * Сохраняет забеги. Повторный скан того же лога не создаёт дублей:
   * забег опознаётся по времени старта и зоне.
   *
   * Сезон — собственный у забега; `fallbackSeasonId` нужен только забегам
   * без профиля в логе. Раньше сезон передавался один на всю пачку,
   * и пересканирование логов прошлого сезона переписывало их в текущий.
   */
  saveRuns(runs: Run[], fallbackSeasonId: number | null): number {
    const insertRun = this.db.prepare(`
      INSERT OR IGNORE INTO run
        (season_id, area_id, asset, level_type, started_at, ended_at, duration_ms, is_hub,
         player_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const findRun = this.db.prepare(
      'SELECT id, duration_ms, ended_at FROM run WHERE started_at = ? AND area_id = ?',
    );
    const updateRun = this.db.prepare(`
      UPDATE run SET
        season_id  = COALESCE(?, season_id, ?),
        asset      = COALESCE(?, asset),
        level_type = COALESCE(?, level_type),
        ended_at   = ?,
        duration_ms = ?,
        player_id  = COALESCE(?, player_id)
      WHERE id = ?
    `);
    const insertDrop = this.db.prepare(`
      INSERT INTO drop_item (run_id, config_base_id, qty, proto, ts) VALUES (?, ?, ?, ?, ?)
    `);
    const insertCost = this.db.prepare(`
      INSERT INTO cost_item (run_id, config_base_id, qty, ts) VALUES (?, ?, ?, ?)
    `);
    const clearDrops = this.db.prepare('DELETE FROM drop_item WHERE run_id = ?');
    const clearCosts = this.db.prepare('DELETE FROM cost_item WHERE run_id = ?');

    // Начало следующего забега той же пачки: сохранённая копия, которая
    // заходит за него, — склейка нескольких заходов, а не полная версия.
    const starts = [...new Set(runs.map((r) => r.startedAt))].sort((a, b) => a - b);
    const nextStart = (ts: number): number | undefined => starts.find((t) => t > ts);

    let saved = 0;
    this.db.exec('BEGIN');
    try {
      for (const run of runs) {
        insertRun.run(
          run.seasonId ?? fallbackSeasonId,
          run.areaId,
          run.asset,
          run.levelType,
          run.startedAt,
          run.endedAt,
          run.durationMs,
          run.isHub ? 1 : 0,
          run.playerId,
        );
        const row = findRun.get(run.startedAt, run.areaId) as
          | { id: number; duration_ms: number | null; ended_at: number | null }
          | undefined;
        if (!row) continue;

        // Запись обновляется только более полной версией забега: копия
        // из оборванного при ротации файла короче настоящей, и затирать
        // ею полную нельзя. Раньше состав дропа перезаписывался всегда,
        // а строка забега — никогда, и после усечённого первого сохранения
        // полный дроп навсегда делился на усечённую длительность.
        //
        // Но длиннее не всегда полнее: прежние версии склеивали подряд идущие
        // заходы в сезонную тюрьму SS14 в один забег. Такая копия перекрывает
        // следующий забег пачки — её свежий разбор заменяет, иначе добыча
        // отдельных заходов считалась бы дважды.
        const next = nextStart(run.startedAt);
        const merged = next !== undefined && row.ended_at !== null && row.ended_at > next;
        const better =
          merged || row.duration_ms === null || (run.durationMs ?? 0) >= row.duration_ms;
        if (!better) continue;

        updateRun.run(
          run.seasonId,
          fallbackSeasonId,
          run.asset,
          run.levelType,
          run.endedAt,
          run.durationMs,
          run.playerId,
          row.id,
        );

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
    // Целая карта пришла после своей половины, записанной раньше отдельно.
    if (saved > 0) this.dropNestedRuns();
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
        // Неизвестный сезон пишется нулём: NULL сломал бы дедупликацию
        // по первичному ключу (NULL != NULL в SQLite).
        stmt.run(
          r.configBaseId,
          r.seasonId ?? 0,
          r.fe,
          r.median,
          r.min,
          r.sampleSize,
          r.observedAt,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return records.length;
  }

  saveTrade(listings: Listing[], receipts: Receipt[], recalls: Recall[] = []): void {
    const insertListing = this.db.prepare(
      'INSERT OR IGNORE INTO listing (ts, config_base_id, qty) VALUES (?, ?, ?)',
    );
    const insertReceipt = this.db.prepare(
      'INSERT OR IGNORE INTO receipt (ts, fe, seq) VALUES (?, ?, ?)',
    );
    const insertRecall = this.db.prepare(
      'INSERT OR IGNORE INTO listing_recall (ts, config_base_id, qty, seq) VALUES (?, ?, ?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      for (const l of listings) insertListing.run(l.ts, l.configBaseId, l.qty);
      // Одинаковые выплаты в одну миллисекунду различаются порядковым
      // номером — иначе выкуп двух одинаковых лотов схлопывался в один.
      const seq = new Map<string, number>();
      for (const r of receipts) {
        const key = `${r.ts}:${r.fe}`;
        const n = seq.get(key) ?? 0;
        seq.set(key, n + 1);
        insertReceipt.run(r.ts, r.fe, n);
      }
      const recallSeq = new Map<string, number>();
      for (const r of recalls) {
        const key = `${r.ts}:${r.configBaseId}:${r.qty}`;
        const n = recallSeq.get(key) ?? 0;
        recallSeq.set(key, n + 1);
        insertRecall.run(r.ts, r.configBaseId, r.qty, n);
      }
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
        `SELECT id, area_id, asset, level_type, started_at, ended_at, duration_ms, is_hub,
                player_id, season_id
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
      player_id: string | null;
      season_id: number | null;
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
      playerId: row.player_id,
      seasonId: row.season_id,
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

  /**
   * Профили персонажей. Свежие значения побеждают, но пустые не затирают
   * известные: событие входа несёт только id, без имени и уровня.
   */
  savePlayers(profiles: PlayerProfile[]): void {
    if (profiles.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO player (player_id, name, hero_id, level, season_id, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(player_id) DO UPDATE SET
        name         = COALESCE(excluded.name, name),
        hero_id      = COALESCE(excluded.hero_id, hero_id),
        level        = COALESCE(excluded.level, level),
        season_id    = COALESCE(excluded.season_id, season_id),
        last_seen_at = MAX(excluded.last_seen_at, last_seen_at)
    `);
    this.db.exec('BEGIN');
    try {
      for (const p of profiles) {
        stmt.run(p.playerId, p.name, p.heroId, p.level, p.seasonId, p.lastSeenAt);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  loadPlayers(): PlayerProfile[] {
    const rows = this.db
      .prepare(
        `SELECT player_id, name, hero_id, level, season_id, last_seen_at
         FROM player ORDER BY last_seen_at DESC`,
      )
      .all() as Array<{
      player_id: string;
      name: string | null;
      hero_id: number | null;
      level: number | null;
      season_id: number | null;
      last_seen_at: number;
    }>;
    return rows.map((r) => ({
      playerId: r.player_id,
      name: r.name,
      heroId: r.hero_id,
      level: r.level,
      seasonId: r.season_id,
      lastSeenAt: r.last_seen_at,
    }));
  }

  loadTrade(): { listings: Listing[]; receipts: Receipt[]; recalls: Recall[] } {
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

    const recalls = (
      this.db.prepare('SELECT ts, config_base_id, qty FROM listing_recall').all() as Array<{
        ts: number;
        config_base_id: number;
        qty: number;
      }>
    ).map((r) => ({ ts: r.ts, configBaseId: r.config_base_id, qty: r.qty }));

    return { listings, receipts, recalls };
  }

  /**
   * Сохранённые цены — чтобы не терять их вместе с логами. Только своего
   * сезона: экономика каждый сезон начинается заново, и цена прошлого
   * сезона хуже, чем никакой. null — сезон неизвестен, отдаются все.
   */
  loadPrices(seasonId: number | null = null): PriceRecord[] {
    const scope = seasonId === null ? '' : 'AND season_id = :season';
    const rows = this.db
      .prepare(
        `SELECT config_base_id, season_id, fe, median, min_price, sample_size, observed_at
         FROM price p
         WHERE observed_at = (
           SELECT MAX(observed_at) FROM price
           WHERE config_base_id = p.config_base_id ${scope}
         ) ${scope}`,
      )
      .all(seasonId === null ? {} : { season: seasonId }) as Array<{
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

  /**
   * Последние `limit` своих пробивок предмета, по времени. Окно берётся
   * от свежей пробивки, а не от сегодняшнего дня: после перерыва в игре
   * история иначе выглядела бы пустой.
   */
  priceHistory(
    configBaseId: ConfigBaseId,
    limit = 60,
    seasonId: number | null = null,
  ): Array<{ t: number; fe: number }> {
    // Тренд — внутри сезона: старт новой экономики выглядел бы обвалом цены.
    const scope = seasonId === null ? '' : 'AND season_id = :season';
    return (
      this.db
        .prepare(
          `SELECT observed_at AS t, fe FROM price
           WHERE config_base_id = :id ${scope} ORDER BY observed_at DESC LIMIT :limit`,
        )
        .all({ id: configBaseId, limit, ...(seasonId === null ? {} : { season: seasonId }) }) as Array<{
        t: number;
        fe: number;
      }>
    )
      .map((r) => ({ t: r.t, fe: r.fe }))
      .reverse();
  }

  counts(): Record<string, number> {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      runs: one('SELECT COUNT(*) AS n FROM run'),
      farmingRuns: one('SELECT COUNT(*) AS n FROM run WHERE is_hub = 0'),
      drops: one('SELECT COUNT(*) AS n FROM drop_item'),
      prices: one('SELECT COUNT(DISTINCT config_base_id) AS n FROM price'),
      priceRows: one('SELECT COUNT(*) AS n FROM price'),
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

  /**
   * Начало активной сессии. Если сессий ещё нет, создаётся первая
   * со start = 0: до первого сброса счётчики охватывают всю историю,
   * то есть ведут себя ровно как до появления фичи.
   */
  activeSessionStart(): number {
    const row = this.db
      .prepare('SELECT started_at FROM session WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1')
      .get() as { started_at: number } | undefined;
    if (row) return row.started_at;
    this.db.prepare('INSERT INTO session (started_at, ended_at) VALUES (0, NULL)').run();
    return 0;
  }

  /**
   * Сброс: активная сессия закрывается, открывается новая с этого момента.
   * Данные забегов не трогаются — меняется только граница отсчёта.
   */
  resetSession(now: number): number {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE session SET ended_at = ? WHERE ended_at IS NULL').run(now);
      this.db.prepare('INSERT INTO session (started_at, ended_at) VALUES (?, NULL)').run(now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return now;
  }

  /** Все сессии в порядке создания. Активная — с endedAt = null. */
  listSessions(): Array<{ startedAt: number; endedAt: number | null }> {
    const rows = this.db
      .prepare('SELECT started_at, ended_at FROM session ORDER BY id')
      .all() as Array<{ started_at: number; ended_at: number | null }>;
    return rows.map((r) => ({ startedAt: r.started_at, endedAt: r.ended_at }));
  }

  /** Границы последней закрытой сессии — для строки «прошлая сессия». */
  previousSession(): { startedAt: number; endedAt: number } | null {
    const row = this.db
      .prepare(
        `SELECT started_at, ended_at FROM session
         WHERE ended_at IS NOT NULL ORDER BY ended_at DESC, id DESC LIMIT 1`,
      )
      .get() as { started_at: number; ended_at: number } | undefined;
    return row ? { startedAt: row.started_at, endedAt: row.ended_at } : null;
  }

  close(): void {
    this.db.close();
  }
}
