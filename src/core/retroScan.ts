import { statSync } from 'node:fs';

import type { SlotState } from './inventory.js';
import { listLogFiles } from './locate.js';
import { analyzeLogFile } from './pipeline.js';
import { PriceStore } from './priceStore.js';
import { TradeLedger, mergeByKey } from './trade.js';
import type { ConfigBaseId, PlayerProfile, Run } from './types.js';

/**
 * Разбор всех накопленных логов при первом запуске.
 *
 * Ни TITrack, ни Fenix, ни StanTheIV этого не делают — они начинают с нуля
 * и просят игрока «пофармить часок», чтобы появились цифры. У TraXile (PoE)
 * ретро-скан считается главной фичей, и это оправданно: логи уже лежат на диске.
 *
 * Каждый файл — отдельная сессия игры, поэтому состояние сумки между файлами
 * не переносится: после перезахода игра присылает InitBagData и базы слотов
 * устанавливаются заново.
 */

export interface RetroScanResult {
  runs: Run[];
  prices: PriceStore;
  trade: TradeLedger;
  filesScanned: number;
  linesScanned: number;
  seasonIds: Set<number>;
  elapsedMs: number;
  /** Незнакомые протоколы по всем файлам — для самодиагностики. */
  unknownProtos: Map<string, number>;
  /** Файлы, которые не удалось прочитать (обычно ротация во время скана). */
  failed: Array<{ path: string; reason: string }>;
  /**
   * Состояние слотов сумки после последнего файла.
   * Передаётся живому дочитыванию, иначе расход на первую же карту
   * после запуска трекера уходит на установку базы и теряется.
   */
  slots: Array<[string, SlotState]>;
  /** Сезон последнего файла — текущий. Первый в seasonIds — самый старый. */
  latestSeasonId: number | null;
  /** Все персонажи из всех файлов: у каждого — самое свежее известное состояние. */
  players: PlayerProfile[];
  /**
   * Кем зашли в последнем файле. Живое дочитывание стартует с этим
   * персонажем, иначе забеги до следующего перезахода остались бы ничьими.
   */
  lastPlayerId: string | null;
  /**
   * Размер текущего лога сразу после его разбора. Живое дочитывание
   * начинает с этой позиции, а не с конца файла на момент своего старта:
   * иначе строки, записанные игрой между сканом и стартом дочитывания,
   * не достаются никому.
   */
  currentLog: { path: string; position: number } | null;
}

export interface RetroScanProgress {
  file: string;
  index: number;
  total: number;
  /** Забегов найдено к началу этого файла — живая цифра для заглушки. */
  runsFound: number;
}

