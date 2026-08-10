import { describe, expect, it } from 'vitest';

import { EventParser } from '../src/core/eventParser.js';
import { InventoryTracker } from '../src/core/inventory.js';
import type { BagInitEvent, BagModifyEvent, Diagnostics } from '../src/core/types.js';

function diag(): Diagnostics {
  return {
    linesTotal: 0,
    linesMatched: 0,
    unknownProtos: new Map(),
    unknownItemIds: new Map(),
    slotRebases: 0,
  };
}

const L = (body: string) => `[2026.08.10-10.04.54:717][838]TLLua: Display: [Game] ${body}`;

function modify(
  parser: EventParser,
  pageId: number,
  slotId: number,
  id: number,
  num: number,
): BagModifyEvent {
  const ev = parser.parse(
    L(`BagMgr@:Modfy BagItem PageId = ${pageId} SlotId = ${slotId} ConfigBaseId = ${id} Num = ${num}`),
  );
  expect(ev?.kind).toBe('bagModify');
  return ev as BagModifyEvent;
}

function init(
  parser: EventParser,
  pageId: number,
  slotId: number,
  id: number,
  num: number,
): BagInitEvent {
  const ev = parser.parse(
    L(`BagMgr@:InitBagData PageId = ${pageId} SlotId = ${slotId} ConfigBaseId = ${id} Num = ${num}`),
  );
  expect(ev?.kind).toBe('bagInit');
  return ev as BagInitEvent;
}

describe('Num — накопительный размер стака, а не прирост', () => {
  it('реальная последовательность ФЭ из лога даёт +44, а не сумму значений', () => {
    // Подлинные данные из UE_game.log за 10 августа, слот page102/slot0.
    const parser = new EventParser();
    const d = diag();
    const inv = new InventoryTracker(d);

    inv.beginTransaction('PickItem');
    inv.applyInit(init(parser, 102, 0, 100300, 6611)); // база из InitBagData

    const gains: number[] = [];
    for (const num of [6616, 6649, 6650, 6653, 6655]) {
      const delta = inv.applyModify(modify(parser, 102, 0, 100300, num));
      if (delta) gains.push(delta.qty);
    }

    expect(gains).toEqual([5, 33, 1, 3, 2]);
    expect(gains.reduce((a, b) => a + b, 0)).toBe(44);
    // Наивное суммирование Num дало бы 33 223 — в 755 раз больше.
  });

  it('первое наблюдение слота задаёт базу и не считается доходом', () => {
    const parser = new EventParser();
    const inv = new InventoryTracker(diag());
    inv.beginTransaction('PickItem');

    // Без этой защиты полный стак из 6611 ФЭ засчитался бы как разовая находка.
    expect(inv.applyModify(modify(parser, 102, 0, 100300, 6611))).toBeNull();
    expect(inv.applyModify(modify(parser, 102, 0, 100300, 6620))?.qty).toBe(9);
  });

  it('смена предмета в слоте перебазирует, а не даёт дельту', () => {
    const parser = new EventParser();
    const d = diag();
    const inv = new InventoryTracker(d);
    inv.beginTransaction('PickItem');

    inv.applyModify(modify(parser, 100, 3, 100200, 50));
    // Слот переиспользован под другой предмет: 50 → 2 не является расходом 48.
    expect(inv.applyModify(modify(parser, 100, 3, 200003, 2))).toBeNull();
    expect(d.slotRebases).toBe(1);
    expect(inv.applyModify(modify(parser, 100, 3, 200003, 5))?.qty).toBe(3);
  });

  it('InitBagData перезаписывает базу и никогда не даёт дохода', () => {
    const parser = new EventParser();
    const inv = new InventoryTracker(diag());
    inv.beginTransaction('PickItem');

    inv.applyModify(modify(parser, 102, 0, 100300, 100));
    inv.applyInit(init(parser, 102, 0, 100300, 9999)); // синхронизация с сервером
    // 9999 не должно превратиться в доход +9899.
    expect(inv.applyModify(modify(parser, 102, 0, 100300, 10_000))?.qty).toBe(1);
  });

  it('RemoveBagItem очищает слот, следующее значение снова становится базой', () => {
    const parser = new EventParser();
    const inv = new InventoryTracker(diag());
    inv.beginTransaction('PickItem');

    inv.applyModify(modify(parser, 100, 1, 100200, 10));
    const remove = parser.parse(L('BagMgr@:RemoveBagItem PageId = 100 SlotId = 1'));
    expect(remove?.kind).toBe('bagRemove');
    inv.applyRemove(remove as never);

    expect(inv.applyModify(modify(parser, 100, 1, 100200, 7))).toBeNull();
  });
});

describe('классификация протоколов', () => {
  it('перекладывание в сумке не считается доходом', () => {
    const parser = new EventParser();
    const inv = new InventoryTracker(diag());

    inv.applyModify(modify(parser, 100, 0, 100200, 10));
    inv.beginTransaction('Push2'); // перекладывание, а не подбор
    const delta = inv.applyModify(modify(parser, 100, 0, 100200, 20));

    expect(delta?.kind).toBe('neutral');
  });

  it('незнакомый протокол попадает в самодиагностику', () => {
    const d = diag();
    const inv = new InventoryTracker(d);
    inv.beginTransaction('SomeNewSS14Proto');
    expect(d.unknownProtos.get('SomeNewSS14Proto')).toBe(1);
  });
});
