import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import {
  activeDuration,
  groupByStrategy,
  isFarmingRun,
  mergeRuns,
  missingPrices,
  rollingNorm,
  runFe,
  runNet,
  type StrategyStats,
} from '../core/analysis.js';
import { EventParser } from '../core/eventParser.js';
import { InventoryTracker } from '../core/inventory.js';
import { findLogDirectory } from '../core/locate.js';
import { isBoundName, PriceStore } from '../core/priceStore.js';
import { heroName } from '../core/heroes.js';
import { retroScan, runCost, runValue } from '../core/retroScan.js';
import { RunSegmenter } from '../core/runSegmenter.js';
import { percentile, perHour, summarize, type RateSummary } from '../core/stats.js';
import { TradeLedger, mergeByKey } from '../core/trade.js';
import {
  mergePlayerInfo,
  type ConfigBaseId,
  type Diagnostics,
  type PlayerProfile,
  type Run,
} from '../core/types.js';
import { Storage } from '../storage/db.js';
import { CommunityPriceFeed } from './communityPrices.js';
import { iconUrl } from './icons.js';
import { LogTailer } from './tailer.js';

export interface DropView {
  configBaseId: ConfigBaseId;
  name: string;
  icon: string | null;
  qty: number;
  unitFe: number | null;
  totalFe: number | null;
  /** Откуда цена: своя пробивка или база сообщества. */
  priceSource: 'own' | 'community' | null;
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

/** Персонаж для показа в интерфейсе. */
export interface PlayerView {
  playerId: string;
  /** Ник аккаунта без решёточного суффикса: «VLPZDC», не «VLPZDC#3648». */
  name: string | null;
  /** Имя класса или «Герой N», если id ещё не в словаре. */
  heroName: string | null;
  level: number | null;
}

/** Пункт фильтра по персонажам. */
export interface PlayerOption extends PlayerView {
  /** Фарм-забегов у персонажа — чтобы фильтр показывал, где есть данные. */
  runs: number;
}

export interface Snapshot {
  status: 'searching' | 'idle' | 'running';
  /** Пояснение статуса для игрока: почему ничего не происходит. */
  hint: string | null;
  /**
   * Когда лог последний раз дал распознанное событие; 0 — ещё ни разу.
   * Интерфейс считает «N с назад» сам — снапшот не обязан тикать.
   */
  lastActivityAt: number;
  /** Папка логов, с которой работает движок. null — игра не найдена. */
  logDir: string | null;
  seasonId: number | null;
  /** Кем зашли в игру. null — вход ещё не видели (или игра перезапущена). */
  player: PlayerView | null;
  /** Все известные персонажи — для фильтра. */
  players: PlayerOption[];
  /** Активный фильтр по персонажу. null — показываются все. */
  playerFilter: string | null;
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
   * Темп за сессию, включая текущий забег.
   * В отличие от медианы двигается сразу при подборе — иначе экран
   * выглядит замершим ровно в тот момент, когда что-то происходит.
   */
  liveRate: number;
  session: {
    /** Начало отсчёта счётчиков. 0 — сессию ещё ни разу не сбрасывали. */
    startedAt: number;
    /** Итог прошлой сессии — чтобы сброс не выглядел потерей цифр. */
    previous: { netFe: number; inMapMs: number; runs: number } | null;
  };
  /** Норма для сравнений — медиана последних забегов, а не рекорд. */
  norm: number;
  /**
   * Порог «дорогой находки» для режима «авто»: P95 всех известных цен
   * сезона. В начале сезона 50 ФЕ — событие, в конце — фон; этот порог
   * дрейфует вместе с экономикой.
   */
  jackpotAutoFe: number;
  strategies: StrategyView[];
  /** Предметы без цены, по влиянию на оценку. */
  missing: MissingPriceView[];
  diagnostics: {
    unknownProtos: Array<[string, number]>;
    pricedItems: number;
    unpricedDrops: number;
    /** Сколько предметов оценено по базе сообщества (titrack.ninja). */
    communityPrices: number;
    communityEnabled: boolean;
    /** Когда цены сообщества успешно сверялись с сетью; null — ни разу. */
    communityFetchedAt: number | null;
    /** Последняя сверка не удалась — данные из кэша. */
    communityStale: boolean;
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
  /** Персонаж, которым зашли в игру. null — вход ещё не видели. */
  private currentPlayer: PlayerProfile | null = null;
  /** Все персонажи, которых видели в логах или помнит база. */
  private knownPlayers = new Map<string, PlayerProfile>();
  /** Фильтр интерфейса: показывать только забеги этого персонажа. */
  private playerFilter: string | null = null;
  /** Начало активной сессии. 0 — считаем всю историю (сброса не было). */
  private sessionStartedAt = 0;
  /** Границы последней закрытой сессии — для итоговой строки. */
  private previousSession: { startedAt: number; endedAt: number } | null = null;
  private lastActivityAt = 0;
  /** Метка времени последнего разобранного события — по часам лога. */
  private lastEventTs = 0;
  private community: CommunityPriceFeed;
  private communityEnabled: boolean;

  constructor(
    dataDir: string,
    items: Array<{ id: number; name: string; nameRu?: string | null; icon: string | null }>,
    language: NameLanguage = 'ru',
    options: { communityPrices?: boolean; playerFilter?: string | null } = {},
  ) {
    super();
    this.storage = new Storage(join(dataDir, 'gorn.db'));
    for (const it of items) {
      this.items.set(it.id, { name: it.name, nameRu: it.nameRu ?? null, icon: it.icon });
    }
    // Связанность — по названию из справочника. Арифметика «id + 1000»
    // ложно записывала в связанные 224 обычных предмета и обнуляла им цены.
    const bound: ConfigBaseId[] = [];
    for (const it of items) {
      if (isBoundName(it.name) || isBoundName(it.nameRu)) bound.push(it.id);
    }
    this.prices.registerBoundIds(bound);
    this.language = language;

    this.communityEnabled = options.communityPrices ?? true;
    this.playerFilter = options.playerFilter ?? null;
    this.community = new CommunityPriceFeed(dataDir);
    this.community.onUpdate(() => this.emit('snapshot', this.buildSnapshot()));
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

  /** Движок уже разобрал логи и следит за текущим. */
  private booted = false;

  get isBooted(): boolean {
    return this.booted;
  }

  /** Папка логов, с которой движок работает. null — игра не найдена. */
  get logDirectory(): string | null {
    return this.logDir;
  }

  /**
   * Полный старт: разбор накопленных логов, затем слежение за текущим.
   *
   * Пока игра не найдена, метод можно звать повторно (автоповтор поиска
   * или папка, указанная вручную) — до первого успешного старта он
   * ничего не инициализирует.
   */
  async start(logDirOverride?: string | null): Promise<void> {
    if (this.booted) return;
    this.logDir = logDirOverride ?? findLogDirectory();
    if (!this.logDir) {
      this.emit('snapshot', this.snapshot('searching', 'Не нашёл установленную игру'));
      return;
    }
    this.booted = true;

    this.sessionStartedAt = this.storage.activeSessionStart();
    this.previousSession = this.storage.previousSession();

    // Сначала поднимаем сохранённое: логи ротируются и удаляются игрой,
    // поэтому база — единственный источник истории старше пары часов.
    const stored = this.storage.loadRuns();
    const storedTrade = this.storage.loadTrade();
    for (const record of this.storage.loadPrices()) {
      this.prices.set(record.configBaseId, record.fe, record.observedAt);
    }

    // Прогресс уходит наверх: на большой пачке логов статичная заглушка
    // неотличима от зависания.
    const scan = await retroScan(this.logDir, (p) => this.emit('scanProgress', p));
    // Сезон — из ПОСЛЕДНЕГО файла. Первый элемент seasonIds — самый старый:
    // после смены сезона со старыми логами на диске трекер целый сезон
    // писал бы данные в прошлый.
    this.seasonId = scan.latestSeasonId ?? [...scan.seasonIds].pop() ?? null;

    // Разбор логов точнее сохранённого (мог улучшиться парсер), поэтому
    // при совпадении забега берём свежий разбор.
    this.history = mergeRuns(stored, scan.runs);

    for (const record of scan.prices.all()) {
      this.prices.set(record.configBaseId, record.fe, record.observedAt);
    }

    // Слияние со счётчиком вхождений: две одинаковые выплаты в одну
    // миллисекунду — это две выплаты, а один и тот же лог, прочитанный
    // дважды, — по-прежнему один набор событий.
    this.trade.listings.push(
      ...mergeByKey(
        [storedTrade.listings, scan.trade.listings],
        (l) => `${l.ts}:${l.configBaseId}:${l.qty}`,
      ),
    );
    this.trade.receipts.push(
      ...mergeByKey([storedTrade.receipts, scan.trade.receipts], (r) => `${r.ts}:${r.fe}`),
    );
    for (const [proto, n] of scan.unknownProtos) {
      this.diagnostics.unknownProtos.set(proto, n);
    }

    this.storage.saveRuns(scan.runs, this.seasonId);
    this.storage.savePrices(scan.prices.all());
    this.storage.saveTrade(scan.trade.listings, scan.trade.receipts);
    this.storage.savePlayers(scan.players);
    for (const p of this.storage.loadPlayers()) this.knownPlayers.set(p.playerId, p);

    // Кем зашли в последнем файле — с этим персонажем продолжает живое
    // дочитывание: перезахода может не быть ещё несколько часов.
    if (scan.lastPlayerId !== null) {
      this.currentPlayer = this.knownPlayers.get(scan.lastPlayerId) ?? null;
      this.segmenter.setPlayer(scan.lastPlayerId);
    }

    // Передаём живому трекеру состояние сумки, полученное при разборе.
    // Без этого первое изменение каждого слота уходит на установку базы,
    // и расход на первую же открытую карту после запуска не засчитывается.
    this.inventory.importSlots(scan.slots);

    // Первичные цены сообщества: закрывают предметы, которые игрок ещё
    // не пробивал сам. Собственные пробивки всегда в приоритете.
    if (this.communityEnabled && this.seasonId !== null) {
      this.community.start(this.seasonId);
    }

    this.startTailing(scan.currentLog);
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
      if (open && !open.isHub) {
        this.emit('snapshot', this.buildSnapshot());
        return;
      }
      // Вне карты срез шлётся только когда подсказка статуса меняется:
      // иначе «игра закрыта» вычислялось, но никогда не доезжало до экрана.
      const hint = this.hintFor('idle');
      if (hint !== this.lastIdleHint) {
        this.lastIdleHint = hint;
        this.emit('snapshot', this.buildSnapshot());
      }
    }, 5000);
  }

