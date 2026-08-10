import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import { EventParser } from '../core/eventParser.js';
import { InventoryTracker } from '../core/inventory.js';
import { findLogDirectory, listLogFiles } from '../core/locate.js';
import { PriceStore } from '../core/priceStore.js';
import { retroScan } from '../core/retroScan.js';
import { runCost, runValue } from '../core/retroScan.js';
import { RunSegmenter } from '../core/runSegmenter.js';
import { perHour, summarize, type RateSummary } from '../core/stats.js';
import { TradeLedger } from '../core/trade.js';
import { FE_ID, type ConfigBaseId, type Diagnostics, type Run } from '../core/types.js';
import { Storage } from '../storage/db.js';
import { LogTailer } from './tailer.js';

export interface DropView {
  configBaseId: ConfigBaseId;
  name: string;
  icon: string | null;
  qty: number;
  unitFe: number | null;
  totalFe: number | null;
}

export interface RunView {
  areaId: number;
  name: string;
  startedAt: number;
  durationMs: number | null;
  feGained: number;
  valueFe: number;
  costFe: number;
  netFe: number;
  perHour: number;
  drops: DropView[];
}

export interface Snapshot {
  status: 'searching' | 'idle' | 'running';
  /** Пояснение статуса для игрока: почему ничего не происходит. */
  hint: string | null;
  seasonId: number | null;
  current: RunView | null;
  recent: RunView[];
  /** Медиана и разброс по чистой добыче в час. */
  rate: RateSummary;
  feRate: RateSummary;
  totals: {
    runs: number;
    inMapMs: number;
    feGained: number;
    valueFe: number;
    costFe: number;
    realizedFe: number;
    realizationRatio: number | null;
  };
  diagnostics: {
    unknownProtos: Array<[string, number]>;
    pricedItems: number;
    unpricedDrops: number;
  };
}

interface ItemInfo {
  name: string;
  icon: string | null;
}

/**
 * Ядро приложения в main-процессе: держит состояние, дочитывает лог
 * и отдаёт в интерфейс готовые срезы, а не сырые строки.
 *
 * ETor гонял сырой лог в renderer тысячами сообщений и городил
 * WebSocket-мост с подтверждением батчей, чтобы тот не захлёбывался.
 * Разбор в main снимает эту проблему целиком.
 */
export class Engine extends EventEmitter {
  private storage: Storage;
  private prices = new PriceStore();
  private items = new Map<ConfigBaseId, ItemInfo>();
  private diagnostics: Diagnostics = {
    linesTotal: 0,
    linesMatched: 0,
    unknownProtos: new Map(),
    unknownItemIds: new Map(),
    slotRebases: 0,
  };

  private parser = new EventParser();
  private inventory = new InventoryTracker(this.diagnostics);
  private segmenter = new RunSegmenter();
  private trade = new TradeLedger();

  private tailer: LogTailer | null = null;
  private logDir: string | null = null;
  private seasonId: number | null = null;
  private history: Run[] = [];
  private lastActivityAt = 0;

  constructor(dataDir: string, items: Array<{ id: number; name: string; icon: string | null }>) {
    super();
    this.storage = new Storage(join(dataDir, 'gorn.db'));
    for (const it of items) this.items.set(it.id, { name: it.name, icon: it.icon });
    this.prices.registerKnownItems(this.items.keys());
  }

  /** Полный старт: разбор накопленных логов, затем слежение за текущим. */
  async start(): Promise<void> {
    this.logDir = findLogDirectory();
    if (!this.logDir) {
      this.emit('snapshot', this.snapshot('searching', 'Не нашёл установленную игру'));
      return;
    }

    const scan = await retroScan(this.logDir);
    this.history = scan.runs;
    this.seasonId = [...scan.seasonIds][0] ?? null;
    for (const record of scan.prices.all()) {
      this.prices.set(record.configBaseId, record.fe, record.observedAt);
    }
    for (const l of scan.trade.listings) this.trade.listings.push(l);
    for (const r of scan.trade.receipts) this.trade.receipts.push(r);
    for (const [proto, n] of scan.unknownProtos) {
      this.diagnostics.unknownProtos.set(proto, n);
    }

    this.storage.saveRuns(scan.runs, this.seasonId);
    this.storage.savePrices(scan.prices.all());
    this.storage.saveTrade(scan.trade.listings, scan.trade.receipts);

    this.startTailing();
    this.emit('snapshot', this.buildSnapshot());
  }

