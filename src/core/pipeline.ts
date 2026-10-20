import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';

import { EventParser } from './eventParser.js';
import { InventoryTracker, type SlotState } from './inventory.js';
import type { MapKeyLookup } from './patterns.js';
import { RunSegmenter, type SegmenterState } from './runSegmenter.js';
import { TradeLedger } from './trade.js';
import {
  mergePlayerInfo,
  type ConfigBaseId,
  type Diagnostics,
  type PlayerProfile,
  type PriceObservationEvent,
  type Run,
} from './types.js';

export interface AnalysisResult {
  runs: Run[];
  prices: PriceObservationEvent[];
  trade: TradeLedger;
  inventory: Map<ConfigBaseId, number>;
  /** Состояние слотов на конец файла — база для живого дочитывания. */
  slots: Array<[string, SlotState]>;
  diagnostics: Diagnostics;
  seasonId: number | null;
  /** Все персонажи, встреченные в файле. */
  players: PlayerProfile[];
  /** Кем зашли последним — состояние для живого дочитывания. */
  lastPlayerId: string | null;
  firstTs: number | null;
  lastTs: number | null;
  /**
   * Сколько байт разобрано. В режиме текущего лога — ровно до конца
   * последней полной строки: с этого байта продолжает живое дочитывание.
   */
  position: number;
  /** Незакрытая нарезка текущего лога (только в режиме current). */
  segmenter: SegmenterState | null;
}

function emptyDiagnostics(): Diagnostics {
  return {
    linesTotal: 0,
    linesMatched: 0,
    unknownProtos: new Map(),
    unknownItemIds: new Map(),
    slotRebases: 0,
  };
}

/**
 * Прогоняет файл лога целиком и собирает забеги, дельты и наблюдения цен.
 *
 * Используется и для ретро-скана уже накопленных логов (мгновенная история
 * при первом запуске), и как эталон для тестов на реальных фикстурах.
 */
export interface AnalyzeOptions {
  /** Ключ ли предмет от карты — из справочника. Без него сезонные компасы не видны как вложения. */
  isMapKey?: MapKeyLookup;
  /**
   * Файл — текущий лог, который игра ещё дописывает. Тогда открытый забег
   * не закрывается, а передаётся живому дочитыванию, и недописанная
   * последняя строка не разбирается: «Num = 1» от будущего «Num = 151»
   * давало фантомный прирост на стыке разбора и дочитывания.
   */
  current?: boolean;
}

/**
 * Пропускает только полные строки; хвост после последнего перевода строки
 * отбрасывается в конце потока. Режет по байту 
, поэтому многобайтовый
 * символ UTF-8 не рвётся.
 */
function completeLines(onConsumed: (bytes: number) => void): Transform {
  let pending: Buffer = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      const buf: Buffer = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      const cut = buf.lastIndexOf(0x0a);
      if (cut < 0) {
        pending = buf;
        done();
        return;
      }
      pending = buf.subarray(cut + 1);
      onConsumed(cut + 1);
      done(null, buf.subarray(0, cut + 1));
    },
  });
}

export async function analyzeLogFile(
  path: string,
  options: AnalyzeOptions = {},
): Promise<AnalysisResult> {
  const diagnostics = emptyDiagnostics();
  const parser = new EventParser();
  const inventory = new InventoryTracker(diagnostics, options.isMapKey);
  const segmenter = new RunSegmenter();
  const trade = new TradeLedger();
  const prices: PriceObservationEvent[] = [];

  let seasonId: number | null = null;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  const players = new Map<string, PlayerProfile>();
  let lastPlayerId: string | null = null;

  let position = 0;
  const source = createReadStream(path);
  const input = options.current
    ? source.pipe(completeLines((n) => (position += n)))
    : source.on('data', (chunk) => (position += chunk.length));
  if (options.current) source.on('error', (err) => input.destroy(err));
  const rl = createInterface({ input, crlfDelay: Infinity });

  for await (const raw of rl) {
    diagnostics.linesTotal++;

    // SeasonId приходит внутри сокет-дампа профиля игрока.
    if (seasonId === null) {
      const m = /\+SeasonId \[(\d+)\]/.exec(raw);
      if (m) seasonId = Number(m[1]);
    }

    const ev = parser.parse(raw);
    if (!ev) continue;
    diagnostics.linesMatched++;

    if ('ts' in ev && ev.ts > 0) {
      firstTs ??= ev.ts;
      lastTs = ev.ts;
    }

    switch (ev.kind) {
      case 'itemChange':
        if (ev.phase === 'start') inventory.beginTransaction(ev.proto);
        else inventory.endTransaction();
        break;

      case 'bagInit':
        inventory.applyInit(ev);
        break;

      case 'bagAdd':
        inventory.applyAdd(ev);
        break;

      case 'bagRemove': {
        const delta = inventory.applyRemove(ev);
        if (delta) {
          segmenter.addDelta(delta);
          trade.add(delta);
        }
        break;
      }

      case 'bagModify': {
        const delta = inventory.applyModify(ev);
        if (delta) {
          segmenter.addDelta(delta);
          trade.add(delta);
        }
        break;
      }

      case 'levelPath':
        segmenter.noteAsset(ev.asset);
        break;

      case 'levelIds':
        segmenter.noteLevelType(ev.levelType);
        break;

      case 'enterLevel':
        segmenter.enterLevel(ev);
        break;

      case 'priceObservation':
        prices.push(ev);
        break;

      case 'playerInfo':
        players.set(ev.playerId, mergePlayerInfo(players.get(ev.playerId), ev));
        lastPlayerId = ev.playerId;
        segmenter.setPlayer(ev.playerId);
        if (ev.seasonId !== undefined) segmenter.setSeason(ev.seasonId);
        break;

      default:
        break;
    }
  }

  // Открытый забег текущего лога не закрывается: игрок ещё в карте,
  // и закрытие по последней строке давало обрубок без остатка добычи.
  const segmenterState = options.current ? segmenter.exportState(lastTs ?? 0) : null;
  const runs = options.current ? [...segmenter.closed] : segmenter.finish(lastTs ?? 0);

  return {
    runs,
    prices,
    trade,
    inventory: inventory.snapshot(),
    slots: inventory.exportSlots(),
    diagnostics,
    seasonId,
    players: [...players.values()],
    lastPlayerId,
    firstTs,
    lastTs,
    position,
    segmenter: segmenterState,
  };
}
