import {
  BAG_INIT_RE,
  BAG_MODIFY_RE,
  BAG_REMOVE_RE,
  BODY_FIELD_RE,
  ENTER_LEVEL_RE,
  ITEM_CHANGE_RE,
  LEVEL_IDS_RE,
  LEVEL_PATH_RE,
  SOCKET_END_RE,
  SOCKET_START_RE,
  TIMESTAMP_RE,
} from './patterns.js';
import type { LogEvent, PriceObservationEvent } from './types.js';

/**
 * Метки в UE_game.log записаны в UTC: последняя строка сессии 07:30:50
 * при системном времени 10:30 (UTC+3). Для длительностей смещение не важно,
 * для отображения абсолютного времени переводим в локальное на уровне UI.
 */
export function parseTimestamp(line: string): number | null {
  const m = TIMESTAMP_RE.exec(line);
  if (!m) return null;
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    Number(m[7]),
  );
}

interface PendingSocket {
  direction: string;
  action: string;
  synId: number;
  /** Время из заголовка сообщения. Нужно, чтобы ретро-скан старых логов
   *  давал корректную историю цен, а не время запуска трекера. */
  ts: number;
  body: string[];
}

/**
 * Построчный разбор лога в типизированные события.
 *
 * Хранит состояние, потому что сокет-сообщения многострочные:
 * заголовок с SynId, затем тело `+ключ [значение]`, затем маркер End.
 * Запрос и ответ связываются по SynId.
 */
export class EventParser {
  private pending: PendingSocket | null = null;
  /** SynId → предмет, цену которого запрашивали. Заполняется из SendMessage. */
  private priceRequests = new Map<number, number>();
  private lineNo = 0;

  /** Возвращает событие, если строка его несёт. Иначе null. */
  parse(raw: string): LogEvent | null {
    this.lineNo++;
    const line = this.lineNo;

    // Тело сокет-сообщения не имеет метки времени — копим до маркера End.
    if (this.pending) {
      if (SOCKET_END_RE.test(raw)) {
        const done = this.pending;
        this.pending = null;
        return this.finishSocket(done, line);
      }
      // Строки тела идут либо отдельно, либо приклеены к строке с категорией.
      this.pending.body.push(raw);
      return null;
    }

    const ts = parseTimestamp(raw);

    let m: RegExpExecArray | null;

    if ((m = BAG_MODIFY_RE.exec(raw))) {
      if (ts === null) return null;
      return {
        kind: 'bagModify',
        ts,
        line,
        pageId: Number(m[1]),
        slotId: Number(m[2]),
        configBaseId: Number(m[3]),
        num: Number(m[4]),
      };
    }

    if ((m = BAG_INIT_RE.exec(raw))) {
      if (ts === null) return null;
      return {
        kind: 'bagInit',
        ts,
        line,
        pageId: Number(m[1]),
        slotId: Number(m[2]),
        configBaseId: Number(m[3]),
        num: Number(m[4]),
      };
    }

    if ((m = BAG_REMOVE_RE.exec(raw))) {
      if (ts === null) return null;
      return { kind: 'bagRemove', ts, line, pageId: Number(m[1]), slotId: Number(m[2]) };
    }

    if ((m = ITEM_CHANGE_RE.exec(raw))) {
      if (ts === null) return null;
      return {
        kind: 'itemChange',
        ts,
        line,
        proto: m[1]!,
        phase: m[2] as 'start' | 'end',
      };
    }

    if ((m = ENTER_LEVEL_RE.exec(raw))) {
      if (ts === null) return null;
      return { kind: 'enterLevel', ts, line, areaId: Number(m[1]) };
    }

    if ((m = LEVEL_PATH_RE.exec(raw))) {
      if (ts === null) return null;
      return { kind: 'levelPath', ts, line, asset: m[1]! };
    }

    if ((m = LEVEL_IDS_RE.exec(raw))) {
      if (ts === null) return null;
      return {
        kind: 'levelIds',
        ts,
        line,
        levelUid: Number(m[1]),
        levelType: Number(m[2]),
        levelId: Number(m[3]),
      };
    }

    if ((m = SOCKET_START_RE.exec(raw))) {
      this.pending = {
        direction: m[1]!,
        action: m[2]!.trim(),
        synId: Number(m[3]),
        ts: ts ?? 0,
        body: [],
      };
      return null;
    }

    return null;
  }

  private finishSocket(msg: PendingSocket, line: number): LogEvent | null {
    if (msg.action !== 'XchgSearchPrice') return null;

    const fields = parseBody(msg.body);

    if (msg.direction === 'SendMessage') {
      // `+filters+1+refer [112410]` — какой предмет пробиваем
      const refer = fields.get('refer');
      if (refer !== undefined) this.priceRequests.set(msg.synId, Number(refer));
      return null;
    }

    // Ответ: цены активных лотов
    const referred = this.priceRequests.get(msg.synId);
    this.priceRequests.delete(msg.synId);
    if (referred === undefined) return null;

    const unitPrices: number[] = [];
    for (const [key, value] of fields.entries()) {
      if (!key.startsWith('unitPrices')) continue;
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) unitPrices.push(n);
    }
    if (unitPrices.length === 0) return null;

    const currency = Number(fields.get('currency') ?? 0);

    const ev: PriceObservationEvent = {
      kind: 'priceObservation',
      ts: msg.ts,
      line,
      configBaseId: referred,
      currency,
      unitPrices,
      synId: msg.synId,
    };
    return ev;
  }
}

/**
 * Разбор отступного тела сокет-дампа.
 *
 *   +prices+1+currency [100300]
 *   |      | +unitPrices+1 [1.0]
 *   |      | |          +2 [1.0]
 *
 * Ключи с числовыми хвостами (`unitPrices+1`) разворачиваются в отдельные записи,
 * поэтому возвращаем плоскую мапу «последний осмысленный ключ» → значение.
 */
export function parseBody(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let counter = 0;
  for (const raw of lines) {
    for (const chunk of raw.split('+')) {
      const m = BODY_FIELD_RE.exec(chunk);
      if (!m) continue;
      const key = m[1]!.replace(/[|\s]/g, '');
      const value = m[2]!;
      if (key === '' || /^\d+$/.test(key)) {
        // Чистый индекс (`+2 [1.0]`) — продолжение предыдущего списка цен.
        out.set(`unitPrices#${counter++}`, value);
        continue;
      }
      if (key.startsWith('unitPrices')) {
        out.set(`unitPrices#${counter++}`, value);
        continue;
      }
      out.set(key, value);
    }
  }
  return out;
}