  private startTailing(): void {
    if (!this.logDir) return;
    const files = listLogFiles(this.logDir);
    const current = files.find((f) => f.isCurrent) ?? files[files.length - 1];
    if (!current) return;

    this.tailer = new LogTailer(current.path, {
      onLines: (lines) => this.consume(lines),
      onRotate: () => {
        // Новая сессия игры: состояние сумки и забегов начинается заново.
        this.parser = new EventParser();
        this.inventory = new InventoryTracker(this.diagnostics);
        this.segmenter = new RunSegmenter();
        this.emit('snapshot', this.buildSnapshot());
      },
      onError: (err) => this.emit('error', err),
    });
    this.tailer.start();
  }

  private consume(lines: string[]): void {
    let changed = false;

    for (const raw of lines) {
      this.diagnostics.linesTotal++;
      if (this.seasonId === null) {
        const m = /\+SeasonId \[(\d+)\]/.exec(raw);
        if (m) this.seasonId = Number(m[1]);
      }

      const ev = this.parser.parse(raw);
      if (!ev) continue;
      this.diagnostics.linesMatched++;
      changed = true;
      this.lastActivityAt = Date.now();

      switch (ev.kind) {
        case 'itemChange':
          if (ev.phase === 'start') this.inventory.beginTransaction(ev.proto);
          else this.inventory.endTransaction();
          break;
        case 'bagInit':
          this.inventory.applyInit(ev);
          break;
        case 'bagRemove': {
          const delta = this.inventory.applyRemove(ev);
          if (delta) {
            this.segmenter.addDelta(delta);
            this.trade.add(delta);
          }
          break;
        }
        case 'bagModify': {
          const delta = this.inventory.applyModify(ev);
          if (delta) {
            this.segmenter.addDelta(delta);
            this.trade.add(delta);
          }
          break;
        }
        case 'levelPath':
          this.segmenter.noteAsset(ev.asset);
          break;
        case 'levelIds':
          this.segmenter.noteLevelType(ev.levelType);
          break;
        case 'enterLevel':
          this.segmenter.enterLevel(ev);
          this.persistFinished();
          break;
        case 'priceObservation': {
          const record = this.prices.observe(ev);
          if (record) this.storage.savePrices([record]);
          break;
        }
        default:
          break;
      }
    }

    if (changed) this.emit('snapshot', this.buildSnapshot());
  }

  /** Закрытые забеги сразу уходят в базу: лог может ротироваться в любой момент. */
  private persistFinished(): void {
    const all = this.segmenter.all;
    const finished = all.filter((r) => r.endedAt !== null);
    if (finished.length === 0) return;
    this.storage.saveRuns(finished, this.seasonId);
    this.storage.saveTrade(this.trade.listings, this.trade.receipts);
  }

  private priceOf = (id: ConfigBaseId): number | null => this.prices.priceOf(id);

  private toView(run: Run): RunView {
    const feGained = run.drops
      .filter((d) => d.configBaseId === FE_ID)
      .reduce((a, d) => a + d.qty, 0);

    const valueFe = runValue(run, this.priceOf);
    const costFe = runCost(run, this.priceOf);
    const netFe = valueFe - costFe;

    const byItem = new Map<ConfigBaseId, number>();
    for (const d of run.drops) {
      byItem.set(d.configBaseId, (byItem.get(d.configBaseId) ?? 0) + d.qty);
    }

    const drops: DropView[] = [...byItem.entries()]
      .map(([configBaseId, qty]) => {
        const info = this.items.get(configBaseId);
        const unitFe = this.priceOf(configBaseId);
        return {
          configBaseId,
          name: info?.name ?? `id ${configBaseId}`,
          icon: info?.icon ?? null,
          qty,
          unitFe,
          totalFe: unitFe === null ? null : unitFe * qty,
        };
      })
      .sort((a, b) => (b.totalFe ?? -1) - (a.totalFe ?? -1));

    const duration = run.durationMs ?? (run.endedAt === null ? Date.now() - run.startedAt : 0);

    return {
      areaId: run.areaId,
      name: mapName(run.asset, run.areaId),
      startedAt: run.startedAt,
      durationMs: run.durationMs,
      feGained,
      valueFe,
      costFe,
      netFe,
      perHour: perHour(netFe, duration),
      drops,
    };
  }