  private heartbeat: NodeJS.Timeout | null = null;
  private lastIdleHint: string | null = null;

  private startTailing(currentLog: { path: string; position: number } | null): void {
    if (!this.logDir) return;

    // Хвостим всегда UE_game.log по фиксированному пути, а не «последний
    // найденный файл»: если игра ещё не запускалась и лога нет, tailer сам
    // дождётся его появления опросом. Раньше при отсутствии текущего лога
    // дочитывание не запускалось вовсе, а при наличии одних бэкапов трекер
    // навсегда прилипал к мёртвому файлу.
    const path = currentLog?.path ?? join(this.logDir, 'UE_game.log');

    this.tailer = new LogTailer(path, {
      // Продолжаем ровно с того байта, где закончился ретро-скан: щель
      // между сканом и стартом дочитывания иначе теряет строки.
      ...(currentLog ? { initialPosition: currentLog.position } : {}),
      onLines: (lines) => this.consume(lines),
      onRotate: () => this.onLogRotate(),
      onError: (err) => this.emit('error', err),
    });
    this.tailer.start();
  }

  /**
   * Игра перезапущена: лог начался заново.
   *
   * Забеги, накопленные за сессию, ПЕРЕНОСЯТСЯ в историю, а не выбрасываются:
   * раньше они жили только в сегментере, и каждый перезапуск клиента стирал
   * с экрана весь вечерний фарм до перезапуска трекера.
   */
  private onLogRotate(): void {
    const finished = this.segmenter.finish(this.lastEventTs || Date.now());
    if (finished.length > 0) {
      this.storage.saveRuns(finished, this.seasonId);
      this.history = mergeRuns(this.history, finished);
    }

    // Состояние сумки и забегов начинается заново. Персонаж тоже:
    // после перезапуска игры кем зайдут — неизвестно до следующего входа.
    this.parser = new EventParser();
    this.inventory = new InventoryTracker(this.diagnostics);
    this.segmenter = new RunSegmenter();
    this.currentPlayer = null;
    this.emit('snapshot', this.buildSnapshot());
  }

