import { protoKind } from './patterns.js';
import type {
  BagInitEvent,
  BagModifyEvent,
  BagRemoveEvent,
  ConfigBaseId,
  Diagnostics,
  ItemDelta,
} from './types.js';

interface SlotState {
  configBaseId: ConfigBaseId;
  qty: number;
}

const slotKey = (pageId: number, slotId: number) => `${pageId}:${slotId}`;

/**
 * Превращает изменения слотов сумки в приросты и расходы предметов.
 *
 * Ключевая тонкость, на которой ломается наивная реализация:
 * `Num` в BagMgr@:Modfy — это НОВЫЙ РАЗМЕР СТАКА в слоте, а не прирост.
 * Проверено на реальном логе, слот page102/slot0:
 *
 *     6611 (InitBagData) → 6616 → 6649 → 6650 → 6653 → 6655
 *
 * Реальный доход тут +44 ФЭ, а сумма Num дала бы 33 223.
 *
 * Поэтому доход = текущее значение минус предыдущее по ключу (PageId, SlotId),
 * с корректной обработкой четырёх краевых случаев:
 *
 *  1. Первое наблюдение слота — установка базы, дохода нет.
 *  2. В слоте сменился предмет — база сбрасывается, разница НЕ является доходом.
 *  3. RemoveBagItem — слот очищен, база обнуляется.
 *  4. InitBagData — полная синхронизация, перезаписывает базу без начисления.
 */
export class InventoryTracker {
  private slots = new Map<string, SlotState>();
  /** Текущий ProtoName между start и end. */
  private currentProto: string | null = null;

  constructor(private readonly diag: Diagnostics) {}

  beginTransaction(proto: string): void {
    this.currentProto = proto;
    if (protoKind(proto) === 'unknown') {
      this.diag.unknownProtos.set(proto, (this.diag.unknownProtos.get(proto) ?? 0) + 1);
    }
  }

  endTransaction(): void {
    this.currentProto = null;
  }

  /**
   * InitBagData — снимок состояния. Перезаписывает базу и НИКОГДА не даёт дохода,
   * иначе первый же вход в игру засчитался бы как гигантский дроп.
   */
  applyInit(ev: BagInitEvent): void {
    this.slots.set(slotKey(ev.pageId, ev.slotId), {
      configBaseId: ev.configBaseId,
      qty: ev.num,
    });
  }

  applyRemove(ev: BagRemoveEvent): void {
    this.slots.delete(slotKey(ev.pageId, ev.slotId));
  }

  /** Возвращает дельту, если изменение действительно является приростом/расходом. */
  applyModify(ev: BagModifyEvent): ItemDelta | null {
    const key = slotKey(ev.pageId, ev.slotId);
    const prev = this.slots.get(key);
    this.slots.set(key, { configBaseId: ev.configBaseId, qty: ev.num });

    // Случай 1: слот раньше не видели. Это установка базы, а не доход.
    // Иначе полный стак из 6611 ФЭ был бы засчитан как разовая находка.
    if (prev === undefined) return null;

    // Случай 2: в слоте лежал другой предмет. Разница между разными
    // предметами смысла не имеет — просто перебазируемся.
    if (prev.configBaseId !== ev.configBaseId) {
      this.diag.slotRebases++;
      return null;
    }

    const qty = ev.num - prev.qty;
    if (qty === 0) return null;

    const proto = this.currentProto ?? 'unknown';
    return {
      ts: ev.ts,
      configBaseId: ev.configBaseId,
      qty,
      proto,
      kind: protoKind(proto),
      pageId: ev.pageId,
      slotId: ev.slotId,
    };
  }

  /** Текущее содержимое сумки — для оценки нетворса. */
  snapshot(): Map<ConfigBaseId, number> {
    const out = new Map<ConfigBaseId, number>();
    for (const slot of this.slots.values()) {
      out.set(slot.configBaseId, (out.get(slot.configBaseId) ?? 0) + slot.qty);
    }
    return out;
  }
}
