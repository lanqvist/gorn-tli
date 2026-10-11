import { percentile } from './stats.js';
import { FE_ID, type ConfigBaseId, type PriceObservationEvent } from './types.js';

/**
 * Цены берутся из ответов биржи на пробивку: игра пишет в лог цены
 * всех активных лотов по запрошенному предмету.
 *
 * Референсной ценой считаем 10-й перцентиль, а не минимум и не среднее:
 * минимум — это чей-то ошибочный или демпинговый лот, среднее задирают
 * завышенные лоты, которые никто не купит. P10 отражает цену, по которой
 * вещь реально уйдёт в разумный срок. Та же логика у TITrack.
 */

export interface PriceRecord {
  configBaseId: ConfigBaseId;
  /** Референсная цена в ФЕ. */
  fe: number;
  median: number;
  min: number;
  /** Сколько лотов было в выборке. */
  sampleSize: number;
  observedAt: number;
  seasonId: number | null;
}

/** Доля лотов, отсекаемая снизу при выборе референсной цены. */
export const REFERENCE_PERCENTILE = 0.1;

/**
 * Связанный (непередаваемый) предмет опознаётся по названию из справочника:
 * «Bound …» в английском, «绑定…» в китайском, «Связанный: …» в русском.
 */
export function isBoundName(name: string | null | undefined): boolean {
  if (!name) return false;
  return /^Bound\s/i.test(name) || name.startsWith('绑定') || /^Связанн/i.test(name);
}

/**
 * Сколько своя пробивка считается свежей. Цены на бирже TLI плавают
 * за дни: месячная пробивка тихо разводила оценку добычи с рынком,
 * хотя рядом лежала свежая цена сообщества.
 */
export const OWN_PRICE_TTL_MS = 3 * 24 * 3_600_000;

export type PriceSource = 'own' | 'community';

/**
 * Какую цену брать. Своя пробивка — с сервера игрока, поэтому побеждает,
 * пока свежая. Устаревшая уступает цене сообщества, только если та новее,
 * и остаётся в силе, если сообщество про предмет ничего не знает:
 * старая цена лучше никакой.
 *
 * Время сообщества приходит функцией: строку даты разбираем лишь
 * на редком пути «своя устарела», а не на каждом предмете каждого среза.
 */
export function choosePrice(
  own: { fe: number; observedAt: number } | null,
  community: { fe: number; updatedAtMs: () => number } | null,
  now: number,
  ttlMs = OWN_PRICE_TTL_MS,
): { fe: number; source: PriceSource } | null {
  if (own && (!community || now - own.observedAt < ttlMs)) {
    return { fe: own.fe, source: 'own' };
  }
  if (own && community) {
    const updatedAt = community.updatedAtMs();
    if (!Number.isFinite(updatedAt) || updatedAt <= own.observedAt) {
      return { fe: own.fe, source: 'own' };
    }
  }
  return community ? { fe: community.fe, source: 'community' } : null;
}

export function referencePrice(unitPrices: number[]): number {
  const sorted = [...unitPrices].filter((p) => p > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return percentile(sorted, REFERENCE_PERCENTILE);
}

export class PriceStore {
  private prices = new Map<ConfigBaseId, PriceRecord>();
  private history: PriceRecord[] = [];

  constructor(private readonly seasonId: number | null = null) {}

  /** Принимает наблюдение из лога. Более свежее вытесняет более старое. */
  observe(ev: PriceObservationEvent): PriceRecord | null {
    // Лоты за другую валюту к оценке в ФЕ не приводятся.
    if (ev.currency !== FE_ID) return null;

    const sorted = [...ev.unitPrices].filter((p) => p > 0).sort((a, b) => a - b);
    if (sorted.length === 0) return null;

    const record: PriceRecord = {
      configBaseId: ev.configBaseId,
      fe: referencePrice(sorted),
      median: percentile(sorted, 0.5),
      min: sorted[0]!,
      sampleSize: sorted.length,
      observedAt: ev.ts,
      seasonId: this.seasonId,
    };

    const existing = this.prices.get(ev.configBaseId);
    if (!existing || existing.observedAt <= record.observedAt) {
      this.prices.set(ev.configBaseId, record);
    }
    this.history.push(record);
    return record;
  }

  /** Ручная установка цены — для предметов, которые игрок не пробивал. */
  set(configBaseId: ConfigBaseId, fe: number, observedAt: number): void {
    this.prices.set(configBaseId, {
      configBaseId,
      fe,
      median: fe,
      min: fe,
      sampleSize: 0,
      observedAt,
      seasonId: this.seasonId,
    });
  }

  /**
   * Цена предмета в ФЕ.
   *
   * ФЕ стоит сам себя. Связанные варианты (id базового + 1000) стоят ноль:
   * их нельзя продать, и засчитывать их в доход — значит завышать цифры.
   */
  priceOf(configBaseId: ConfigBaseId): number | null {
    if (configBaseId === FE_ID) return 1;
    if (this.isBound(configBaseId)) return 0;
    return this.prices.get(configBaseId)?.fe ?? null;
  }

  /**
   * Цена задана правилом, а не рынком: ФЕ стоит сам себя, связанное — ноль.
   * Такие цены не стареют и ценой сообщества не перекрываются.
   */
  isFixed(configBaseId: ConfigBaseId): boolean {
    return configBaseId === FE_ID || this.isBound(configBaseId);
  }

  private isBound(configBaseId: ConfigBaseId): boolean {
    return this.boundIds.has(configBaseId);
  }

  private boundIds = new Set<ConfigBaseId>();

  /**
   * Регистрирует связанные предметы.
   *
   * Раньше связанность выводилась арифметикой «id = базовый + 1000».
   * Проверка по реальному справочнику показала, что из 237 таких пар
   * настоящих связанных только 13: у легендарок и органов id стоят
   * плотно, и +1000 попадает в соседний обычный предмет. Такому предмету
   * цена обнулялась, а из списка «нет цены» он пропадал — самодиагностика
   * слепла ровно там, где должна была сработать. Поэтому связанность
   * теперь определяет вызывающая сторона по НАЗВАНИЮ из справочника,
   * а здесь хранится только готовое множество id.
   */
  registerBoundIds(ids: Iterable<ConfigBaseId>): void {
    for (const id of ids) this.boundIds.add(id);
  }

  get(configBaseId: ConfigBaseId): PriceRecord | undefined {
    return this.prices.get(configBaseId);
  }

  all(): PriceRecord[] {
    return [...this.prices.values()];
  }

  historyOf(configBaseId: ConfigBaseId): PriceRecord[] {
    return this.history.filter((r) => r.configBaseId === configBaseId);
  }

  get size(): number {
    return this.prices.size;
  }
}
