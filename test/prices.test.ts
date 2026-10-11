import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { bagValue } from '../src/core/bag.js';
import { PriceStore, priceTrend } from '../src/core/priceStore.js';
import { FE_ID } from '../src/core/types.js';
import { Storage } from '../src/storage/db.js';

const DAY = 86_400_000;
const NOW = 1_790_000_000_000;

describe('тренд цены', () => {
  it('изменение — к самой ранней пробивке в пределах недели', () => {
    const trend = priceTrend([
      { t: NOW - 20 * DAY, fe: 100 },
      { t: NOW - 6 * DAY, fe: 40 },
      { t: NOW - 2 * DAY, fe: 45 },
      { t: NOW, fe: 50 },
    ]);
    expect(trend.change).toBeCloseTo(0.25);
    expect(trend.points.map((p) => p.fe)).toEqual([100, 40, 45, 50]);
  });

  it('без пробивок в пределах недели сравнивать не с чем', () => {
    expect(priceTrend([{ t: NOW - 20 * DAY, fe: 100 }, { t: NOW, fe: 50 }]).change).toBeNull();
    expect(priceTrend([{ t: NOW, fe: 50 }]).change).toBeNull();
    expect(priceTrend([])).toEqual({ points: [], change: null });
  });

  it('спарклайн — только последний месяц, порядок по времени', () => {
    const trend = priceTrend([
      { t: NOW, fe: 3 },
      { t: NOW - 40 * DAY, fe: 1 },
      { t: NOW - DAY, fe: 2 },
    ]);
    expect(trend.points.map((p) => p.fe)).toEqual([2, 3]);
  });
});

describe('стоимость сумки', () => {
  const prices: Record<number, number> = { [FE_ID]: 1, 10022: 34, 100200: 0.12 };
  const priceOf = (id: number) => prices[id] ?? null;

  it('всё по ценам, ФЕ отдельно, неоценённое считается', () => {
    const bag = bagValue(
      new Map([
        [FE_ID, 6655],
        [10022, 2],
        [100200, 100],
        [999, 5],
        [998, 0],
      ]),
      priceOf,
    );
    expect(bag.valueFe).toBeCloseTo(6655 + 68 + 12);
    expect(bag.feCash).toBe(6655);
    expect(bag.unpriced).toBe(1);
    expect(bag.top.map((i) => i.configBaseId)).toEqual([10022, 100200]);
  });
});

describe('история пробивок', () => {
  const observe = (store: PriceStore, ts: number, price: number) =>
    store.observe({
      kind: 'priceObservation',
      ts,
      line: 0,
      configBaseId: 10022,
      currency: FE_ID,
      unitPrices: [price],
      synId: 1,
    });

  it('PriceStore отдаёт все наблюдения, а не только последнее', () => {
    const store = new PriceStore(1501);
    observe(store, NOW - DAY, 30);
    observe(store, NOW, 34);
    expect(store.all()).toHaveLength(1);
    expect(store.observations().map((r) => r.fe)).toEqual([30, 34]);
  });

  it('база хранит каждую пробивку и отдаёт их по времени', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gorn-'));
    const db = new Storage(join(dir, 'test.db'));
    try {
      const store = new PriceStore(1501);
      observe(store, NOW, 34);
      observe(store, NOW - 2 * DAY, 30);
      observe(store, NOW - 40 * DAY, 20);
      db.savePrices(store.observations());
      expect(db.priceHistory(10022)).toEqual([
        { t: NOW - 40 * DAY, fe: 20 },
        { t: NOW - 2 * DAY, fe: 30 },
        { t: NOW, fe: 34 },
      ]);
      // Лимит берёт свежие, порядок — по времени.
      expect(db.priceHistory(10022, 2)).toEqual([
        { t: NOW - 2 * DAY, fe: 30 },
        { t: NOW, fe: 34 },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
