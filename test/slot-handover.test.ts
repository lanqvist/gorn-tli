import { describe, expect, it } from 'vitest';

import { EventParser } from '../src/core/eventParser.js';
import { InventoryTracker } from '../src/core/inventory.js';
import type { Diagnostics } from '../src/core/types.js';

function diag(): Diagnostics {
  return {
    linesTotal: 0,
    linesMatched: 0,
    unknownProtos: new Map(),
    slotRebases: 0,
  };
}

const L = (b: string) => `[2026.08.10-12.05.06:000][1]TLLua: Display: [Game] ${b}`;

/**
 * Трекер запускается посреди игровой сессии и читает лог с конца.
 * Если не передать ему состояние сумки, полученное при разборе файла,
 * первое изменение каждого слота уйдёт на установку базы — и расход
 * на первую же открытую карту потеряется.
 */
describe('передача состояния сумки живому дочитыванию', () => {
  it('без передачи состояния расход на первую карту теряется', () => {
    const parser = new EventParser();
    const live = new InventoryTracker(diag());
    live.beginTransaction('Spv3Open');

    const consumed = live.applyModify(
      parser.parse(
        L('BagMgr@:Modfy BagItem PageId = 103 SlotId = 0 ConfigBaseId = 400033 Num = 22'),
      ) as never,
    );

    expect(consumed).toBeNull();
  });

  it('с переданным состоянием расход виден сразу', () => {
    const parser = new EventParser();

    // Разбор накопленного лога: маяков было 23.
    const scanned = new InventoryTracker(diag());
    scanned.beginTransaction('PickItem');
    scanned.applyInit(
      parser.parse(
        L('BagMgr@:InitBagData PageId = 103 SlotId = 0 ConfigBaseId = 400033 Num = 23'),
      ) as never,
    );

    const live = new InventoryTracker(diag());
    live.importSlots(scanned.exportSlots());
    live.beginTransaction('Spv3Open');

    const consumed = live.applyModify(
      parser.parse(
        L('BagMgr@:Modfy BagItem PageId = 103 SlotId = 0 ConfigBaseId = 400033 Num = 22'),
      ) as never,
    );

    expect(consumed).not.toBeNull();
    expect(consumed!.configBaseId).toBe(400033);
    expect(consumed!.qty).toBe(-1);
    expect(consumed!.kind).toBe('mapCost');
  });

  it('перенос состояния не выдумывает добычу', () => {
    const parser = new EventParser();
    const scanned = new InventoryTracker(diag());
    scanned.beginTransaction('PickItem');
    scanned.applyInit(
      parser.parse(
        L('BagMgr@:InitBagData PageId = 102 SlotId = 0 ConfigBaseId = 100300 Num = 6655'),
      ) as never,
    );

    const live = new InventoryTracker(diag());
    live.importSlots(scanned.exportSlots());
    live.beginTransaction('PickItem');

    // Стак не изменился — дохода быть не должно.
    expect(
      live.applyModify(
        parser.parse(
          L('BagMgr@:Modfy BagItem PageId = 102 SlotId = 0 ConfigBaseId = 100300 Num = 6655'),
        ) as never,
      ),
    ).toBeNull();
  });
});
