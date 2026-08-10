import { percentile } from './stats.js';
import { BOUND_ID_OFFSET, FE_ID, type ConfigBaseId, type PriceObservationEvent } from './types.js';

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
  /** Референсная цена в ФЭ. */
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
    // Лоты за другую валюту к оценке в ФЭ не приводятся.
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
   * Цена предмета в ФЭ.
   *
   * ФЭ стоит сам себя. Связанные варианты (id базового + 1000) стоят ноль:
   * их нельзя продать, и засчитывать их в доход — значит завышать цифры.
   */
  priceOf(configBaseId: ConfigBaseId): number | null {
    if (configBaseId === FE_ID) return 1;
    if (this.isBound(configBaseId)) return 0;
    return this.prices.get(configBaseId)?.fe ?? null;
  }

  /** Связанный вариант существует, если есть базовый предмет с id на 1000 меньше. */
  private isBound(configBaseId: ConfigBaseId): boolean {
    return this.boundIds.has(configBaseId);
  }

  private boundIds = new Set<ConfigBaseId>();

  /** Регистрирует, какие id считаются связанными, по справочнику предметов. */
  registerKnownItems(ids: Iterable<ConfigBaseId>): void {
    const all = new Set(ids);
    for (const id of all) {
      const bound = id + BOUND_ID_OFFSET;
      if (all.has(bound)) this.boundIds.add(bound);
    }
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
