import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ConfigBaseId } from '../core/types.js';

/**
 * Первичные цены из краудсорс-базы TITrack (titrack.ninja).
 *
 * Решает главную боль трекера: без этого каждый предмет надо один раз
 * пробить в Торговом доме руками, иначе у него нет цены. Здесь же цены
 * приезжают сразу для ~2000 предметов текущего сезона.
 *
 * Как устроен источник:
 *  - TITrack (MIT) собирает те же пробивки XchgSearchPrice со своих
 *    пользователей и агрегирует медианой; ключ доступа — публичный
 *    (publishable), анонимное чтение предусмотрено самим проектом,
 *    на нём работает их сайт titrack.ninja.
 *  - Предметы ключуются родным ConfigBaseId игры — тем же, что у нас
 *    в логе. Сопоставления по названиям нет вообще.
 *  - Сезон — тот же season_id, что мы парсим из лога (+SeasonId [1501]).
 *
 * Правила вежливости к чужому бесплатному серверу:
 *  - первый заход — полная выборка, дальше только дельта по updated_at;
 *  - период опроса не чаще, чем у самого TITrack (5 минут) — у нас 15;
 *  - при любой ошибке молча живём на кэше: это дополнение, а не зависимость.
 *
 * Собственная пробивка игрока ВСЕГДА перекрывает цену сообщества —
 * приоритет решается на стороне Engine, здесь только доставка.
 */

const BASE_URL = 'https://qhjulyngunwiculnharg.supabase.co';
/** Публичный (publishable) ключ из открытого кода TITrack — не секрет. */
const ANON_KEY = 'sb_publishable_YgqYSMUarrM_IKvcNpJlBw_KwTpp7ho';

const PAGE_SIZE = 1000;
export const REFRESH_INTERVAL_MS = 15 * 60_000;
/** Рынок прошлого сезона закрыт: его цены сверяются не чаще раза в сутки. */
export const PAST_SEASON_REFRESH_MS = 24 * 3_600_000;

export interface CommunityPrice {
  configBaseId: ConfigBaseId;
  /** Медиана референсных цен, присланных участниками, в ФЕ. */
  fe: number;
  /** 10-й перцентиль присланных цен — нижняя оценка. */
  p10: number;
  /** Сколько пробивок легло в агрегат. */
  submissions: number;
  /** Сколько разных устройств прислали цену: 1 — верить осторожно. */
  devices: number;
  updatedAt: string;
}

interface WireRow {
  config_base_id: number;
  price_fe_median: number;
  price_fe_p10: number;
  submission_count: number;
  unique_devices: number;
  updated_at: string;
}

interface CacheFile {
  seasonId: number;
  fetchedAt: string;
  /** Верхняя граница updated_at из уже полученных строк — курсор дельты. */
  cursor: string | null;
  prices: CommunityPrice[];
}

export class CommunityPriceFeed {
  private prices = new Map<ConfigBaseId, CommunityPrice>();
  private cursor: string | null = null;
  private seasonId: number | null = null;
  private cachePath: string;
  private timer: NodeJS.Timeout | null = null;
  private listeners: Array<(prices: Map<ConfigBaseId, CommunityPrice>) => void> = [];
  /** Когда цены последний раз успешно сверялись с сетью. */
  private fetchedAt: number | null = null;
  /** Последняя попытка провалилась — живём на кэше. */
  private refreshFailed = false;

  /**
   * Файл кэша у каждой ленты свой: лента текущего сезона перезаписывает
   * свой кэш при смене сезона, и цены прошлого живут в отдельном файле.
   */
  constructor(cacheDir: string, cacheFile = 'community-prices.json') {
    this.cachePath = join(cacheDir, cacheFile);
  }

  onUpdate(listener: (prices: Map<ConfigBaseId, CommunityPrice>) => void): void {
    this.listeners.push(listener);
  }

  get size(): number {
    return this.prices.size;
  }

  /** Для самодиагностики: когда цены сверялись с сетью в последний раз. */
  get fetchedAtMs(): number | null {
    return this.fetchedAt;
  }

  /** Для самодиагностики: сеть недоступна, показываем данные из кэша. */
  get stale(): boolean {
    return this.refreshFailed;
  }

  priceOf(configBaseId: ConfigBaseId): CommunityPrice | null {
    return this.prices.get(configBaseId) ?? null;
  }

  all(): CommunityPrice[] {
    return [...this.prices.values()];
  }

  /**
   * Запускает цикл: кэш → полная выборка или дельта → опрос раз в 15 минут.
   * Сезон обязателен: цены прошлых сезонов бессмысленны и вредны.
   */
  start(seasonId: number): void {
    this.stop();
    this.switchSeason(seasonId);
    this.loadCache(seasonId);
    if (this.prices.size > 0) this.notify();

    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    // Не держим процесс живым ради опроса цен.
    this.timer.unref?.();
  }