  private consume(lines: string[]): void {
    let changed = false;

    for (const raw of lines) {
      this.diagnostics.linesTotal++;
      const m = /\+SeasonId \[(\d+)\]/.exec(raw);
      if (m) {
        const season = Number(m[1]);
        if (season !== this.seasonId) {
          // Смена сезона на лету: цены прошлого сезона неприменимы.
          this.seasonId = season;
          if (this.communityEnabled) this.community.start(season);
        }
      }

      const ev = this.parser.parse(raw);
      if (!ev) continue;
      this.diagnostics.linesMatched++;
      changed = true;
      this.lastActivityAt = Date.now();
      if ('ts' in ev && ev.ts > 0) this.lastEventTs = ev.ts;

      switch (ev.kind) {
        case 'itemChange':
          if (ev.phase === 'start') this.inventory.beginTransaction(ev.proto);
          else this.inventory.endTransaction();
          break;
        case 'bagInit':
          this.inventory.applyInit(ev);
          break;
        case 'bagAdd':
          this.inventory.applyAdd(ev);
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
        case 'playerInfo': {
          this.currentPlayer = mergePlayerInfo(this.knownPlayers.get(ev.playerId), ev);
          this.knownPlayers.set(ev.playerId, this.currentPlayer);
          this.segmenter.setPlayer(ev.playerId);
          this.storage.savePlayers([this.currentPlayer]);
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
    const map = mapName(run.asset, run.areaId);

    for (const cost of run.costs) {
      const info = this.items.get(cost.configBaseId);
      if (!info) continue;
      // План ищем по русскому названию маячка, английское — как запасной вариант.
      const plane = planeName(info.nameRu ?? info.name) ?? planeName(info.name);
      if (!plane) continue;
      // План — это стратегия, но карты внутри него разные. Одним планом
      // все строки таблицы называются одинаково и перестают различаться,
      // поэтому конкретная карта идёт следом.
      return run.asset ? `${plane} · ${map}` : plane;
    }

    return map;
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

  /**
   * Цена предмета: сначала собственные пробивки игрока, затем база
   * сообщества. Свои данные в приоритете: они с ЕГО сервера и свежее.
   */
  private priceOf = (id: ConfigBaseId): number | null => {
    const own = this.prices.priceOf(id);
    if (own !== null) return own;
    if (!this.communityEnabled) return null;
    return this.community.priceOf(id)?.fe ?? null;
  };

  private priceSourceOf(id: ConfigBaseId): 'own' | 'community' | null {
    if (this.prices.priceOf(id) !== null) return 'own';
    if (this.communityEnabled && this.community.priceOf(id) !== null) return 'community';
    return null;
  }

  /**
   * Фильтр по персонажу: срез пересобирается сразу.
   *
   * Фильтруется всё, что построено на забегах, — медиана, стратегии,
   * плитки, история. У разных героев разные билды и дроп, смешивать
   * их медианы — то самое «среднее по больнице». Торговый дом остаётся
   * общим: у выплат биржи нет пометки, чьи они.
   */
  setPlayerFilter(playerId: string | null): void {
    this.playerFilter = playerId;
    this.emit('snapshot', this.buildSnapshot());
  }

  /**
   * Новая сессия: счётчики начинают отсчёт с этого момента.
   * История не трогается — прошлые забеги остаются в базе и в медиане.
   */
  resetSession(): void {
    this.sessionStartedAt = this.storage.resetSession(Date.now());
    this.previousSession = this.storage.previousSession();
    this.emit('snapshot', this.buildSnapshot());
  }

  /** Включение и отключение цен сообщества на лету. */
  setCommunityPrices(enabled: boolean): void {
    this.communityEnabled = enabled;
    if (enabled && this.seasonId !== null) {
      this.community.start(this.seasonId);
    } else {
      this.community.stop();
    }
    this.emit('snapshot', this.buildSnapshot());
  }

  private toView(run: Run): RunView {
    const feGained = runFe(run);

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
          priceSource: this.priceSourceOf(configBaseId),
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
    const liveOpen = live.find((r) => r.endedAt === null) ?? null;

    // Дедупликация истории и живых забегов по ключу: перестраховка от
    // задвоения при повторном разборе того же лога. Живой разбор свежее.
    const allRuns = mergeRuns(
      this.history,
      live.filter((r) => r.endedAt !== null),
    );

    // Фильтр по персонажу режет всё, что построено на забегах. Забеги
    // без атрибуции (старые логи) видны только в режиме «все».
    const visible =
      this.playerFilter === null
        ? allRuns
        : allRuns.filter((r) => r.playerId === this.playerFilter);
    const open =
      liveOpen && (this.playerFilter === null || liveOpen.playerId === this.playerFilter)
        ? liveOpen
        : null;
    const farming = visible.filter(isFarmingRun);

    // Время считаем активное, а не по часам: простой внутри карты
    // раздувает знаменатель и тихо занижает любую цифру «в час».
    const netRates = farming.map((r) => perHour(runNet(r, this.priceOf), activeDuration(r)));
    const feRates = farming.map((r) => perHour(runFe(r), activeDuration(r)));

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

    // Счётчики («За сессию», «На картах», «Вложено», цель в оверлее)
    // считаются от начала сессии. Медиана, стратегии и список цен намеренно
    // остаются по всей истории: это статистика, а не счётчик, и резать
    // её выборку каждым сбросом жалко.
    //
    // Забег принадлежит сессии, в которой ЗАКОНЧИЛСЯ: сброс посреди карты
    // оставляет её в новой сессии целиком. Иначе открытая карта шла бы
    // в счётчики, пока идёт, и пропадала из них при выходе.
    const sessionFarming = farming.filter((r) => runEnd(r) >= this.sessionStartedAt);
    const sessionCounted = openFarming ? [...sessionFarming, openFarming] : sessionFarming;

    const inMapMs = sessionFarming.reduce((a, r) => a + activeDuration(r), 0) + openElapsed;
    const valueFe = sessionCounted.reduce((a, r) => a + runValue(r, this.priceOf), 0);
    const costFe = sessionCounted.reduce((a, r) => a + runCost(r, this.priceOf), 0);

    // Статус — про игру, а не про фильтр: на карте другим персонажем
    // «Ждём вход на карту» было бы неправдой.
    const status: Snapshot['status'] = liveOpen && !liveOpen.isHub ? 'running' : 'idle';

    return {
      status,
      hint: this.hintFor(status),
      lastActivityAt: this.lastActivityAt,
      logDir: this.logDir,
      seasonId: this.seasonId,
      player: this.playerView(),
      players: this.playerOptions(allRuns),
      playerFilter: this.playerFilter,
      current: open && !open.isHub ? this.toView(open) : null,
      recent: farming
        .slice(-25)
        .reverse()
        .map((r) => this.toView(r)),
      rate: summarize(netRates),
      feRate: summarize(feRates),
      liveRate: perHour(valueFe - costFe, inMapMs),
      norm: rollingNorm(netRates),
      jackpotAutoFe: this.jackpotAutoFe(),
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
      session: {
        startedAt: this.sessionStartedAt,
        previous: this.previousSummary(farming),
      },
      totals: {
        runs: sessionCounted.length,
        inMapMs,
        feGained: sessionCounted.reduce((a, r) => a + runFe(r), 0),
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
        communityPrices: this.communityEnabled ? this.community.size : 0,
        communityEnabled: this.communityEnabled,
        communityFetchedAt: this.community.fetchedAtMs,
        communityStale: this.community.stale,
      },
    };
  }

  /** Итог последней закрытой сессии по её границам во времени. */
  private previousSummary(
    farming: Run[],
  ): { netFe: number; inMapMs: number; runs: number } | null {
    const prev = this.previousSession;
    if (!prev) return null;
    const runs = farming.filter((r) => runEnd(r) >= prev.startedAt && runEnd(r) < prev.endedAt);
    if (runs.length === 0) return null;
    return {
      netFe: runs.reduce((a, r) => a + runNet(r, this.priceOf), 0),
      inMapMs: runs.reduce((a, r) => a + activeDuration(r), 0),
      runs: runs.length,
    };
  }

  private playerView(): PlayerView | null {
    const p = this.currentPlayer;
    return p ? toPlayerView(p) : null;
  }

  /**
   * Персонажи для фильтра, свежие сверху. Счётчик забегов — по всей
   * истории, без фильтра: он и есть подсказка, где сколько данных.
   */
  private playerOptions(allRuns: Run[]): PlayerOption[] {
    const counts = new Map<string, number>();
    for (const r of allRuns) {
      if (!isFarmingRun(r) || r.playerId === null) continue;
      counts.set(r.playerId, (counts.get(r.playerId) ?? 0) + 1);
    }
    return [...this.knownPlayers.values()]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((p) => ({ ...toPlayerView(p), runs: counts.get(p.playerId) ?? 0 }));
  }

  private jackpotAutoCache: { key: string; value: number } | null = null;

  /**
   * P95 известных цен: свои пробивки плюс база сообщества. Кэш по размерам
   * обоих источников — снапшот собирается часто, сортировать двухтысячный
   * список каждые 300 мс незачем.
   */
  private jackpotAutoFe(): number {
    const key = `${this.prices.size}:${this.communityEnabled ? this.community.size : 0}`;
    if (this.jackpotAutoCache?.key === key) return this.jackpotAutoCache.value;

    const values = this.prices.all().map((r) => r.fe);
    if (this.communityEnabled) {
      for (const p of this.community.all()) values.push(p.fe);
    }
    values.sort((a, b) => a - b);
    const value =
      values.length === 0 ? 50 : Math.max(10, Math.round(percentile(values, 0.95)));
    this.jackpotAutoCache = { key, value };
    return value;
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

  private stopped = false;

  stop(): void {
    // stop() зовут и window-all-closed, и before-quit — повторное закрытие
    // базы бросает исключение посреди выхода.
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.community.stop();
    this.tailer?.stop();
    this.persistFinished();
    this.storage.close();
  }
}

/** Когда забег закончился — по этой границе он относится к сессии. */
function runEnd(run: Run): number {
  return run.endedAt ?? run.startedAt;
}

/** Профиль → вид для интерфейса. */
function toPlayerView(p: PlayerProfile): PlayerView {
  return {
    playerId: p.playerId,
    // Решёточный суффикс — дискриминатор аккаунта, на экране он шум.
    name: p.name ? p.name.replace(/#\d+$/, '') : null,
    heroName: heroName(p.heroId),
    level: p.level,
  };
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