export async function retroScan(
  logDir: string,
  onProgress?: (p: RetroScanProgress) => void,
): Promise<RetroScanResult> {
  const started = Date.now();
  const files = listLogFiles(logDir);

  const runs: Run[] = [];
  const trade = new TradeLedger();
  let slots: RetroScanResult['slots'] = [];
  const unknownProtos = new Map<string, number>();
  const seasonIds = new Set<number>();
  let linesScanned = 0;
  let seasonId: number | null = null;
  let currentLog: RetroScanResult['currentLog'] = null;
  const players = new Map<string, PlayerProfile>();
  let lastPlayerId: string | null = null;

  // Файлы могут перекрываться после ротации при краше, поэтому торговые
  // события каждого файла копятся отдельно и сливаются с дедупликацией.
  const listingsByFile: Array<TradeLedger['listings']> = [];
  const receiptsByFile: Array<TradeLedger['receipts']> = [];
  const purchasesByFile: Array<TradeLedger['purchases']> = [];

  // Цены складываем в один store: они общие для сезона.
  const prices = new PriceStore(null);

  const failed: Array<{ path: string; reason: string }> = [];

  for (const [index, file] of files.entries()) {
    onProgress?.({ file: file.path, index, total: files.length, runsFound: runs.length });

    // Игра может ротировать или переписать файл прямо во время чтения.
    // Один недочитанный файл не должен ронять разбор остальных.
    let result: Awaited<ReturnType<typeof analyzeLogFile>>;
    try {
      result = await analyzeLogFile(file.path);
    } catch (err) {
      failed.push({ path: file.path, reason: (err as Error).message });
      continue;
    }

    runs.push(...result.runs);
    // Состояние сумки берём от последнего файла: он и есть текущая сессия.
    slots = result.slots;
    linesScanned += result.diagnostics.linesTotal;
    if (result.seasonId !== null) {
      seasonIds.add(result.seasonId);
      seasonId = result.seasonId;
    }

    for (const observation of result.prices) prices.observe(observation);

    listingsByFile.push(result.trade.listings);
    receiptsByFile.push(result.trade.receipts);
    purchasesByFile.push(result.trade.purchases);

    for (const [proto, n] of result.diagnostics.unknownProtos) {
      unknownProtos.set(proto, (unknownProtos.get(proto) ?? 0) + n);
    }

    // Файлы идут от старых к новым: свежие значения побеждают, но пустые
    // не затирают известные — в оборванном логе бывает вход без профиля.
    for (const profile of result.players) {
      const known = players.get(profile.playerId);
      players.set(profile.playerId, {
        playerId: profile.playerId,
        name: profile.name ?? known?.name ?? null,
        heroId: profile.heroId ?? known?.heroId ?? null,
        level: profile.level ?? known?.level ?? null,
        seasonId: profile.seasonId ?? known?.seasonId ?? null,
        lastSeenAt: Math.max(profile.lastSeenAt, known?.lastSeenAt ?? 0),
      });
    }
    if (result.lastPlayerId !== null) lastPlayerId = result.lastPlayerId;

    if (file.isCurrent) {
      // Размер файла на момент окончания разбора: с него продолжит tailer.
      try {
        currentLog = { path: file.path, position: statSync(file.path).size };
      } catch {
        currentLog = { path: file.path, position: file.size };
      }
    }
  }

  trade.listings.push(...mergeByKey(listingsByFile, (l) => `${l.ts}:${l.configBaseId}:${l.qty}`));
  trade.receipts.push(...mergeByKey(receiptsByFile, (r) => `${r.ts}:${r.fe}`));
  trade.purchases.push(
    ...mergeByKey(purchasesByFile, (p) => `${p.ts}:${p.configBaseId}:${p.qty}`),
  );

  // Забеги из разных файлов могут перекрываться, если игра упала и лог
  // ротировался посреди карты. Сортируем и убираем дубли по времени старта;
  // из двух копий одного забега остаётся более полная, а не первая
  // попавшаяся: копия из оборванного файла может быть усечённой.
  runs.sort((a, b) => a.startedAt - b.startedAt);
  const deduped: Run[] = [];
  for (const run of runs) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.startedAt === run.startedAt && prev.areaId === run.areaId) {
      const prevScore = (prev.durationMs ?? 0) + prev.drops.length + prev.costs.length;
      const runScore = (run.durationMs ?? 0) + run.drops.length + run.costs.length;
      if (runScore > prevScore) deduped[deduped.length - 1] = run;
      continue;
    }
    deduped.push(run);
  }

  return {
    runs: deduped,
    prices,
    trade,
    filesScanned: files.length,
    linesScanned,
    seasonIds,
    elapsedMs: Date.now() - started,
    unknownProtos,
    failed,
    slots,
    latestSeasonId: seasonId,
    players: [...players.values()],
    lastPlayerId,
    currentLog,
  };
}

/** Суммарная бумажная оценка дропа забега. */
export function runValue(run: Run, priceOf: (id: ConfigBaseId) => number | null): number {
  let total = 0;
  for (const drop of run.drops) {
    const price = priceOf(drop.configBaseId);
    if (price !== null) total += price * drop.qty;
  }
  return total;
}

/** Суммарная стоимость вложенного в карту. */
export function runCost(run: Run, priceOf: (id: ConfigBaseId) => number | null): number {
  let total = 0;
  for (const cost of run.costs) {
    const price = priceOf(cost.configBaseId);
    if (price !== null) total += price * cost.qty;
  }
  return total;
}
