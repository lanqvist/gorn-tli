import { describe, expect, it } from 'vitest';

import { EventParser } from '../src/core/eventParser.js';
import { InventoryTracker } from '../src/core/inventory.js';
import { PriceStore, isBoundName, referencePrice } from '../src/core/priceStore.js';
import { TradeLedger, mergeByKey } from '../src/core/trade.js';
import { FE_ID, type Diagnostics } from '../src/core/types.js';

function diag(): Diagnostics {
  return {
    linesTotal: 0,
    linesMatched: 0,
    unknownProtos: new Map(),
    unknownItemIds: new Map(),
    slotRebases: 0,
  };
}

const L = (body: string) => `[2026.08.10-10.21.53:681][427]TLLua: Display: [Game] ${body}`;

describe('очистка слота восстанавливает, что в нём лежало', () => {
  it('выставление лота видно как уход предмета, хотя строка лога не содержит id', () => {
    // BagMgr@:RemoveBagItem не несёт ConfigBaseId — предмет берётся из состояния.
    const parser = new EventParser();
    const inv = new InventoryTracker(diag());
    const ledger = new TradeLedger();

    inv.beginTransaction('PickItem');
    inv.applyInit(
      parser.parse(
        L('BagMgr@:InitBagData PageId = 100 SlotId = 5 ConfigBaseId = 10042 Num = 3'),
      ) as never,
    );

    inv.beginTransaction('XchgForSale');
    const delta = inv.applyRemove(
      parser.parse(L('BagMgr@:RemoveBagItem PageId = 100 SlotId = 5')) as never,
    );

    expect(delta).not.toBeNull();
    expect(delta!.configBaseId).toBe(10042);
    expect(delta!.qty).toBe(-3);

    ledger.add(delta!);
    expect(ledger.listings).toEqual([{ ts: delta!.ts, configBaseId: 10042, qty: 3 }]);
  });

  it('очистка неизвестного слота ничего не выдумывает', () => {
    const parser = new EventParser();
    const inv = new InventoryTracker(diag());
    inv.beginTransaction('XchgForSale');
    expect(
      inv.applyRemove(parser.parse(L('BagMgr@:RemoveBagItem PageId = 100 SlotId = 9')) as never),
    ).toBeNull();
  });
});

describe('реализованная выручка', () => {
  it('поступления ФЕ по XchgReceive складываются', () => {
    const ledger = new TradeLedger();
    // Подлинная последовательность из лога: 6655 → 6673 → 6698 → 6719.
    for (const qty of [18, 25, 21]) {
      ledger.add({
        ts: 1,
        configBaseId: FE_ID,
        qty,
        proto: 'XchgReceive',
        kind: 'trade',
        pageId: 102,
        slotId: 0,
      });
    }
    const s = ledger.summarize(() => null);
    expect(s.realizedFe).toBe(64);
    expect(s.receipts).toBe(3);
  });

  it('коэффициент реализации сравнивает пришедшее с бумажной оценкой', () => {
    const ledger = new TradeLedger();
    ledger.add({
      ts: 1,
      configBaseId: 10042,
      qty: -10,
      proto: 'XchgForSale',
      kind: 'trade',
      pageId: 100,
      slotId: 0,
    });
    ledger.add({
      ts: 2,
      configBaseId: FE_ID,
      qty: 80,
      proto: 'XchgReceive',
      kind: 'trade',
      pageId: 102,
      slotId: 0,
    });

    // Выставлено 10 штук по бумажной цене 10 ФЕ = 100, пришло 80.
    const s = ledger.summarize((id) => (id === 10042 ? 10 : null));
    expect(s.paperFe).toBe(100);
    expect(s.realizedFe).toBe(80);
    expect(s.ratio).toBeCloseTo(0.8, 5);
  });

  it('предметы без цены отмечаются, а не считаются бесплатными молча', () => {
    const ledger = new TradeLedger();
    ledger.add({
      ts: 1,
      configBaseId: 55555,
      qty: -1,
      proto: 'XchgForSale',
      kind: 'trade',
      pageId: 100,
      slotId: 0,
    });
    const s = ledger.summarize(() => null);
    expect(s.unpricedItems).toEqual([55555]);
    expect(s.ratio).toBeNull();
  });
});

