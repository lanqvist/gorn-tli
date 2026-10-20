import { describe, expect, it } from 'vitest';

import { EventParser } from '../src/core/eventParser.js';
import { InventoryTracker } from '../src/core/inventory.js';
import type { BagInitEvent, BagModifyEvent, Diagnostics } from '../src/core/types.js';

function diag(): Diagnostics {
  return {
    linesTotal: 0,
    linesMatched: 0,
    unknownProtos: new Map(),
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
  it('реальная последовательность ФЕ из лога даёт +44, а не сумму значений', () => {
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

    // Без этой защиты полный стак из 6611 ФЕ засчитался бы как разовая находка.
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

  it('предмет, упавший в освободившийся слот, засчитывается целиком', () => {
    // Подлинный случай из лога: Bronze Wick убран из page103/slot2 в 12:22,
    // Gold Wick упал туда же в 12:38. Раньше слот забывался при удалении,
    // и новая находка выглядела как «слот вижу впервые» — фитили и маяки,
    // падавшие на освободившееся место, не засчитывались вообще.
    const parser = new EventParser();
    const inv = new InventoryTracker(diag());

    inv.beginTransaction('PickItem');
    inv.applyModify(modify(parser, 103, 2, 10320, 3)); // база: 3 бронзовых фитиля
    inv.applyModify(modify(parser, 103, 2, 10320, 2));

    inv.beginTransaction('Spv3Open');
    inv.applyRemove(parser.parse(L('BagMgr@:RemoveBagItem PageId = 103 SlotId = 2')) as never);

    inv.beginTransaction('PickItems');
    const found = inv.applyModify(modify(parser, 103, 2, 10322, 1)); // упал золотой

    expect(found).not.toBeNull();
    expect(found!.configBaseId).toBe(10322);
    expect(found!.qty).toBe(1);
    expect(found!.kind).toBe('loot');
  });

  it('слот, которого не видели, по-прежнему только задаёт базу', () => {
    // Разница принципиальная: «слот пуст» и «слот неизвестен» — не одно
    // и то же. Во втором случае молчать обязательно, иначе полный стак
    // засчитается как находка.
    const parser = new EventParser();
    const inv = new InventoryTracker(diag());
    inv.beginTransaction('PickItems');

    expect(inv.applyModify(modify(parser, 103, 9, 10322, 5))).toBeNull();
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

/**
 * Дроп в слот, пустовавший с самого входа в игру.
 *
 * Подлинная последовательность из лога 2026-08-10: страница 103
 * инициализировала 52 занятых слота, Серебряный фитиль упал в пустой 53-й.
 * Пустые слоты в InitBagData не попадают, и без строки ItemChange@ Add
 * первый Modfy такого слота уходил на установку базы — фитиль
 * не засчитывался в добычу вообще.
 */
describe('дроп в пустовавший с входа слот', () => {
  const WICK_LINES = [
    '[2026.08.10-14.52.46:202][762]TLLua: Display: [Game] ItemChange@ ProtoName=PickItems start',
    '[2026.08.10-14.52.46:202][762]TLLua: Display: [Game] ItemChange@ Add Id=10321_25b2b109-94cb-11f1-b5e9-000000000034 BagNum=1 in PageId=103 SlotId=53',
    '[2026.08.10-14.52.46:202][762]TLLua: Display: [Game] BagMgr@:Modfy BagItem PageId = 103 SlotId = 53 ConfigBaseId = 10321 Num = 1',
    '[2026.08.10-14.52.46:202][762]TLLua: Display: [Game] ItemChange@ ProtoName=PickItems end',
  ];

  it('серебряный фитиль засчитывается как лут', () => {
    const parser = new EventParser();
    const inv = new InventoryTracker(diag());
    let delta = null;

    for (const line of WICK_LINES) {
      const ev = parser.parse(line);
      if (!ev) continue;
      switch (ev.kind) {
        case 'itemChange':
          if (ev.phase === 'start') inv.beginTransaction(ev.proto);
          else inv.endTransaction();
          break;
        case 'bagAdd':
          inv.applyAdd(ev);
          break;
        case 'bagModify':
          delta = inv.applyModify(ev);
          break;
      }
    }

    expect(delta).not.toBeNull();
    expect(delta!.configBaseId).toBe(10321);
    expect(delta!.qty).toBe(1);
    expect(delta!.kind).toBe('loot');
  });

  it('Add по занятому тем же предметом слоту не сбрасывает базу', () => {
    // Иначе повторный Add задваивал бы стак: 10 в слоте + Add + Modfy 12
    // должно дать +2, а не +12.
    const parser = new EventParser();
    const inv = new InventoryTracker(diag());

    inv.applyInit(
      parser.parse(
        L('BagMgr@:InitBagData PageId = 102 SlotId = 4 ConfigBaseId = 5028 Num = 10'),
      ) as never,
    );
    inv.beginTransaction('PickItem');
    const add = parser.parse(
      L('ItemChange@ Add Id=5028_25b2b109-94cb-11f1-b5e9-000000000034 BagNum=2 in PageId=102 SlotId=4'),
    );
    if (add?.kind === 'bagAdd') inv.applyAdd(add);
    const delta = inv.applyModify(
      parser.parse(
        L('BagMgr@:Modfy BagItem PageId = 102 SlotId = 4 ConfigBaseId = 5028 Num = 12'),
      ) as never,
    );

    expect(delta!.qty).toBe(2);
  });
});