  private buildSnapshot(): Snapshot {
    const live = this.segmenter.all;
    const open = live.find((r) => r.endedAt === null) ?? null;

    const allRuns = [...this.history, ...live.filter((r) => r.endedAt !== null)];
    const farming = allRuns.filter((r) => !r.isHub && (r.durationMs ?? 0) > 5000);

    const netRates = farming.map((r) => {
      const value = runValue(r, this.priceOf) - runCost(r, this.priceOf);
      return perHour(value, r.durationMs ?? 0);
    });
    const feRates = farming.map((r) => {
      const fe = r.drops.filter((d) => d.configBaseId === FE_ID).reduce((a, d) => a + d.qty, 0);
      return perHour(fe, r.durationMs ?? 0);
    });

    const realized = this.trade.summarize(this.priceOf);

    let unpricedDrops = 0;
    for (const r of farming) {
      for (const d of r.drops) if (this.priceOf(d.configBaseId) === null) unpricedDrops++;
    }

    const status: Snapshot['status'] = open && !open.isHub ? 'running' : 'idle';

    return {
      status,
      hint: this.hintFor(status),
      seasonId: this.seasonId,
      current: open && !open.isHub ? this.toView(open) : null,
      recent: farming
        .slice(-25)
        .reverse()
        .map((r) => this.toView(r)),
      rate: summarize(netRates),
      feRate: summarize(feRates),
      totals: {
        runs: farming.length,
        inMapMs: farming.reduce((a, r) => a + (r.durationMs ?? 0), 0),
        feGained: farming.reduce(
          (a, r) =>
            a + r.drops.filter((d) => d.configBaseId === FE_ID).reduce((s, d) => s + d.qty, 0),
          0,
        ),
        valueFe: farming.reduce((a, r) => a + runValue(r, this.priceOf), 0),
        costFe: farming.reduce((a, r) => a + runCost(r, this.priceOf), 0),
        realizedFe: realized.realizedFe,
        realizationRatio: realized.ratio,
      },
      diagnostics: {
        unknownProtos: [...this.diagnostics.unknownProtos.entries()],
        pricedItems: this.prices.size,
        unpricedDrops,
      },
    };
  }

  private hintFor(status: Snapshot['status']): string | null {
    if (status === 'running') return null;
    if (this.diagnostics.linesMatched === 0) {
      return 'Лог не читается. В игре: Настройки → Другое → Включить лог, затем перезайти персонажем.';
    }
    if (this.lastActivityAt > 0 && Date.now() - this.lastActivityAt > 120_000) {
      return 'Игра давно ничего не пишет в лог. Возможно, она закрыта.';
    }
    return 'Ждём вход в карту.';
  }

  snapshot(status: Snapshot['status'], hint: string): Snapshot {
    const base = this.buildSnapshot();
    return { ...base, status, hint };
  }

  stop(): void {
    this.tailer?.stop();
    this.persistFinished();
    this.storage.close();
  }
}

/**
 * Человекочитаемое имя карты.
 *
 * Ассеты называются пиньинем (YL_MaNeiLaYuLin100). Русские названия появятся,
 * когда будет готов глоссарий; пока показываем очищенный ассет,
 * а не «зона 5348».
 */
function mapName(asset: string | null, areaId: number): string {
  if (!asset) return `Зона ${areaId}`;
  return asset.replace(/^[A-Z]{2}_/, '').replace(/(\d+)$/, '');
}
