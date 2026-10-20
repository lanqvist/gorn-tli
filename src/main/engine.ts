import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import {
  activeDuration,
  groupByStrategy,
  isFarmingRun,
  isPrisonRun,
  mergeRuns,
  missingPrices,
  pricesFor,
  rollingNorm,
  runEnd,
  runFe,
  runKey,
  runNet,
  topDrops,
  type PriceLookup,
  type RunPricing,
  type StrategyStats,
} from '../core/analysis.js';
import { EventParser } from '../core/eventParser.js';
import { InventoryTracker } from '../core/inventory.js';
import { findLogDirectory } from '../core/locate.js';
import { isMapKeyType } from '../core/patterns.js';
import { bagValue } from '../core/bag.js';
import { toCsv } from '../core/csv.js';
import {
  dailyTotals,
  groupByMap,
  sessionTotals,
  type DayTotals,
  type MapStats,
  type SessionBounds,
  type SessionTotals,
} from '../core/history.js';
import {
  choosePrice,
  communityReference,
  isBoundName,
  PriceStore,
  priceTrend,
  type PriceSource,
  type PriceTrend,
} from '../core/priceStore.js';
import { heroName } from '../core/heroes.js';
import { MapNames, type MapCatalogue } from '../core/mapNames.js';
import { seasonName } from '../core/seasons.js';
import { tr, uiLanguage } from '../core/i18n.js';
import { retroScan, runCost, runValue } from '../core/retroScan.js';
import { RunSegmenter } from '../core/runSegmenter.js';
import { percentile, perHour, summarize, type RateSummary } from '../core/stats.js';
import { TradeLedger, mergeByKey } from '../core/trade.js';
import {
  FE_ID,
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
  /** Откуда цена: своя пробивка, база сообщества или предмет исключён из учёта. */
  priceSource: ViewPriceSource | null;
}

/** Источник цены для интерфейса: исключённый предмет стоит ноль по воле игрока. */
export type ViewPriceSource = PriceSource | 'excluded';

type PickedPrice = { fe: number; source: ViewPriceSource };

/** Строка блока «Цены». */
export interface PriceRow {
  configBaseId: ConfigBaseId;
  name: string;
  icon: string | null;
  /** Цена, по которой сейчас считается добыча. null — неизвестна. */
  fe: number | null;
  source: ViewPriceSource | null;
  /** Когда пробил сам — по свежей пробивке. null — своих пробивок нет. */
  ownObservedAt: number | null;
  /** Тренд по своим пробивкам. */
  trend: PriceTrend;
  /** Сколько выпало и ушло на карты в видимых забегах. */
  seenQty: number;
}

/** Стоимость сумки для интерфейса. */
export interface BagView {
  valueFe: number;
  feCash: number;
  unpriced: number;
  top: Array<{
    configBaseId: ConfigBaseId;
    name: string;
    icon: string | null;
    qty: number;
    totalFe: number;
  }>;
}

export interface RunView {
  /** Ключ забега: стабилен между срезами, годится для React key. */
  key: string;
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
  /** Чем открывалась карта. */
  costs: DropView[];
  /** Тюрьма Талоса: в итоге сессии есть, в темпе нет (isPrisonRun). */
  prison?: boolean;
}

/** Результат поиска по всей истории забегов. */
export interface RunQueryResult {
  /** Сколько забегов подошло всего — показанных бывает меньше. */
  total: number;
  netFe: number;
  inMapMs: number;
  rate: RateSummary;
  /** Свежие сверху, не больше RUN_QUERY_LIMIT. */
  runs: RunView[];
}

/** Сколько забегов поиск отдаёт в интерфейс: итоги считаются по всем. */
export const RUN_QUERY_LIMIT = 100;

/** Персонаж для показа в интерфейсе. */
export interface PlayerView {
  playerId: string;
  /** Ник аккаунта без решёточного суффикса: «VLPZDC», не «VLPZDC#3648». */
  name: string | null;
  /** Имя класса или «Герой N», если id ещё не в словаре. */
  heroName: string | null;
  level: number | null;
  /** Сезон персонажа: в новом сезоне — новый персонаж. */
  seasonId: number | null;
  seasonName: string | null;
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
  /** Текущий сезон — по последнему профилю персонажа в логе. */
  seasonId: number | null;
  /** «SS14 Tartarus» — для шапки; null, пока сезон неизвестен. */
  seasonName: string | null;
  /**
   * Показывать забеги всех сезонов. false — только текущего: экономика
   * каждый сезон начинается заново, и медиана прошлого сезона описывает
   * другую игру.
   */
  allSeasons: boolean;
  /** Фарм-забегов других сезонов — без них переключатель не нужен. */
  otherSeasonRuns: number;
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
  /** Доходность по картам — «куда идти», в отличие от стратегий «чем открывать». */
  maps: MapStats[];
  /** Итоги по дням за последние две недели, старые слева. */
  days: DayTotals[];
  /** Сессии с итогами, свежие сверху. */
  sessions: SessionTotals[];
  /** Стоимость сумки по последнему известному состоянию. null — сумку ещё не видели. */
  bag: BagView | null;
  /** Порог «мелочи» в списках добычи, ФЕ. 0 — показывать всё. */
  minDropFe: number;
  /** Предметы без цены, по влиянию на оценку. */
  missing: MissingPriceView[];
  /** Самые дорогие находки сессии, дорогие первыми, до трёх. */
  sessionTop: SessionDropView[];
  /**
   * Тюрьма за сессию: её добыча входит в totals.valueFe, но не в темп,
   * время в картах и число забегов — показывается отдельной строкой.
   */
  prison: { netFe: number; runs: number };
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

/** Дорогая находка сессии — «крупное за сессию» в оверлее. */
export interface SessionDropView {
  configBaseId: ConfigBaseId;
  name: string;
  icon: string | null;
  qty: number;
  totalFe: number;
  /** Когда выпала последняя штука. */
  at: number;
  /** Карта, где выпала. */
  runName: string;
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

