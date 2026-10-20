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

/** Отзыв лота: предмет вернулся с витрины в сумку, продажи не было. */
export interface Recall {
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

/** Ключ отзыва для слияния источников (mergeByKey). */
export function recallKey(r: Recall): string {
  return `${r.ts}:${r.configBaseId}:${r.qty}`;
}

/**
 * Действующие лоты: выставления минус отзывы, по порядку времени. Отзыв
 * снимает сначала лот с тем же количеством, иначе уменьшает последний лот
 * предмета, выставленный до него.
 *
 * Выставления и отзывы хранятся как есть, событиями. Раньше отзыв правил
 * лот на месте, только в памяти: в базе строка оставалась, и при следующем
 * запуске слияние с базой воскрешало отозванный лот, а частично отозванный
 * (другое количество — другой ключ) задваивало.
 */
export function applyRecalls(listings: Listing[], recalls: Recall[]): Listing[] {
  if (recalls.length === 0) return listings;
  const active = [...listings].sort((a, b) => a.ts - b.ts).map((l) => ({ ...l }));
  const ordered = [...recalls].sort((a, b) => a.ts - b.ts);
  for (const recall of ordered) {
    // Отзывать можно только то, что уже выставлено.
    let upto = active.length;
    while (upto > 0 && active[upto - 1]!.ts > recall.ts) upto--;
    removeListing(active, upto, recall.configBaseId, recall.qty);
  }
  return active;
}

function removeListing(
  listings: Listing[],
  upto: number,
  configBaseId: ConfigBaseId,
  qty: number,
): void {
  for (let i = upto - 1; i >= 0; i--) {
    const l = listings[i]!;
    if (l.configBaseId !== configBaseId) continue;
    if (l.qty === qty) {
      listings.splice(i, 1);
      return;
    }
  }
  for (let i = upto - 1; i >= 0; i--) {
    const l = listings[i]!;
    if (l.configBaseId !== configBaseId) continue;
    if (l.qty > qty) l.qty -= qty;
    else listings.splice(i, 1);
    return;
  }
}

export class TradeLedger {
  /** Все выставления как были — без учёта отзывов (см. activeListings). */
  readonly listings: Listing[] = [];
  readonly recalls: Recall[] = [];
  readonly receipts: Receipt[] = [];
  readonly purchases: Purchase[] = [];

  /** Действующие лоты: выставления за вычетом отзывов. */
  activeListings(): Listing[] {
    return applyRecalls(this.listings, this.recalls);
  }

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
          this.recalls.push({ ts: delta.ts, configBaseId: delta.configBaseId, qty: delta.qty });
        }
        break;

      default:
        break;
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

    const listings = this.activeListings().filter(inRange);
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
