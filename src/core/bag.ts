import type { PriceLookup } from './analysis.js';
import { FE_ID, type ConfigBaseId } from './types.js';

export interface BagItemValue {
  configBaseId: ConfigBaseId;
  qty: number;
  totalFe: number;
}

export interface BagValue {
  /** Оценка всего оценённого, включая сами ФЕ. */
  valueFe: number;
  /** ФЕ на руках — отдельно: это деньги, а не оценка. */
  feCash: number;
  /** Разных предметов без цены: на них оценка занижена. */
  unpriced: number;
  /** Самое ценное, кроме ФЕ, по убыванию. */
  top: BagItemValue[];
}

/**
 * Стоимость сумки по ценам. Как у Exilence и TITrack, но с той же
 * честностью, что и везде: неоценённое не прячется, а считается.
 */
export function bagValue(
  contents: Map<ConfigBaseId, number>,
  priceOf: PriceLookup,
  limit = 6,
): BagValue {
  let valueFe = 0;
  let unpriced = 0;
  const items: BagItemValue[] = [];
  for (const [configBaseId, qty] of contents) {
    if (qty <= 0) continue;
    const price = priceOf(configBaseId);
    if (price === null) {
      unpriced++;
      continue;
    }
    const totalFe = price * qty;
    valueFe += totalFe;
    if (configBaseId !== FE_ID && totalFe > 0) items.push({ configBaseId, qty, totalFe });
  }
  items.sort((a, b) => b.totalFe - a.totalFe);
  return { valueFe, feCash: contents.get(FE_ID) ?? 0, unpriced, top: items.slice(0, limit) };
}