  /** Ключи от карт по справочнику: их серверное списание — вложение в карту. */
  private mapKeys = new Set<ConfigBaseId>();
  private isMapKey = (id: ConfigBaseId): boolean => this.mapKeys.has(id);

  private parser = new EventParser();
  private inventory = new InventoryTracker(this.diagnostics, this.isMapKey);
  private segmenter = new RunSegmenter();
  private trade = new TradeLedger();

  /**
   * Что уже записано в базу. Забег — с отпечатком (длительность и состав):
   * вернувшись в карту порталом, его дописывают, и тогда он сохраняется снова.
   * Без этого каждый вход в зону переписывал все забеги и всю торговлю сессии.
   */
  private persistedRuns = new WeakMap<Run, string>();
  private persistedTrade = new WeakSet<object>();

  /** Цены на время одного среза: сезон → предмет → цена (см. buildSnapshot). */
  private priceMemo: Map<number | null, Map<ConfigBaseId, PickedPrice | null>> | null = null;

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
  /** Показывать забеги всех сезонов, а не только текущего. */
  private allSeasons = false;
  /** Связанные предметы — нужны каждому новому хранилищу цен сезона. */
  private boundIds: ConfigBaseId[] = [];
  /** Начало активной сессии. 0 — считаем всю историю (сброса не было). */
  private sessionStartedAt = 0;
  /** Границы последней закрытой сессии — для итоговой строки. */
  private previousSession: { startedAt: number; endedAt: number } | null = null;
  /** Все сессии из базы — для истории. */
  private sessions: SessionBounds[] = [];
  /** Исключённые из учёта предметы: их добыча стоит ноль. */
  private excluded = new Set<ConfigBaseId>();
  /** Порог «мелочи» для списков добычи — только отображение. */
  private minDropFe = 0;
  private lastActivityAt = 0;
  /** Метка времени последнего разобранного события — по часам лога. */
  private lastEventTs = 0;
  private community: CommunityPriceFeed;
  private communityEnabled: boolean;
  private dataDir: string;
  /**
   * Цены прошлых сезонов — для их забегов в режиме «Все сезоны» и у
   * персонажей прошлых сезонов. Поднимаются лениво, при первом показе.
   */
  private pastSeasons = new Map<number, PastSeasonPrices>();

  constructor(
    dataDir: string,
    items: Array<{
      id: number;
      name: string;
      nameRu?: string | null;
      typeCn?: string | null;
      icon: string | null;
    }>,
    language: NameLanguage = 'ru',
    options: {
      communityPrices?: boolean;
      playerFilter?: string | null;
      allSeasons?: boolean;
      excludedItems?: number[];
      minDropFe?: number;
      /** Справочник названий карт (data/maps.json). Без него — имена ассетов. */
      maps?: MapCatalogue | null;
    } = {},
  ) {
    super();
    this.storage = new Storage(join(dataDir, 'gorn.db'));
    for (const it of items) {
      this.items.set(it.id, { name: it.name, nameRu: it.nameRu ?? null, icon: it.icon });
      if (isMapKeyType(it.typeCn)) this.mapKeys.add(it.id);
    }
    // Связанность — по названию из справочника. Арифметика «id + 1000»
    // ложно записывала в связанные 224 обычных предмета и обнуляла им цены.
    for (const it of items) {
      if (isBoundName(it.name) || isBoundName(it.nameRu)) this.boundIds.push(it.id);
    }
    this.prices.registerBoundIds(this.boundIds);
    this.language = language;

    this.communityEnabled = options.communityPrices ?? true;
    this.playerFilter = options.playerFilter ?? null;
    this.allSeasons = options.allSeasons ?? false;
    this.excluded = new Set(options.excludedItems ?? []);
    this.minDropFe = options.minDropFe ?? 0;
    this.maps = options.maps ? new MapNames(options.maps) : MapNames.empty();
    this.dataDir = dataDir;
    this.community = new CommunityPriceFeed(dataDir);
    this.community.onUpdate(() => this.emit('snapshot', this.buildSnapshot()));
  }

  private language: NameLanguage;
  private maps: MapNames;

  /**
   * Название карты для показа: игровое из справочника, на языке названий
   * предметов (это тоже игровые названия). Русского нет — английское,
   * карта неизвестна — очищенное имя ассета.
   */
  private mapName(asset: string | null, areaId: number): string {
    const known = this.maps.lookup(asset, areaId);
    if (!known) return assetName(asset, areaId);
    return this.language === 'en' ? known.en : (known.ru ?? known.en);
  }

  /** Переключение языка названий: срез пересобирается сразу. */
  setLanguage(language: NameLanguage): void {
    this.language = language;
    this.emit('snapshot', this.buildSnapshot());
  }

  /** Пересобрать срез: сменился язык интерфейса, и подписи в нём тоже. */
  refresh(): void {
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
      this.emit('snapshot', this.snapshot('searching', tr('Не нашёл установленную игру', 'Game installation not found')));
      return;
    }
    this.booted = true;

    this.sessionStartedAt = this.storage.activeSessionStart();
    this.previousSession = this.storage.previousSession();
    this.sessions = this.storage.listSessions();

    // Сначала поднимаем сохранённое: логи ротируются и удаляются игрой,
    // поэтому база — единственный источник истории старше пары часов.
    const stored = this.storage.loadRuns();
    const storedTrade = this.storage.loadTrade();

