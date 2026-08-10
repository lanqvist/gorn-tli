import { listLogFiles } from './locate.js';
import { analyzeLogFile } from './pipeline.js';
import { PriceStore } from './priceStore.js';
import { TradeLedger } from './trade.js';
import type { ConfigBaseId, Run } from './types.js';

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
  slots: Array<[string, { configBaseId: number; qty: number }]>;
}

export interface RetroScanProgress {
  file: string;
  index: number;
  total: number;
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

  // Цены складываем в один store: они общие для сезона.
  const prices = new PriceStore(null);

  const failed: Array<{ path: string; reason: string }> = [];

  for (const [index, file] of files.entries()) {
    onProgress?.({ file: file.path, index, total: files.length });

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

    for (const listing of result.trade.listings) trade.listings.push(listing);
    for (const receipt of result.trade.receipts) trade.receipts.push(receipt);
    for (const purchase of result.trade.purchases) trade.purchases.push(purchase);

    for (const [proto, n] of result.diagnostics.unknownProtos) {
      unknownProtos.set(proto, (unknownProtos.get(proto) ?? 0) + n);
    }
  }

  void seasonId;

  // Забеги из разных файлов могут перекрываться, если игра упала и лог
  // ротировался посреди карты. Сортируем и убираем дубли по времени старта.
  runs.sort((a, b) => a.startedAt - b.startedAt);
  const deduped: Run[] = [];
  for (const run of runs) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.startedAt === run.startedAt && prev.areaId === run.areaId) continue;
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
