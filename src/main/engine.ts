import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import {
  activeDuration,
  groupByStrategy,
  missingPrices,
  rollingNorm,
  runNet,
  type StrategyStats,
} from '../core/analysis.js';
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
import { iconUrl } from './icons.js';
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
    /** Бумажная оценка того, что выставлено на продажу. Сравнима с realizedFe. */
    listedPaperFe: number;
  };
  /**
   * Темп за всё время в картах, включая текущий забег.
   * В отличие от медианы двигается сразу при подборе — иначе экран
   * выглядит замершим ровно в тот момент, когда что-то происходит.
   */
  liveRate: number;
  /** Норма для сравнений — медиана последних забегов, а не рекорд. */
  norm: number;
  strategies: StrategyView[];
  /** Предметы без цены, по влиянию на оценку. */
  missing: MissingPriceView[];
  diagnostics: {
    unknownProtos: Array<[string, number]>;
    pricedItems: number;
    unpricedDrops: number;
  };
}

export interface StrategyView extends Omit<StrategyStats, 'costItems'> {
  /** Человекочитаемое имя: из чего открывалась карта. */
  title: string;
  costItems: Array<{ configBaseId: ConfigBaseId; name: string; icon: string | null }>;
}

export interface MissingPriceView {
  configBaseId: ConfigBaseId;
  name: string;
  icon: string | null;
  qty: number;
  runs: number;
  /** Тратится на открытие карт — прибыль занижена ровно на его стоимость. */
  isCost: boolean;
}

interface ItemInfo {
  name: string;
  nameRu: string | null;
  icon: string | null;
}