    // Прогресс уходит наверх: на большой пачке логов статичная заглушка
    // неотличима от зависания.
    const scan = await retroScan(this.logDir, (p) => this.emit('scanProgress', p), {
      isMapKey: this.isMapKey,
    });
    // Сезон — из ПОСЛЕДНЕГО файла. Первый элемент seasonIds — самый старый:
    // после смены сезона со старыми логами на диске трекер целый сезон
    // писал бы данные в прошлый.
    this.seasonId = scan.latestSeasonId ?? [...scan.seasonIds].pop() ?? null;

    // Разбор логов точнее сохранённого (мог улучшиться парсер), поэтому
    // при совпадении забега берём свежий разбор.
    this.history = mergeRuns(stored, scan.runs);

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
    this.storage.savePrices(scan.prices.observations());
    // Свои пробивки — только текущего сезона: база уже знает сезон каждой.
    this.loadSeasonPrices();
    this.storage.saveTrade(scan.trade.listings, scan.trade.receipts);
    // Торговля из базы и из логов теперь записана целиком.
    this.markTradePersisted();
    this.storage.savePlayers(scan.players);
    for (const p of this.storage.loadPlayers()) this.knownPlayers.set(p.playerId, p);

    // Кем зашли в последнем файле — с этим персонажем продолжает живое
    // дочитывание: перезахода может не быть ещё несколько часов.
    if (scan.lastPlayerId !== null) {
      this.currentPlayer = this.knownPlayers.get(scan.lastPlayerId) ?? null;
      this.segmenter.setPlayer(scan.lastPlayerId);
      this.segmenter.setSeason(this.currentPlayer?.seasonId ?? this.seasonId);
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
      onLines: (lines) => {
        this.consume(lines);
        // Сырые строки — для подсказок в тюрьме: им нужны строки интерфейса
        // (S16Board…), которые разбор валюты пропускает.
        this.emit('lines', lines);
      },
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
    this.inventory = new InventoryTracker(this.diagnostics, this.isMapKey);
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
          // Смена сезона на лету: цены прошлого сезона неприменимы —
          // ни сообщества, ни свои.
          this.seasonId = season;
          this.loadSeasonPrices();
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
          if (ev.seasonId !== undefined) this.segmenter.setSeason(ev.seasonId);
          this.storage.savePlayers([this.currentPlayer]);
          break;
        }
        default:
          break;
      }
    }

    if (changed) this.emit('snapshot', this.buildSnapshot());
  }

  /**
   * Хранилище своих пробивок текущего сезона. Цены прошлого сезона
   * не подмешиваются: свежая экономика стартует с нуля, и старая цена
   * хуже, чем никакой, — она молча подменяла бы цену сообщества.
   */
  private loadSeasonPrices(): void {
    this.prices = new PriceStore(this.seasonId);
    this.prices.registerBoundIds(this.boundIds);
    for (const record of this.storage.loadPrices(this.seasonId)) {
      this.prices.set(record.configBaseId, record.fe, record.observedAt);
    }
    // Сезон сменился: тот, что был текущим, становится прошлым, и его
    // цены поднимутся из базы заново — уже со всеми пробивками.
    this.pastSeasons.clear();
  }

  /**
   * Цены прошлого сезона: свои пробивки того сезона из базы и, если
   * включено, база сообщества за тот же season_id. Сеть трогается только
   * при первом показе забегов этого сезона — не на каждом запуске.
   */
  private pastSeasonPrices(season: number): PastSeasonPrices {
    let past = this.pastSeasons.get(season);
    if (!past) {
      const own = new PriceStore(season);
      own.registerBoundIds(this.boundIds);
      for (const record of this.storage.loadPrices(season)) {
        own.set(record.configBaseId, record.fe, record.observedAt);
      }
      const entry: PastSeasonPrices = { own, community: null, lookup: () => null };
      entry.lookup = (id) => this.pickPrice(id, season)?.fe ?? null;
      this.pastSeasons.set(season, entry);
      past = entry;
    }
    if (this.communityEnabled && !past.community) {
      past.community = new CommunityPriceFeed(this.dataDir, `community-prices-${season}.json`);
      past.community.onUpdate(() => this.emit('snapshot', this.buildSnapshot()));
      past.community.loadOnce(season);
    }
    return past;
  }

  /**
   * Таблица цен сезона. Забеги без сезона (старые логи без профиля)
   * оцениваются текущими ценами, как и раньше.
   */
  private seasonLookup(season: number | null): PriceLookup {
    if (season === null || season === this.seasonId) return this.priceOf;
    return this.pastSeasonPrices(season).lookup;
  }

  /** Каждый забег — по ценам своего сезона. */
  private perRunPricing: RunPricing = {
    forRun: (run) => this.seasonLookup(this.seasonOf(run)),
  };

  /**
   * Цены для видимых забегов. В обычном виде все они текущего сезона,
   * и срез считается одной таблицей, без поиска сезона на каждый забег.
   */
  private runPricing(): RunPricing {
    if (this.playerFilter === null && !this.allSeasons) return this.priceOf;
    return this.perRunPricing;
  }

  /** Закрытые забеги сразу уходят в базу: лог может ротироваться в любой момент. */
  private persistFinished(): void {
    const stamp = (r: Run) => `${r.durationMs}:${r.drops.length}:${r.costs.length}`;
    const finished = this.segmenter.all.filter(
      (r) => r.endedAt !== null && this.persistedRuns.get(r) !== stamp(r),
    );
    if (finished.length > 0) {
      this.storage.saveRuns(finished, this.seasonId);
      for (const r of finished) this.persistedRuns.set(r, stamp(r));
    }

    const listings = this.trade.listings.filter((l) => !this.persistedTrade.has(l));
    // Выплаты одной миллисекунды нумеруются по порядку (saveTrade) — их
    // пишем вместе с уже записанными соседями, иначе номер начнётся заново.
    const freshTs = new Set(
      this.trade.receipts.filter((r) => !this.persistedTrade.has(r)).map((r) => r.ts),
    );
    const receipts = this.trade.receipts.filter((r) => freshTs.has(r.ts));
    if (listings.length === 0 && receipts.length === 0) return;
    this.storage.saveTrade(listings, receipts);
    this.markTradePersisted();
  }

  private markTradePersisted(): void {
    for (const l of this.trade.listings) this.persistedTrade.add(l);
    for (const r of this.trade.receipts) this.persistedTrade.add(r);
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
   * Игровых названий в логе нет — только ассет и LevelId; название зоны
   * даёт справочник (mapName). Перед ним — план с меткой из маяка, которым
   * карту открыли: «Voidlands Beacon (Timemark 8)» → «Пустоши · метка 8».
   * По плану и метке игрок карту и опознаёт.
   */
  private runName(run: Run): string {
    const map = this.mapName(run.asset, run.areaId);

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
  private strategyTitle(costItems: ConfigBaseId[]): string {
    if (costItems.length === 0) return tr('Без вложений', 'No map costs');
    return costItems
      .map((id) => {
        const info = this.items.get(id);
        if (!info) return `id ${id}`;
        return planeName(info.nameRu ?? info.name) ?? this.displayName(id);
      })
      .join(' + ');
  }

  /**
   * Цена предмета: собственная пробивка, пока свежая, иначе база
   * сообщества, если она новее (правило — в choosePrice).
   *
   * У прошлого сезона «свежей» пробивки не бывает — рынок закрыт, — и
   * из своей и сообщества берётся та, что новее. Исключение из учёта
   * действует во всех сезонах: мусор остаётся мусором.
   */
  private pickPrice(id: ConfigBaseId, season: number | null = this.seasonId): PickedPrice | null {
    const memo = this.priceMemo;
    if (!memo) return this.pickPriceNow(id, season);
    let bySeason = memo.get(season);
    if (!bySeason) memo.set(season, (bySeason = new Map()));
    let picked = bySeason.get(id);
    if (picked === undefined) bySeason.set(id, (picked = this.pickPriceNow(id, season)));
    return picked;
  }

  private pickPriceNow(id: ConfigBaseId, season: number | null): PickedPrice | null {
    if (this.prices.isFixed(id)) return { fe: this.prices.priceOf(id) ?? 0, source: 'own' };
    if (this.excluded.has(id)) return { fe: 0, source: 'excluded' };
    const past = season === null || season === this.seasonId ? null : this.pastSeasonPrices(season);
    const own = (past ? past.own : this.prices).get(id) ?? null;
    const feed = past ? past.community : this.community;
    const community = this.communityEnabled && feed ? feed.priceOf(id) : null;
    return choosePrice(
      own,
      community && {
        // Экипировка вне справочника — по нижней цене (правило в communityReference).
        fe: communityReference(community, this.items.has(id)),
        updatedAtMs: () => Date.parse(community.updatedAt),
      },
      past ? Infinity : Date.now(),
    );
  }

  private priceOf = (id: ConfigBaseId): number | null => this.pickPrice(id)?.fe ?? null;

  private priceSourceOf(id: ConfigBaseId, season: number | null): ViewPriceSource | null {
    return this.pickPrice(id, season)?.source ?? null;
  }

  /**
   * Фильтр по персонажу: срез пересобирается сразу.
   *
   * Фильтруется всё, что построено на забегах, — медиана, стратегии,
   * плитки, история. У разных героев разные билды и дроп, смешивать
   * их медианы — то самое «среднее по больнице». Торговый дом остаётся
   * общим: у выплат биржи нет пометки, чьи они.
   */
  /**
   * Что показывать: персонажа, текущий сезон или все сезоны — одним
   * действием, чтобы интерфейс не мигал промежуточным срезом.
   */
  setRunScope(scope: { playerId: string | null; allSeasons: boolean }): void {
    this.playerFilter = scope.playerId;
    this.allSeasons = scope.allSeasons;
    this.emit('snapshot', this.buildSnapshot());
  }

  /** Сезон забега: свой, а у старых записей — сезон их персонажа. */
  private seasonOf(run: Run): number | null {
    if (run.seasonId !== null) return run.seasonId;
    if (run.playerId === null) return null;
    return this.knownPlayers.get(run.playerId)?.seasonId ?? null;
  }

  /**
   * Сезон, в границах которого считаются цифры: сезон выбранного персонажа,
   * текущий или null — все сезоны.
   */
  private scopeSeason(): number | null {
    if (this.playerFilter !== null) {
      return this.knownPlayers.get(this.playerFilter)?.seasonId ?? null;
    }
    return this.allSeasons ? null : this.seasonId;
  }

  /** Забег текущего сезона — или без сезона, который ему и приписывается. */
  private isCurrentSeason(run: Run): boolean {
    const season = this.seasonOf(run);
    return season === null || season === this.seasonId;
  }

  /** Виден ли забег при текущем фильтре. */
  private inScope(run: Run): boolean {
    if (this.playerFilter !== null) return run.playerId === this.playerFilter;
    if (this.allSeasons || this.seasonId === null) return true;
    return this.seasonOf(run) === this.seasonId;
  }

  /**
   * Новая сессия: счётчики начинают отсчёт с этого момента.
   * История не трогается — прошлые забеги остаются в базе и в медиане.
   */
  resetSession(): void {
    this.sessionStartedAt = this.storage.resetSession(Date.now());
    this.previousSession = this.storage.previousSession();
    this.sessions = this.storage.listSessions();
    this.emit('snapshot', this.buildSnapshot());
  }

  /**
   * Поиск по всей истории забегов под текущим фильтром персонажа:
   * по карте, плану, выпавшему и потраченному — на русском и английском.
   * Итоги считаются по всем совпадениям, а не по показанным: вопрос
   * «сколько я заработал на картах с компасом» — про сумму.
   */
  queryRuns(query: string): RunQueryResult {
    const needle = query.trim().toLocaleLowerCase('ru');
    const { farming } = this.visibleRuns();
    const matched =
      needle === '' ? farming : farming.filter((r) => this.searchText(r).includes(needle));

    let netFe = 0;
    let inMapMs = 0;
    const rates: number[] = [];
    const pricing = this.runPricing();
    for (const run of matched) {
      const net = runNet(run, pricing);
      netFe += net;
      // Тюрьма — в итоге, но не в темпе: её время лог не видит.
      if (isPrisonRun(run)) continue;
      const active = activeDuration(run);
      inMapMs += active;
      rates.push(perHour(net, active));
    }

    return {
      total: matched.length,
      netFe,
      inMapMs,
      rate: summarize(rates),
      runs: matched
        .slice(-RUN_QUERY_LIMIT)
        .reverse()
        .map((r) => this.toView(r)),
    };
  }

  /** Всё, по чему забег находится поиском, одной строкой в нижнем регистре. */
  private searchText(run: Run): string {
    const parts = [this.runName(run), assetName(run.asset, run.areaId)];
    // Карта находится по названию на любом языке, а не только на текущем.
    const map = this.maps.lookup(run.asset, run.areaId);
    if (map) parts.push(map.en, map.ru ?? '');
    for (const d of [...run.drops, ...run.costs]) {
      const info = this.items.get(d.configBaseId);
      if (!info) continue;
      parts.push(info.name);
      if (info.nameRu) parts.push(info.nameRu);
    }
    // Обе формулировки: поиск понимает запрос на любом языке интерфейса.
    if (run.costs.length === 0) parts.push('без вложений', 'no map costs');
    return parts.join('\n').toLocaleLowerCase('ru');
  }

  /**
   * Все видимые забеги в CSV для Excel: хронологически, по строке
   * на забег. Фильтр персонажа учитывается — выгружается то, что на экране.
   */
  exportRunsCsv(): string {
    const { farming } = this.visibleRuns();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = (ts: number) => {
      const d = new Date(ts);
      return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}`
      );
    };
    const pricing = this.runPricing();
    const items = (deltas: Run['drops'], season: number | null) =>
      this.itemViews(deltas, season)
        .map((v) => `${v.name} ×${v.qty}`)
        .join(', ');

    return toCsv(
      [
        tr('Начало', 'Started'),
        tr('Персонаж', 'Character'),
        tr('Карта', 'Map'),
        tr('Стратегия', 'Strategy'),
        tr('В карте, мин', 'In map, min'),
        tr('Добыча, ФЕ', 'Loot, FE'),
        tr('Вложено, ФЕ', 'Invested, FE'),
        tr('Чистыми, ФЕ', 'Net, FE'),
        tr('Чистыми в час, ФЕ', 'Net per hour, FE'),
        tr('Валюта ФЕ', 'FE currency'),
        tr('Выпало', 'Dropped'),
        tr('Потрачено', 'Spent'),
      ],
      farming.map((r) => {
        const active = activeDuration(r);
        const net = runNet(r, pricing);
        const player = r.playerId === null ? null : this.knownPlayers.get(r.playerId);
        const view = player ? toPlayerView(player) : null;
        return [
          stamp(r.startedAt),
          view
            ? [view.heroName ?? view.name, view.level !== null ? tr(`${view.level} ур.`, `lvl ${view.level}`) : null]
                .filter(Boolean)
                .join(' ')
            : null,
          this.runName(r),
          this.strategyTitle([...new Set(r.costs.map((c) => c.configBaseId))].sort((a, b) => a - b)),
          active / 60_000,
          runValue(r, pricing),
          runCost(r, pricing),
          net,
          perHour(net, active),
          runFe(r),
          items(r.drops, this.seasonOf(r)),
          items(r.costs, this.seasonOf(r)),
        ];
      }),
      // Excel берёт разделители из региональных настроек системы — по ним
      // же выбран язык интерфейса.
      uiLanguage(),
    );
  }

  /**
   * Исключение предмета из учёта: его добыча стоит ноль во всех цифрах,
   * и «Пробить цену» про него больше не напоминает.
   */
  setExcluded(configBaseId: ConfigBaseId, excluded: boolean): void {
    if (excluded) this.excluded.add(configBaseId);
    else this.excluded.delete(configBaseId);
    this.emit('snapshot', this.buildSnapshot());
  }

  /** Порог «мелочи» в списках добычи. */
  setMinDropFe(value: number): void {
    this.minDropFe = Math.max(0, value);
    this.emit('snapshot', this.buildSnapshot());
  }

  /** Сумка по последнему известному состоянию слотов. */
  private bagView(): BagView | null {
    const contents = this.inventory.snapshot();
    if (contents.size === 0) return null;
    const bag = bagValue(contents, this.priceOf);
    return {
      ...bag,
      top: bag.top.map((item) => ({
        ...item,
        name: this.displayName(item.configBaseId),
        icon: this.items.get(item.configBaseId)?.icon ? iconUrl(item.configBaseId) : null,
      })),
    };
  }

  /**
   * Цены с историей своих пробивок. Пустой запрос — то, что падает
   * в видимых забегах, по влиянию на оценку, плюс исключённое: иначе
   * исключение было бы не вернуть. Запрос — поиск по всему справочнику.
   */
  queryPrices(query: string): PriceRow[] {
    const LIMIT = 40;
    const needle = query.trim().toLocaleLowerCase('ru');

    const seen = new Map<ConfigBaseId, number>();
    for (const run of this.visibleRuns().farming) {
      for (const d of [...run.drops, ...run.costs]) {
        seen.set(d.configBaseId, (seen.get(d.configBaseId) ?? 0) + d.qty);
      }
    }

    let ids: ConfigBaseId[];
    if (needle === '') {
      const impact = (id: ConfigBaseId) => (this.priceOf(id) ?? 0) * (seen.get(id) ?? 0);
      ids = [
        ...[...this.excluded],
        ...[...seen.keys()]
          .filter((id) => id !== FE_ID && !this.excluded.has(id))
          .sort((a, b) => impact(b) - impact(a) || (seen.get(b) ?? 0) - (seen.get(a) ?? 0)),
      ];
    } else {
      const matches: ConfigBaseId[] = [];
      for (const [id, info] of this.items) {
        const text = `${info.name}\n${info.nameRu ?? ''}`.toLocaleLowerCase('ru');
        if (id !== FE_ID && text.includes(needle)) matches.push(id);
      }
      // Сначала знакомое: что падало, затем то, у чего есть цена.
      const rank = (id: ConfigBaseId) =>
        (seen.has(id) ? 2 : 0) + (this.priceOf(id) !== null ? 1 : 0);
      ids = matches.sort((a, b) => rank(b) - rank(a));
    }

    return ids.slice(0, LIMIT).map((id) => {
      const picked = this.pickPrice(id);
      const own = this.prices.get(id);
      return {
        configBaseId: id,
        name: this.displayName(id),
        icon: this.items.get(id)?.icon ? iconUrl(id) : null,
        fe: picked?.fe ?? null,
        source: picked?.source ?? null,
        ownObservedAt: own?.observedAt ?? null,
        trend: priceTrend(this.storage.priceHistory(id, undefined, this.seasonId)),
        seenQty: seen.get(id) ?? 0,
      };
    });
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

    // Забег прошлого сезона — по ценам того сезона, и строки добычи тоже.
    const season = this.seasonOf(run);
    const priceOf = this.seasonLookup(season);
    const valueFe = runValue(run, priceOf);
    const costFe = runCost(run, priceOf);
    const netFe = valueFe - costFe;

    const duration = run.durationMs ?? (run.endedAt === null ? Date.now() - run.startedAt : 0);

    return {
      key: runKey(run),
      areaId: run.areaId,
      name: this.runName(run),
      startedAt: run.startedAt,
      durationMs: run.durationMs,
      feGained,
      valueFe,
      costFe,
      netFe,
      perHour: perHour(netFe, duration),
      drops: this.itemViews(run.drops, season),
      costs: this.itemViews(run.costs, season),
      ...(isPrisonRun(run) ? { prison: true } : {}),
    };
  }

  /** Строки предметов: одинаковые сложены, дорогие сверху. */
  private itemViews(deltas: Run['drops'], season: number | null): DropView[] {
    const priceOf = this.seasonLookup(season);
    const byItem = new Map<ConfigBaseId, number>();
    for (const d of deltas) {
      byItem.set(d.configBaseId, (byItem.get(d.configBaseId) ?? 0) + d.qty);
    }

    return [...byItem.entries()]
      .map(([configBaseId, qty]) => {
        const info = this.items.get(configBaseId);
        const unitFe = priceOf(configBaseId);
        return {
          configBaseId,
          name: this.displayName(configBaseId),
          // Отдаём адрес собственной схемы, а не ссылку на чужой CDN:
          // иконка приедет из локального кэша, а при первом показе — скачается.
          icon: info?.icon ? iconUrl(configBaseId) : null,
          qty,
          unitFe,
          totalFe: unitFe === null ? null : unitFe * qty,
          priceSource: this.priceSourceOf(configBaseId, season),
        };
      })
      .sort((a, b) => (b.totalFe ?? -1) - (a.totalFe ?? -1));
  }

  /**
   * Забеги, которые видит интерфейс: история плюс завершённые живые,
   * под фильтром персонажа. Общая основа среза, поиска и экспорта.
   */
  private visibleRuns(): {
    allRuns: Run[];
    liveOpen: Run | null;
    open: Run | null;
    farming: Run[];
  } {
    const live = this.segmenter.all;
    const liveOpen = live.find((r) => r.endedAt === null) ?? null;

    // Дедупликация истории и живых забегов по ключу: перестраховка от
    // задвоения при повторном разборе того же лога. Живой разбор свежее.
    const allRuns = mergeRuns(
      this.history,
      live.filter((r) => r.endedAt !== null),
    );

    // Фильтр по персонажу и сезону режет всё, что построено на забегах.
    // Забеги без атрибуции (старые логи) видны только в режиме «все сезоны».
    const visible = allRuns.filter((r) => this.inScope(r));
    const open = liveOpen && this.inScope(liveOpen) ? liveOpen : null;
    const farming = visible.filter(isFarmingRun);
    return { allRuns, liveOpen, open, farming };
  }

  /**
   * Срез обходит всю историю раз десять, и каждая цена — это выбор между
   * своей пробивкой и базой сообщества (объекты, Date.parse). На время среза
   * выбор запоминается: при тысячах забегов срез в 10+ раз быстрее, а он
   * пересобирается на каждую пачку строк лога.
   */
  private buildSnapshot(): Snapshot {
    if (this.priceMemo) return this.buildSnapshotNow();
    this.priceMemo = new Map();
    try {
      return this.buildSnapshotNow();
    } finally {
      this.priceMemo = null;
    }
  }

  private buildSnapshotNow(): Snapshot {
    const { allRuns, liveOpen, open, farming } = this.visibleRuns();
    // Каждый забег — по ценам своего сезона: в «Все сезоны» медиана SS13
    // иначе считалась бы по ценам SS14.
    const pricing = this.runPricing();

    // Время считаем активное, а не по часам: простой внутри карты
    // раздувает знаменатель и тихо занижает любую цифру «в час».
    // Темп, медианы, рекорды, карты и стратегии — без тюрьмы (isPrisonRun).
    const rated = farming.filter((r) => !isPrisonRun(r));
    const netRates = rated.map((r) => perHour(runNet(r, pricing), activeDuration(r)));
    const feRates = rated.map((r) => perHour(runFe(r), activeDuration(r)));

    // У выплат биржи нет пометки сезона — границы сезона берём по его
    // забегам. Иначе коэффициент реализации смешивал бы старые лоты
    // с ценами новой экономики.
    const bounds = this.seasonBounds(allRuns, liveOpen);
    const realized = this.trade.summarize(
      this.seasonLookup(this.scopeSeason()),
      bounds.from,
      bounds.to,
    );

    // Текущий забег обязан попадать в итоги: иначе подобранное «сейчас»
    // не видно нигде до выхода из карты, и экран кажется замершим.
    const openFarming = open && !open.isHub ? open : null;
    const openElapsed =
      openFarming && !isPrisonRun(openFarming)
        ? activeDuration(openFarming, undefined, Date.now())
        : 0;
    const counted = openFarming ? [...farming, openFarming] : farming;

    let unpricedDrops = 0;
    for (const r of counted) {
      const priceOf = pricesFor(pricing, r);
      for (const d of r.drops) if (priceOf(d.configBaseId) === null) unpricedDrops++;
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

    // Итог сессии — вместе с тюрьмой, время и темп — без неё.
    const sessionRated = sessionCounted.filter((r) => !isPrisonRun(r));
    const sessionPrison = sessionCounted.filter(isPrisonRun);
    const prisonFe = sessionPrison.reduce((a, r) => a + runNet(r, pricing), 0);
    const inMapMs =
      sessionFarming.reduce((a, r) => a + (isPrisonRun(r) ? 0 : activeDuration(r)), 0) +
      openElapsed;
    const valueFe = sessionCounted.reduce((a, r) => a + runValue(r, pricing), 0);
    const costFe = sessionCounted.reduce((a, r) => a + runCost(r, pricing), 0);

    // Статус — про игру, а не про фильтр: на карте другим персонажем
    // «Ждём вход на карту» было бы неправдой.
    const status: Snapshot['status'] = liveOpen && !liveOpen.isHub ? 'running' : 'idle';

    return {
      status,
      hint: this.hintFor(status),
      lastActivityAt: this.lastActivityAt,
      logDir: this.logDir,
      seasonId: this.seasonId,
      seasonName: seasonName(this.seasonId),
      allSeasons: this.allSeasons,
      otherSeasonRuns:
        this.seasonId === null
          ? 0
          : allRuns.filter((r) => isFarmingRun(r) && this.seasonOf(r) !== this.seasonId).length,
      player: this.playerView(),
      players: this.playerOptions(allRuns),
      playerFilter: this.playerFilter,
      current: open && !open.isHub ? this.toView(open) : null,
      recent: rated
        .slice(-25)
        .reverse()
        .map((r) => this.toView(r)),
      rate: summarize(netRates),
      feRate: summarize(feRates),
      liveRate: perHour(valueFe - costFe - prisonFe, inMapMs),
      norm: rollingNorm(netRates),
      jackpotAutoFe: this.jackpotAutoFe(),
      strategies: groupByStrategy(rated, pricing)
        .filter((s) => s.runs >= 2)
        .slice(0, 6)
        .map((s) => ({
          ...s,
          title: this.strategyTitle(s.costItems),
          costItems: s.costItems.map((id) => ({
            configBaseId: id,
            name: this.displayName(id),
            icon: this.items.get(id)?.icon ? iconUrl(id) : null,
          })),
        })),
      maps: groupByMap(rated, (r) => this.mapName(r.asset, r.areaId), pricing).slice(0, 8),
      days: dailyTotals(farming, pricing, 14, Date.now()),
      sessions: sessionTotals(this.sessions, farming, pricing).slice(0, 10),
      bag: this.bagView(),
      minDropFe: this.minDropFe,
      // «Пробить цену» — только про текущий сезон: рынок прошлого закрыт,
      // и пробить там уже нечего.
      missing: missingPrices(
        counted.filter((r) => this.isCurrentSeason(r)),
        this.priceOf,
      )
        .slice(0, 8)
        .map((m) => ({
          ...m,
          name: this.displayName(m.configBaseId),
          icon: this.items.get(m.configBaseId)?.icon ? iconUrl(m.configBaseId) : null,
        })),
      sessionTop: topDrops(sessionRated, pricing).map((t) => ({
        configBaseId: t.configBaseId,
        name: this.displayName(t.configBaseId),
        icon: this.items.get(t.configBaseId)?.icon ? iconUrl(t.configBaseId) : null,
        qty: t.qty,
        totalFe: t.totalFe,
        at: t.at,
        runName: this.runName(t.run),
      })),
      prison: { netFe: prisonFe, runs: sessionPrison.length },
      session: {
        startedAt: this.sessionStartedAt,
        previous: this.previousSummary(farming, pricing),
      },
      totals: {
        runs: sessionRated.length,
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

  /**
   * Границы выбранного сезона во времени — по его забегам. Текущий сезон
   * открыт справа; все сезоны — без границ.
   */
  private seasonBounds(allRuns: Run[], liveOpen: Run | null): { from: number; to: number } {
    const season = this.scopeSeason();
    if (season === null) return { from: -Infinity, to: Infinity };
    let from = Infinity;
    let to = -Infinity;
    for (const r of liveOpen ? [...allRuns, liveOpen] : allRuns) {
      if (this.seasonOf(r) !== season) continue;
      from = Math.min(from, r.startedAt);
      to = Math.max(to, runEnd(r));
    }
    // У сезона ещё нет забегов — значит, и торговли в его границах не видно:
    // иначе в первые минуты сезона блок биржи показывал бы прошлый.
    if (from === Infinity) return { from: Infinity, to: Infinity };
    return { from, to: season === this.seasonId ? Infinity : to };
  }

  /** Итог последней закрытой сессии по её границам во времени. */
  private previousSummary(
    farming: Run[],
    pricing: RunPricing,
  ): { netFe: number; inMapMs: number; runs: number } | null {
    const prev = this.previousSession;
    if (!prev) return null;
    const runs = farming.filter((r) => runEnd(r) >= prev.startedAt && runEnd(r) < prev.endedAt);
    if (runs.length === 0) return null;
    return {
      netFe: runs.reduce((a, r) => a + runNet(r, pricing), 0),
      inMapMs: runs.reduce((a, r) => a + (isPrisonRun(r) ? 0 : activeDuration(r)), 0),
      runs: runs.filter((r) => !isPrisonRun(r)).length,
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
    // Сначала персонажи текущего сезона: прошлые остаются в списке,
    // но ниже — к ним возвращаются редко.
    const current = (p: PlayerProfile) => (p.seasonId === this.seasonId ? 1 : 0);
    return [...this.knownPlayers.values()]
      .sort((a, b) => current(b) - current(a) || b.lastSeenAt - a.lastSeenAt)
      .map((p) => ({ ...toPlayerView(p), runs: counts.get(p.playerId) ?? 0 }));
  }

  private jackpotAutoCache: { key: string; value: number } | null = null;

  /**
   * P95 известных цен: свои пробивки плюс база сообщества. Кэш по размерам
   * обоих источников — снапшот собирается часто, сортировать двухтысячный
   * список каждые 300 мс незачем.
   */
  private jackpotAutoFe(): number {
    const key = `${this.seasonId}:${this.prices.size}:${this.communityEnabled ? this.community.size : 0}`;
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
      return tr(
        'Лог не читается. В игре: Настройки → Другое → Включить лог, затем перезайти персонажем.',
        'The log is not readable. In game: Settings → Other → Enable log, then re-enter with your character.',
      );
    }
    if (this.lastActivityAt === 0) return tr('Игра не запущена.', 'The game is not running.');
    if (Date.now() - this.lastActivityAt > 120_000) {
      return tr(
        'Игра давно ничего не пишет в лог — похоже, закрыта.',
        'The game has not written to the log for a while — it seems to be closed.',
      );
    }
    return tr('Ждём вход на карту.', 'Waiting for you to enter a map.');
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
    for (const past of this.pastSeasons.values()) past.community?.stop();
    this.tailer?.stop();
    this.persistFinished();
    this.storage.close();
  }
}

/** Профиль → вид для интерфейса. */
/** Цены прошлого сезона: свои пробивки и база сообщества того сезона. */
interface PastSeasonPrices {
  own: PriceStore;
  /** null — цены сообщества выключены или ещё не запрашивались. */
  community: CommunityPriceFeed | null;
  lookup: PriceLookup;
}

function toPlayerView(p: PlayerProfile): PlayerView {
  return {
    playerId: p.playerId,
    // Решёточный суффикс — дискриминатор аккаунта, на экране он шум.
    name: p.name ? p.name.replace(/#\d+$/, '') : null,
    heroName: heroName(p.heroId),
    level: p.level,
    seasonId: p.seasonId,
    seasonName: seasonName(p.seasonId),
  };
}

/**
 * Названия планов Инобытия в именительном падеже.
 *
 * В словаре они стоят в родительном, потому что там это часть названия
 * маячка: «Маячок Ледяной бездны». Для заголовка карты нужен именительный,
 * автоматически такое преобразование не сделать — отсюда таблица.
 * Сами формулировки взяты из словаря, а не придуманы: раньше здесь было
 * «Пустоши бездны» вместо «Пустотные земли».
 */
const PLANES: Array<[RegExp, string, string]> = [
  [/Ледяной бездны|Glacial Abyss/i, 'Ледяная бездна', 'Glacial Abyss'],
  [/Кипящей лавы|Blistering Lava/i, 'Кипящая лава', 'Blistering Lava Sea'],
  [/Стальной кузницы|Steel Forge/i, 'Стальная кузница', 'Steel Forge'],
  [/Громовых пустошей|Thunder Waste/i, 'Громовые пустоши', 'Thunder Wastes'],
  [/Пустотных земель|Voidlands/i, 'Пустотные земли', 'Voidlands'],
  [/Дальний космос|Deep Space/i, 'Дальний космос', 'Deep Space'],
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
  // Английские названия — из справочника предметов, а не перевод.
  const name = tr(plane[1], plane[2]);
  return number ? tr(`${name} · метка ${number}`, `${name} · Timemark ${number}`) : name;
}

/**
 * Имя карты, которой нет в справочнике: очищенный ассет (YL_MaNeiLaYuLin100 →
 * MaNeiLaYuLin), а не «зона 5348». Игровые названия — Engine.mapName.
 */
function assetName(asset: string | null, areaId: number): string {
  if (!asset) return tr(`Зона ${areaId}`, `Zone ${areaId}`);
  const cleaned = asset
    // Префикс папки бывает любой длины: XZ_, SD_, JH_, KD_.
    .replace(/^[A-Z]{2,4}_/, '')
    // Хвостовой номер экземпляра карты.
    .replace(/\d+$/, '')
    // После снятия номера может остаться висящий разделитель:
    // JH_YWMD_00001 превращался в «YWMD_».
    .replace(/[_\s-]+$/, '');
  return cleaned || tr(`Зона ${areaId}`, `Zone ${areaId}`);
}
