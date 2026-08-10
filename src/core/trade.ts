import { FE_ID, type ConfigBaseId, type ItemDelta } from './types.js';

/**
 * Учёт операций с биржей.
 *
 * Что даёт лог:
 *   XchgForSale  — предмет уходит из сумки, видно id и количество
 *   XchgReceive  — на счёт приходит ФЕ, видно сумму
 *   XchgBuy      — покупка, ФЕ уходит
 *
 * Чего лог НЕ даёт: сокет-дампы есть только у GetPlayerData и XchgSearchPrice,
 * поэтому у поступления денег нет пометки, за какой именно предмет оно пришло.
 *
 * Отсюда решение: не выдумывать атрибуцию по предметам, а считать
 * коэффициент реализации за период — сколько ФЕ реально пришло по отношению
 * к бумажной оценке того, что было выставлено. Это честно и проверяемо.
 *
 * Ни один известный трекер жанра не считает реализованную выручку вообще:
 * все оценивают лут по ценам активных лотов, то есть по бумаге.
 */

export interface Listing {
  ts: number;
  configBaseId: ConfigBaseId;
  qty: number;
}

export interface Receipt {
  ts: number;
  /** Сколько ФЕ пришло. Уже за вычетом комиссии биржи. */
  fe: number;
}

export interface Purchase {
  ts: number;
  configBaseId: ConfigBaseId;
  qty: number;
  /** Сколько ФЕ ушло, если это видно в той же транзакции. */
  feSpent: number;
}

export interface RealizationSummary {
  /** Реально полученные ФЕ за период. */
  realizedFe: number;
  /** Бумажная оценка выставленного за период. */
  paperFe: number;
  /** realizedFe / paperFe. null, если нечего сравнивать. */
  ratio: number | null;
  listings: number;
  receipts: number;
  /** Предметы, у которых нет цены — бумажная оценка занижена на них. */
  unpricedItems: ConfigBaseId[];
}

/**
 * Слияние списков событий с дедупликацией по ключу, но БЕЗ схлопывания
 * законных повторов: две одинаковые выплаты в одну миллисекунду — это
 * две выплаты (выкуп двух одинаковых лотов), а один и тот же файл,
 * прочитанный дважды после ротации, — по-прежнему один набор событий.
 * Поэтому по каждому ключу берётся МАКСИМУМ вхождений среди источников.
 */
export function mergeByKey<T>(sources: T[][], keyOf: (item: T) => string): T[] {
  const best = new Map<string, T[]>();
  for (const source of sources) {
    const grouped = new Map<string, T[]>();
    for (const item of source) {
      const key = keyOf(item);
      const list = grouped.get(key);
      if (list) list.push(item);
      else grouped.set(key, [item]);
    }
    for (const [key, list] of grouped) {
      const existing = best.get(key);
      if (!existing || list.length > existing.length) best.set(key, list);
    }
  }
  return [...best.values()].flat();
}

export class TradeLedger {
  readonly listings: Listing[] = [];
  readonly receipts: Receipt[] = [];
  readonly purchases: Purchase[] = [];

  /** Незакрытая покупка: сначала уходит ФЕ, потом приходит предмет. */
  private pendingSpend = 0;

  add(delta: ItemDelta): void {
    if (delta.kind !== 'trade') return;

    switch (delta.proto) {
      case 'XchgForSale':
        // Предмет ушёл из сумки на витрину.
        if (delta.qty < 0 && delta.configBaseId !== FE_ID) {
          this.listings.push({
            ts: delta.ts,
            configBaseId: delta.configBaseId,
            qty: -delta.qty,
          });
        }
        break;

      case 'XchgReceive':
        // Пришли деньги за проданное.
        if (delta.configBaseId === FE_ID && delta.qty > 0) {
          this.receipts.push({ ts: delta.ts, fe: delta.qty });
        }
        break;

      case 'XchgBuy':
        if (delta.configBaseId === FE_ID && delta.qty < 0) {
          this.pendingSpend += -delta.qty;
        } else if (delta.qty > 0) {
          this.purchases.push({
            ts: delta.ts,
            configBaseId: delta.configBaseId,
            qty: delta.qty,
            feSpent: this.pendingSpend,
          });
          this.pendingSpend = 0;
        }
        break;

      case 'XchgRecall':
        // Лот отозван — предмет вернулся, продажи не было. Выставление
        // при этом снимается с бумажного счёта: иначе отозванный
        // и выставленный заново предмет считался бы дважды, занижая
        // коэффициент реализации.
        if (delta.qty > 0 && delta.configBaseId !== FE_ID) {
          this.removeListing(delta.configBaseId, delta.qty);
        }
        break;

      default:
        break;
    }
  }

  /** Снимает отозванный лот: сначала точное совпадение, затем последний лот предмета. */
  private removeListing(configBaseId: ConfigBaseId, qty: number): void {
    for (let i = this.listings.length - 1; i >= 0; i--) {
      const l = this.listings[i]!;
      if (l.configBaseId !== configBaseId) continue;
      if (l.qty === qty) {
        this.listings.splice(i, 1);
        return;
      }
    }
    for (let i = this.listings.length - 1; i >= 0; i--) {
      const l = this.listings[i]!;
      if (l.configBaseId !== configBaseId) continue;
      if (l.qty > qty) l.qty -= qty;
      else this.listings.splice(i, 1);
      return;
    }
  }

  /**
   * Сводка за период. priceOf возвращает референсную цену предмета в ФЕ
   * или null, если цена неизвестна.
   */
  summarize(
    priceOf: (id: ConfigBaseId) => number | null,
    from = -Infinity,
    to = Infinity,
  ): RealizationSummary {
    const inRange = <T extends { ts: number }>(x: T) => x.ts >= from && x.ts <= to;

    const listings = this.listings.filter(inRange);
    const receipts = this.receipts.filter(inRange);

    let paperFe = 0;
    const unpriced = new Set<ConfigBaseId>();
    for (const l of listings) {
      const price = priceOf(l.configBaseId);
      if (price === null) unpriced.add(l.configBaseId);
      else paperFe += price * l.qty;
    }

    const realizedFe = receipts.reduce((a, r) => a + r.fe, 0);

    return {
      realizedFe,
      paperFe,
      ratio: paperFe > 0 ? realizedFe / paperFe : null,
      listings: listings.length,
      receipts: receipts.length,
      unpricedItems: [...unpriced],
    };
  }
}
