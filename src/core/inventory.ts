import { protoKind } from './patterns.js';
import type {
  BagInitEvent,
  BagModifyEvent,
  BagRemoveEvent,
  ConfigBaseId,
  Diagnostics,
  ItemDelta,
} from './types.js';

/** Состояние слота сумки. */
export interface SlotState {
  /** null — слот известен и пуст. Это не то же самое, что слот, которого мы не видели. */
  configBaseId: ConfigBaseId | null;
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
 * Реальный доход тут +44 ФЕ, а сумма Num дала бы 33 223.
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

  /**
   * Слот очищен. Строка лога не содержит ConfigBaseId — что там лежало,
   * знаем только мы из своего состояния.
   *
   * Это важно: выставление лота на биржу и полный расход компаса выглядят
   * именно так, а не уменьшением количества. Без восстановления предмета
   * из состояния слота выставленный товар и потраченные карты не видны вообще.
   */
  applyRemove(ev: BagRemoveEvent): ItemDelta | null {
    const key = slotKey(ev.pageId, ev.slotId);
    const prev = this.slots.get(key);
    // Слот не забываем, а помечаем пустым: иначе следующий предмет, упавший
    // в него, выглядит как «слот вижу впервые» и не засчитывается в добычу.
    // Так терялись фитили и маяки, падавшие на освободившееся место.
    this.slots.set(key, { configBaseId: null, qty: 0 });
    if (prev === undefined || prev.configBaseId === null || prev.qty <= 0) return null;

    const proto = this.currentProto ?? 'unknown';
    return {
      ts: ev.ts,
      configBaseId: prev.configBaseId,
      qty: -prev.qty,
      proto,
      kind: protoKind(proto),
      pageId: ev.pageId,
      slotId: ev.slotId,
    };
  }

  /** Возвращает дельту, если изменение действительно является приростом/расходом. */
  applyModify(ev: BagModifyEvent): ItemDelta | null {
    const key = slotKey(ev.pageId, ev.slotId);
    const prev = this.slots.get(key);
    this.slots.set(key, { configBaseId: ev.configBaseId, qty: ev.num });

    // Случай 1: слот раньше не видели. Это установка базы, а не доход.
    // Иначе полный стак из 6611 ФЕ был бы засчитан как разовая находка.
    if (prev === undefined) return null;

    // Случай 2: слот был пуст, и в него что-то положили. Здесь сомнений нет:
    // получено ровно столько, сколько появилось.
    const qty =
      prev.configBaseId === null
        ? ev.num
        : prev.configBaseId === ev.configBaseId
          ? ev.num - prev.qty
          : null;

    // Случай 3: в слоте лежал другой предмет, и он сменился без удаления.
    // Разница между разными предметами смысла не имеет — перебазируемся.
    if (qty === null) {
      this.diag.slotRebases++;
      return null;
    }
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

  /**
   * Состояние слотов целиком.
   *
   * Нужно, чтобы передать базу от разбора накопленных логов живому
   * дочитыванию. Без этого первое изменение каждого слота после запуска
   * трекера уходит на установку базы, и расход на первую же открытую
   * карту теряется — приложение видит списание маяка, но не знает,
   * сколько их было до этого, и промолчать обязано.
   */
  exportSlots(): Array<[string, SlotState]> {
    return [...this.slots.entries()].map(([key, slot]) => [key, { ...slot }]);
  }

  importSlots(entries: Array<[string, SlotState]>): void {
    for (const [key, slot] of entries) this.slots.set(key, { ...slot });
  }

  /** Текущее содержимое сумки — для оценки нетворса. */
  snapshot(): Map<ConfigBaseId, number> {
    const out = new Map<ConfigBaseId, number>();
    for (const slot of this.slots.values()) {
      if (slot.configBaseId === null) continue;
      out.set(slot.configBaseId, (out.get(slot.configBaseId) ?? 0) + slot.qty);
    }
    return out;
  }
}