describe('слияние торговых событий', () => {
  it('перекрывающиеся файлы не задваивают выплаты', () => {
    const fileA = [
      { ts: 1, fe: 100 },
      { ts: 2, fe: 50 },
    ];
    const fileB = [
      { ts: 2, fe: 50 },
      { ts: 3, fe: 70 },
    ];
    const merged = mergeByKey([fileA, fileB], (r) => `${r.ts}:${r.fe}`);
    expect(merged).toHaveLength(3);
    expect(merged.reduce((a, r) => a + r.fe, 0)).toBe(220);
  });

  it('две одинаковые выплаты в одну миллисекунду не схлопываются', () => {
    // Выкуп двух одинаковых лотов — две выплаты, а не одна.
    const receipts = [
      { ts: 5, fe: 30 },
      { ts: 5, fe: 30 },
    ];
    const merged = mergeByKey([receipts], (r) => `${r.ts}:${r.fe}`);
    expect(merged).toHaveLength(2);
  });

  it('отзыв лота снимает его с бумажного счёта', () => {
    const ledger = new TradeLedger();
    ledger.add({
      ts: 1,
      configBaseId: 5028,
      qty: -4,
      proto: 'XchgForSale',
      kind: 'trade',
      pageId: 102,
      slotId: 3,
    });
    expect(ledger.listings).toHaveLength(1);

    ledger.add({
      ts: 2,
      configBaseId: 5028,
      qty: 4,
      proto: 'XchgRecall',
      kind: 'trade',
      pageId: 102,
      slotId: 3,
    });
    // Отозванный и выставленный заново лот не должен считаться дважды.
    expect(ledger.activeListings()).toHaveLength(0);
  });
});

describe('референсная цена', () => {
  it('берётся 10-й перцентиль, а не минимум и не среднее', () => {
    // Один демпинговый лот не должен становиться референсом.
    const prices = [1, 20, 20, 21, 22, 22, 23, 24, 25, 100];
    expect(referencePrice(prices)).toBeLessThan(20.5);
    expect(referencePrice(prices)).toBeGreaterThan(1);
  });

  it('ФЕ стоит сам себя', () => {
    expect(new PriceStore().priceOf(FE_ID)).toBe(1);
  });

  it('связанные варианты стоят ноль, их нельзя продать', () => {
    const store = new PriceStore();
    store.registerBoundIds([101300]); // Bound Flame Elementium
    expect(store.priceOf(101300)).toBe(0);
  });

  it('связанность определяется названием, а не арифметикой id', () => {
    // 237 пар id отличаются на 1000, но настоящих связанных из них 13.
    // Старая эвристика «+1000» обнуляла цены обычных легендарок.
    expect(isBoundName('Bound Flame Elementium')).toBe(true);
    expect(isBoundName('绑定初火源质')).toBe(true);
    expect(isBoundName('Связанный: Элементиевое пламя')).toBe(true);
    expect(isBoundName('Grace Boots')).toBe(false);
    expect(isBoundName('Second Divinity')).toBe(false);
    expect(isBoundName(null)).toBe(false);
  });

  it('пробитая игроком цена обычного предмета не обнуляется', () => {
    // Регресс старой эвристики: 112410 Grace Boots попадала в «связанные»,
    // потому что в справочнике существует 111410.
    const store = new PriceStore();
    store.observe({
      kind: 'priceObservation',
      ts: 5,
      line: 1,
      configBaseId: 112410,
      currency: FE_ID,
      unitPrices: [12.5, 13, 20],
      synId: 1,
    });
    expect(store.priceOf(112410)).toBeCloseTo(12.6, 1);
  });

  it('цена в чужой валюте не принимается', () => {
    const store = new PriceStore();
    const accepted = store.observe({
      kind: 'priceObservation',
      ts: 1,
      line: 1,
      configBaseId: 10042,
      currency: 999999,
      unitPrices: [5, 6, 7],
      synId: 1,
    });
    expect(accepted).toBeNull();
    expect(store.priceOf(10042)).toBeNull();
  });
});
