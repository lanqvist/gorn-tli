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
import { FE_ID, type LogEvent, type PriceObservationEvent } from './types.js';

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
      // `+filters+1+refer [112410]` — какой предмет пробиваем.
      // Поиск по категории (а не по конкретному предмету) поля refer не содержит,
      // и привязать такие цены к предмету нельзя — пропускаем.
      const refer = Number(findValue(fields, 'refer'));
      if (Number.isFinite(refer) && refer > 0) this.priceRequests.set(msg.synId, refer);
      return null;
    }

    // Ответ: цены активных лотов
    const referred = this.priceRequests.get(msg.synId);
    this.priceRequests.delete(msg.synId);
    if (referred === undefined) return null;

    // Групп может быть несколько — по одной на валюту. Нужна та, что в ФЕ:
    // дешёвые материалы параллельно продаются за Пламенный песок, и цены
    // разных валют смешивать нельзя.
    const groups = fields.get('prices');
    if (!(groups instanceof Map)) return null;

    let unitPrices: number[] = [];
    let currency = FE_ID;

    for (const group of groups.values()) {
      if (!(group instanceof Map)) continue;
      const raw = group.get('currency');
      // Отсутствие валюты означает валюту по умолчанию, то есть ФЕ.
      const groupCurrency = typeof raw === 'string' ? Number(raw) : FE_ID;
      const list = group.get('unitPrices');
      if (!(list instanceof Map)) continue;

      const prices = [...list.values()]
        .filter((v): v is string => typeof v === 'string')
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);
      if (prices.length === 0) continue;

      if (groupCurrency === FE_ID) {
        unitPrices = prices;
        currency = FE_ID;
        break;
      }
      // Не ФЕ — запоминаем на случай, если группы в ФЕ вовсе нет.
      if (unitPrices.length === 0) {
        unitPrices = prices;
        currency = groupCurrency;
      }
    }

    if (unitPrices.length === 0) return null;

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

/** Узел дерева тела сокет-дампа: либо вложенные ключи, либо значение. */
export type BodyNode = Map<string, BodyNode | string>;

/**
 * Разбор отступного тела сокет-дампа в дерево.
 *
 *   +prices+1+unitPrices+1 [0.0001]
 *   |      | |          +2 [0.0001]
 *   |      | +currency [100300]
 *   |      +2+currency [100200]
 *
 * Вложенность здесь позиционная: символы `|` — направляющие, а глубина
 * ключа определяется колонкой, в которой стоит его `+`. Строка 4 относится
 * к группе 1, строка 5 открывает группу 2.
 *
 * Раньше тело сплющивалось в плоскую таблицу. На ответах с несколькими
 * ценовыми группами это давало неверный результат: цены всех валют
 * сваливались в один список, а валютой считалась последняя встреченная.
 * Дешёвые материалы продаются и за ФЕ, и за Пламенный песок, поэтому
 * их цена в ФЕ терялась целиком.
 */
export function parseBody(lines: string[]): BodyNode {
  const root: BodyNode = new Map();
  let path: Array<{ col: number; key: string }> = [];

  for (const raw of lines) {
    const tokens: Array<{ col: number; key: string }> = [];
    const re = /\+([^+\s[\]|]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) tokens.push({ col: m.index, key: m[1]! });
    if (tokens.length === 0) continue;

    for (const token of tokens) {
      // Ключ заменяет всё, что было в его колонке и правее.
      path = path.filter((p) => p.col < token.col);
      path.push(token);
    }

    const value = /\[([^\]]*)\]\s*$/.exec(raw);
    if (value) setPath(root, path.map((p) => p.key), value[1]!);
  }

  return root;
}

function setPath(root: BodyNode, keys: string[], value: string): void {
  let node = root;
  for (const key of keys.slice(0, -1)) {
    const next = node.get(key);
    if (next instanceof Map) {
      node = next;
    } else {
      const created: BodyNode = new Map();
      node.set(key, created);
      node = created;
    }
  }
  const last = keys[keys.length - 1];
  if (last !== undefined) node.set(last, value);
}

/** Первое значение с таким ключом на любой глубине. */
export function findValue(node: BodyNode, key: string): string | undefined {
  const direct = node.get(key);
  if (typeof direct === 'string') return direct;
  for (const child of node.values()) {
    if (child instanceof Map) {
      const found = findValue(child, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