  /**
   * Разовая загрузка без опроса — для прошлого сезона: забеги того сезона
   * оцениваются его ценами, а рынок уже не движется. Свежий кэш в сеть
   * не ходит вовсе.
   */
  loadOnce(seasonId: number): void {
    this.stop();
    this.switchSeason(seasonId);
    this.loadCache(seasonId);
    if (this.prices.size > 0) this.notify();
    if (this.fetchedAt === null || Date.now() - this.fetchedAt > PAST_SEASON_REFRESH_MS) {
      void this.refresh();
    }
  }

  /**
   * Смена сезона сбрасывает всё полученное: без этого цены прошлого сезона
   * доживали в ленте до перезапуска, перекрывая предметы, которых новый
   * сезон ещё не знает.
   */
  private switchSeason(seasonId: number): void {
    if (this.seasonId === seasonId) return;
    this.seasonId = seasonId;
    this.prices.clear();
    this.cursor = null;
    this.fetchedAt = null;
    this.refreshFailed = false;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private notify(): void {
    for (const l of this.listeners) l(this.prices);
  }

  private loadCache(seasonId: number): void {
    try {
      if (!existsSync(this.cachePath)) return;
      const raw = JSON.parse(readFileSync(this.cachePath, 'utf8')) as CacheFile;
      // Кэш другого сезона не поднимаем: лучше без цен, чем с прошлогодними.
      if (raw.seasonId !== seasonId || !Array.isArray(raw.prices)) return;
      for (const p of raw.prices) this.prices.set(p.configBaseId, p);
      this.cursor = raw.cursor;
      const parsed = Date.parse(raw.fetchedAt);
      if (Number.isFinite(parsed)) this.fetchedAt = parsed;
    } catch {
      // Битый кэш — не повод падать, просто сходим за полной выборкой.
      this.cursor = null;
    }
  }

  private saveCache(): void {
    if (this.seasonId === null) return;
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      const data: CacheFile = {
        seasonId: this.seasonId,
        fetchedAt: new Date().toISOString(),
        cursor: this.cursor,
        prices: [...this.prices.values()],
      };
      writeFileSync(this.cachePath, JSON.stringify(data), 'utf8');
    } catch {
      // Кэш — оптимизация; без него следующий запуск просто скачает всё заново.
    }
  }

  /** Одна страница из PostgREST. Диапазон задаётся заголовком Range. */
  private async fetchPage(offset: number, since: string | null): Promise<WireRow[]> {
    // Вторичная сортировка по id: у пачки строк updated_at совпадает
    // (агрегат пересчитывается разом), и без неё порядок между страницами
    // нестабилен — строки терялись бы или приходили дважды.
    const filters = [
      `season_id=eq.${this.seasonId}`,
      'order=updated_at.asc,config_base_id.asc',
    ];
    if (since) filters.push(`updated_at=gt.${encodeURIComponent(since)}`);
    const url =
      `${BASE_URL}/rest/v1/aggregated_prices` +
      `?select=config_base_id,price_fe_median,price_fe_p10,submission_count,unique_devices,updated_at` +
      `&${filters.join('&')}`;

    const res = await fetch(url, {
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
        Range: `${offset}-${offset + PAGE_SIZE - 1}`,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`community prices: HTTP ${res.status}`);
    }
    return (await res.json()) as WireRow[];
  }

  /**
   * Дельта-обновление. Возвращает количество новых/изменённых цен.
   * Все ошибки глотаются: сеть может отсутствовать, сервер — переехать.
   */
  async refresh(): Promise<number> {
    if (this.seasonId === null) return 0;
    try {
      const since = this.cursor;
      let offset = 0;
      let changed = 0;

      for (;;) {
        const rows = await this.fetchPage(offset, since);
        for (const row of rows) {
          if (
            typeof row.config_base_id !== 'number' ||
            typeof row.price_fe_median !== 'number' ||
            row.price_fe_median <= 0
          ) {
            continue;
          }
          this.prices.set(row.config_base_id, {
            configBaseId: row.config_base_id,
            fe: row.price_fe_median,
            p10: row.price_fe_p10,
            submissions: row.submission_count,
            devices: row.unique_devices,
            updatedAt: row.updated_at,
          });
          if (this.cursor === null || row.updated_at > this.cursor) {
            this.cursor = row.updated_at;
          }
          changed++;
        }
        if (rows.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }

      // Успешная сверка — свежесть, даже если новых цен не пришло.
      this.fetchedAt = Date.now();
      this.refreshFailed = false;
      if (changed > 0) {
        this.saveCache();
      }
      // Слушатели узнают и про «без изменений»: самодиагностика показывает
      // время сверки, и оно должно обновляться.
      this.notify();
      return changed;
    } catch {
      // Живём на том, что есть: кэш или пусто. Это дополнение, а не база.
      this.refreshFailed = true;
      this.notify();
      return 0;
    }
  }
}