/** Какие названия предметов показывать. */
export type NameLanguage = 'ru' | 'en' | 'both';

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

  constructor(
    dataDir: string,
    items: Array<{ id: number; name: string; nameRu?: string | null; icon: string | null }>,
    language: NameLanguage = 'ru',
  ) {
    super();
    this.storage = new Storage(join(dataDir, 'gorn.db'));
    for (const it of items) {
      this.items.set(it.id, { name: it.name, nameRu: it.nameRu ?? null, icon: it.icon });
    }
    this.prices.registerKnownItems(this.items.keys());
    this.language = language;
  }

  private language: NameLanguage;

  /** Переключение языка названий: срез пересобирается сразу. */
  setLanguage(language: NameLanguage): void {
    this.language = language;
    this.emit('snapshot', this.buildSnapshot());
  }

  /**
   * Название предмета для показа.
   *
   * Русское есть у 96% справочника; для остального (в основном навыки)
   * остаётся английское — лучше показать английское название, чем «id 7090».
   */
  private displayName(id: ConfigBaseId): string {
    const info = this.items.get(id);
    if (!info) return `id ${id}`;
    if (this.language === 'en' || !info.nameRu) return info.name;
    if (this.language === 'both') return `${info.nameRu} · ${info.name}`;
    return info.nameRu;
  }

  /** Полный старт: разбор накопленных логов, затем слежение за текущим. */
  async start(): Promise<void> {
    this.logDir = findLogDirectory();
    if (!this.logDir) {
      this.emit('snapshot', this.snapshot('searching', 'Не нашёл установленную игру'));
      return;
    }

    // Сначала поднимаем сохранённое: логи ротируются и удаляются игрой,
    // поэтому база — единственный источник истории старше пары часов.
    const stored = this.storage.loadRuns();
    const storedTrade = this.storage.loadTrade();
    for (const record of this.storage.loadPrices()) {
      this.prices.set(record.configBaseId, record.fe, record.observedAt);
    }

    const scan = await retroScan(this.logDir);
    this.seasonId = [...scan.seasonIds][0] ?? null;

    // Разбор логов точнее сохранённого (мог улучшиться парсер), поэтому
    // при совпадении забега берём свежий разбор.
    const byKey = new Map<string, Run>();
    for (const run of stored) byKey.set(`${run.startedAt}:${run.areaId}`, run);
    for (const run of scan.runs) byKey.set(`${run.startedAt}:${run.areaId}`, run);
    this.history = [...byKey.values()].sort((a, b) => a.startedAt - b.startedAt);

    for (const record of scan.prices.all()) {
      this.prices.set(record.configBaseId, record.fe, record.observedAt);
    }

    const seenListing = new Set<string>();
    for (const l of [...storedTrade.listings, ...scan.trade.listings]) {
      const key = `${l.ts}:${l.configBaseId}:${l.qty}`;
      if (seenListing.has(key)) continue;
      seenListing.add(key);
      this.trade.listings.push(l);
    }
    const seenReceipt = new Set<string>();
    for (const r of [...storedTrade.receipts, ...scan.trade.receipts]) {
      const key = `${r.ts}:${r.fe}`;
      if (seenReceipt.has(key)) continue;
      seenReceipt.add(key);
      this.trade.receipts.push(r);
    }
    for (const [proto, n] of scan.unknownProtos) {
      this.diagnostics.unknownProtos.set(proto, n);
    }

    this.storage.saveRuns(scan.runs, this.seasonId);
    this.storage.savePrices(scan.prices.all());
    this.storage.saveTrade(scan.trade.listings, scan.trade.receipts);

    // Передаём живому трекеру состояние сумки, полученное при разборе.
    // Без этого первое изменение каждого слота уходит на установку базы,
    // и расход на первую же открытую карту после запуска не засчитывается.
    this.inventory.importSlots(scan.slots);

    this.startTailing();
    this.startHeartbeat();
    this.emit('snapshot', this.buildSnapshot());
  }

  /**
   * Пока идёт забег, время в карте растёт само по себе, без новых строк
   * в логе, и таймер должен идти.
   *
   * Интервал намеренно редкий: при частой отправке накопительный темп
   * заметно уползает вниз между подборами — знаменатель растёт, числитель
   * нет. Математически это верно, но число, которое само по себе убывает
   * каждую секунду, читается как поломка.
   */
  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      const open = this.segmenter.all.find((r) => r.endedAt === null);
      if (open && !open.isHub) this.emit('snapshot', this.buildSnapshot());
    }, 5000);
  }

  private heartbeat: NodeJS.Timeout | null = null;

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

  /** Предметы, которые игроку уже падали или которые он выставлял. */
  seenItemIds(): ConfigBaseId[] {
    const ids = new Set<ConfigBaseId>();
    for (const run of [...this.history, ...this.segmenter.all]) {
      for (const d of run.drops) ids.add(d.configBaseId);
      for (const c of run.costs) ids.add(c.configBaseId);
    }
    for (const l of this.trade.listings) ids.add(l.configBaseId);
    // Цены пробивают ровно для того, что собираются продавать.
    for (const p of this.prices.all()) ids.add(p.configBaseId);
    return [...ids];
  }

  /**
   * Человекочитаемое имя забега.
   *
   * В логе есть только внутреннее имя ассета в пиньине — MaNeiLaYuLin,
   * YuanSuKuangDong. Игровых названий там нет ни на русском, ни на английском.
   *
   * Зато известно, чем карта открыта, а маяк называет план Инобытия прямо:
   * «Voidlands Beacon (Timemark 8)» → «Пустоши · метка 8». Это то, чем игрок
   * карту и опознаёт, в отличие от транслитерации китайского названия.
   */
  private runName(run: Run): string {
    for (const cost of run.costs) {
      const info = this.items.get(cost.configBaseId);
      if (!info) continue;
      // План ищем по русскому названию маячка, английское — как запасной вариант.
      const readable = planeName(info.nameRu ?? info.name) ?? planeName(info.name);
      if (readable) return readable;
    }
    return mapName(run.asset, run.areaId);
  }

  /**
   * Имя стратегии — перечисление того, чем открывалась карта.
   *
   * Полные названия маяков не помещаются в карточку («Bronze Wick +
   * Voidlands Beacon (Timemark 8)» обрезается на полуслове), поэтому
   * маяк сокращается до плана и метки.
   */
  private strategyTitle(stats: StrategyStats): string {
    if (stats.costItems.length === 0) return 'Без вложений';
    return stats.costItems
      .map((id) => {
        const info = this.items.get(id);
        if (!info) return `id ${id}`;
        return planeName(info.nameRu ?? info.name) ?? this.displayName(id);
      })
      .join(' + ');
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
          name: this.displayName(configBaseId),
          // Отдаём адрес собственной схемы, а не ссылку на чужой CDN:
          // иконка приедет из локального кэша, а при первом показе — скачается.
          icon: info?.icon ? iconUrl(configBaseId) : null,
          qty,
          unitFe,
          totalFe: unitFe === null ? null : unitFe * qty,
        };
      })
      .sort((a, b) => (b.totalFe ?? -1) - (a.totalFe ?? -1));

    const duration = run.durationMs ?? (run.endedAt === null ? Date.now() - run.startedAt : 0);

    return {
      areaId: run.areaId,
      name: this.runName(run),
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

    // Время считаем активное, а не по часам: простой внутри карты
    // раздувает знаменатель и тихо занижает любую цифру «в час».
    const netRates = farming.map((r) => perHour(runNet(r, this.priceOf), activeDuration(r)));
    const feRates = farming.map((r) => {
      const fe = r.drops.filter((d) => d.configBaseId === FE_ID).reduce((a, d) => a + d.qty, 0);
      return perHour(fe, activeDuration(r));
    });

    const realized = this.trade.summarize(this.priceOf);

    // Текущий забег обязан попадать в итоги: иначе подобранное «сейчас»
    // не видно нигде до выхода из карты, и экран кажется замершим.
    const openFarming = open && !open.isHub ? open : null;
    const openElapsed = openFarming ? activeDuration(openFarming, undefined, Date.now()) : 0;
    const counted = openFarming ? [...farming, openFarming] : farming;

    let unpricedDrops = 0;
    for (const r of counted) {
      for (const d of r.drops) if (this.priceOf(d.configBaseId) === null) unpricedDrops++;
    }

    const inMapMs = farming.reduce((a, r) => a + activeDuration(r), 0) + openElapsed;
    const valueFe = counted.reduce((a, r) => a + runValue(r, this.priceOf), 0);
    const costFe = counted.reduce((a, r) => a + runCost(r, this.priceOf), 0);

    const status: Snapshot['status'] = openFarming ? 'running' : 'idle';

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
      liveRate: perHour(valueFe - costFe, inMapMs),
      norm: rollingNorm(netRates),
      strategies: groupByStrategy(farming, this.priceOf)
        .filter((s) => s.runs >= 2)
        .slice(0, 6)
        .map((s) => ({
          ...s,
          title: this.strategyTitle(s),
          costItems: s.costItems.map((id) => ({
            configBaseId: id,
            name: this.displayName(id),
            icon: this.items.get(id)?.icon ? iconUrl(id) : null,
          })),
        })),
      missing: missingPrices(counted, this.priceOf)
        .slice(0, 8)
        .map((m) => ({
          ...m,
          name: this.displayName(m.configBaseId),
          icon: this.items.get(m.configBaseId)?.icon ? iconUrl(m.configBaseId) : null,
        })),
      totals: {
        runs: counted.length,
        inMapMs,
        feGained: counted.reduce(
          (a, r) =>
            a + r.drops.filter((d) => d.configBaseId === FE_ID).reduce((s, d) => s + d.qty, 0),
          0,
        ),
        valueFe,
        costFe,
        realizedFe: realized.realizedFe,
        realizationRatio: realized.ratio,
        listedPaperFe: realized.paperFe,
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

    // Про нечитаемый лог говорим только если из него действительно ничего
    // не удалось достать. Раньше подсказка опиралась на счётчик живого
    // дочитывания и врала «лог не читается» при полной истории на экране.
    if (this.history.length === 0 && this.diagnostics.linesMatched === 0) {
      return 'Лог не читается. В игре: Настройки → Другое → Включить лог, затем перезайти персонажем.';
    }
    if (this.lastActivityAt === 0) return 'Игра не запущена.';
    if (Date.now() - this.lastActivityAt > 120_000) {
      return 'Игра давно ничего не пишет в лог — похоже, закрыта.';
    }
    return 'Ждём вход на карту.';
  }

  snapshot(status: Snapshot['status'], hint: string): Snapshot {
    const base = this.buildSnapshot();
    return { ...base, status, hint };
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
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
/**
 * Названия планов Инобытия в именительном падеже.
 *
 * В словаре они стоят в родительном, потому что там это часть названия
 * маячка: «Маячок Ледяной бездны». Для заголовка карты нужен именительный,
 * автоматически такое преобразование не сделать — отсюда таблица.
 * Сами формулировки взяты из словаря, а не придуманы: раньше здесь было
 * «Пустоши бездны» вместо «Пустотные земли».
 */
const PLANES: Array<[RegExp, string]> = [
  [/Ледяной бездны|Glacial Abyss/i, 'Ледяная бездна'],
  [/Кипящей лавы|Blistering Lava/i, 'Кипящая лава'],
  [/Стальной кузницы|Steel Forge/i, 'Стальная кузница'],
  [/Громовых пустошей|Thunder Waste/i, 'Громовые пустоши'],
  [/Пустотных земель|Voidlands/i, 'Пустотные земли'],
  [/Дальний космос|Deep Space/i, 'Дальний космос'],
];

/**
 * Достаёт из названия маячка план и метку времени.
 * «Маячок Пустотных земель (метка времени 8)» → «Пустотные земли · метка 8».
 * Возвращает null, если предмет картой не является.
 */
function planeName(itemName: string): string | null {
  if (!/Маячок|Beacon/i.test(itemName)) return null;
  const plane = PLANES.find(([re]) => re.test(itemName));
  if (!plane) return null;
  const mark = /метка времени\s*(\d+)|Timemark\s*(\d+)/i.exec(itemName);
  const number = mark?.[1] ?? mark?.[2];
  return number ? `${plane[1]} · метка ${number}` : plane[1];
}

function mapName(asset: string | null, areaId: number): string {
  if (!asset) return `Зона ${areaId}`;
  const cleaned = asset
    // Префикс папки бывает любой длины: XZ_, SD_, JH_, KD_.
    .replace(/^[A-Z]{2,4}_/, '')
    // Хвостовой номер экземпляра карты.
    .replace(/\d+$/, '')
    // После снятия номера может остаться висящий разделитель:
    // JH_YWMD_00001 превращался в «YWMD_».
    .replace(/[_\s-]+$/, '');
  return cleaned || `Зона ${areaId}`;
}
