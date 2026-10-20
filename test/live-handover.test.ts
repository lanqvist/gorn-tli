import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mergeRuns } from '../src/core/analysis.js';
import { EventParser } from '../src/core/eventParser.js';
import { InventoryTracker } from '../src/core/inventory.js';
import { analyzeLogFile, type AnalysisResult } from '../src/core/pipeline.js';
import { RunSegmenter } from '../src/core/runSegmenter.js';
import { FE_ID, type Diagnostics, type Run } from '../src/core/types.js';
import { LogTailer } from '../src/main/tailer.js';
import { Storage } from '../src/storage/db.js';

/**
 * Стык разбора накопленного лога и живого дочитывания того же файла:
 * трекер запускается, пока игра пишет лог. Всё, что разбор не закрыл —
 * открытый забег, возврат через портал, недописанная строка, — обязано
 * перейти живому дочитыванию без потерь и без задвоения.
 */

const MAP = 'YL_MaNeiLaYuLin100';
const HUB = 'XZ_YuJinZhiXiBiNanSuo200';
const T0 = Date.UTC(2026, 9, 20, 10, 0, 0);

function line(ts: number, text: string): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}-` +
    `${p(d.getUTCHours())}.${p(d.getUTCMinutes())}.${p(d.getUTCSeconds())}:${p(d.getUTCMilliseconds(), 3)}`;
  return `[${stamp}][  1]GameLog: Display: [Game] ${text}`;
}

const enter = (ts: number, asset: string, areaId: number) => [
  line(ts, `LevelMgr@:LevelPath, Model = Content/Art/Maps/X/${asset}/${asset}.umap`),
  line(ts, `LevelMgr:_EnterLevelSuccess() ${areaId}`),
];
const init = (ts: number, num: number) =>
  line(ts, `BagMgr@:InitBagData PageId = 102 SlotId = 0 ConfigBaseId = ${FE_ID} Num = ${num}`);
const pick = (ts: number, num: number) => [
  line(ts, 'ItemChange@ ProtoName=PickItem start'),
  line(ts, `BagMgr@:Modfy BagItem PageId = 102 SlotId = 0 ConfigBaseId = ${FE_ID} Num = ${num}`),
  line(ts, 'ItemChange@ ProtoName=PickItem end'),
];

function diag(): Diagnostics {
  return { linesTotal: 0, linesMatched: 0, unknownProtos: new Map(), slotRebases: 0 };
}

/** Живое дочитывание в миниатюре — как Engine.consume, только нарезка и сумка. */
class Live {
  parser = new EventParser();
  inventory = new InventoryTracker(diag());
  segmenter = new RunSegmenter();
  deltas: number[] = [];

  constructor(scan: AnalysisResult) {
    this.inventory.importSlots(scan.slots);
    if (scan.segmenter) this.segmenter.importState(scan.segmenter);
  }

  feed(lines: string[]): void {
    for (const raw of lines) {
      const ev = this.parser.parse(raw);
      if (!ev) continue;
      if (ev.kind === 'itemChange') {
        if (ev.phase === 'start') this.inventory.beginTransaction(ev.proto);
        else this.inventory.endTransaction();
      } else if (ev.kind === 'bagModify') {
        const delta = this.inventory.applyModify(ev);
        if (delta) {
          this.deltas.push(delta.qty);
          this.segmenter.addDelta(delta);
        }
      } else if (ev.kind === 'levelPath') this.segmenter.noteAsset(ev.asset);
      else if (ev.kind === 'enterLevel') this.segmenter.enterLevel(ev);
    }
  }

  get closed(): Run[] {
    return this.segmenter.all.filter((r) => r.endedAt !== null);
  }
}

const fe = (runs: Run[]) =>
  runs.filter((r) => !r.isHub).reduce((a, r) => a + r.drops.reduce((b, d) => b + d.qty, 0), 0);

let dir: string;
let log: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gorn-handover-'));
  log = join(dir, 'UE_game.log');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (lines: string[]) => writeFileSync(log, lines.join('\n') + '\n');
const append = (lines: string[]) => appendFileSync(log, lines.join('\n') + '\n');

describe('передача нарезки живому дочитыванию', () => {
  it('запуск между заходами через портал: карта остаётся одним забегом и после перезапуска', async () => {
    // Первый заход в карту, потом в город за продажей — и тут стартует трекер.
    write([init(T0, 100), ...enter(T0 + 1000, MAP, 5348), ...pick(T0 + 10_000, 200), ...enter(T0 + 60_000, HUB, 110)]);
    const scan = await analyzeLogFile(log, { current: true });

    const storage = new Storage(join(dir, 'gorn.db'));
    storage.saveRuns(scan.runs, null);

    // Возврат в ту же карту порталом, ещё 50 ФЕ, снова в город.
    const tail = [...enter(T0 + 120_000, MAP, 5348), ...pick(T0 + 130_000, 250), ...enter(T0 + 200_000, HUB, 110)];
    append(tail);
    const live = new Live(scan);
    live.feed(tail);
    storage.saveRuns(live.closed, null);

    const session = mergeRuns(storage.loadRuns(), live.closed);
    expect(session.filter((r) => !r.isHub)).toHaveLength(1);
    expect(fe(session)).toBe(150);

    // Следующий запуск: полный повторный разбор того же лога.
    const rescan = await analyzeLogFile(log, { current: true });
    storage.saveRuns(rescan.runs, null);
    const history = mergeRuns(storage.loadRuns(), rescan.runs);
    expect(history.filter((r) => !r.isHub)).toHaveLength(1);
    expect(fe(history)).toBe(150);
    expect(fe(storage.loadRuns())).toBe(150);
    storage.close();
  });

  it('запуск посреди карты: добыча до выхода не теряется', async () => {
    write([init(T0, 100), ...enter(T0 + 1000, MAP, 5348), ...pick(T0 + 10_000, 200)]);
    const scan = await analyzeLogFile(log, { current: true });
    // Открытый забег не закрывается по последней строке — он продолжается.
    expect(scan.runs.filter((r) => !r.isHub)).toHaveLength(0);
    expect(scan.segmenter?.current?.drops).toHaveLength(1);

    const live = new Live(scan);
    live.feed([...pick(T0 + 20_000, 230), ...enter(T0 + 60_000, HUB, 110)]);
    const map = live.closed.filter((r) => !r.isHub);
    expect(map).toHaveLength(1);
    expect(map[0]!.startedAt).toBe(T0 + 1000);
    expect(fe(map)).toBe(130);
  });

  it('вложения, списанные в городе до старта, достаются следующей карте', async () => {
    const BEACON = 400033;
    write([
      ...enter(T0, HUB, 110),
      line(T0 + 1000, `BagMgr@:InitBagData PageId = 103 SlotId = 0 ConfigBaseId = ${BEACON} Num = 23`),
      line(T0 + 2000, 'ItemChange@ ProtoName=Spv3Open start'),
      line(T0 + 2000, `BagMgr@:Modfy BagItem PageId = 103 SlotId = 0 ConfigBaseId = ${BEACON} Num = 22`),
      line(T0 + 2000, 'ItemChange@ ProtoName=Spv3Open end'),
    ]);
    const scan = await analyzeLogFile(log, { current: true });
    const live = new Live(scan);
    live.feed([...enter(T0 + 3000, MAP, 5348), ...enter(T0 + 60_000, HUB, 110)]);
    const map = live.closed.find((r) => !r.isHub)!;
    expect(map.costs.map((c) => [c.configBaseId, c.qty])).toEqual([[BEACON, 1]]);
  });
});

describe('половина карты рядом с целой', () => {
  const run = (startedAt: number, endedAt: number, qty: number, areaId = 5348): Run => ({
    areaId,
    asset: MAP,
    levelType: 3,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    isHub: false,
    playerId: null,
    seasonId: null,
    drops: [{ ts: startedAt + 1, configBaseId: FE_ID, qty, proto: 'PickItem', kind: 'loot', pageId: 102, slotId: 0 }],
    costs: [],
  });

  it('слияние выбрасывает забег, целиком лежащий внутри забега той же зоны', () => {
    const whole = run(T0, T0 + 200_000, 150);
    const half = run(T0 + 120_000, T0 + 200_000, 50);
    const other = run(T0 + 120_000, T0 + 150_000, 7, 5351);
    expect(mergeRuns([half, other], [whole])).toEqual([whole, other]);
    expect(mergeRuns([whole, half])).toEqual([whole]);
  });

  it('уже записанные дубли удаляются миграцией старой базы', () => {
    const path = join(dir, 'gorn.db');
    const storage = new Storage(path);
    storage.saveRuns([run(T0 + 120_000, T0 + 200_000, 50)], null);
    // Прошлая версия: целая карта записана позже отдельным вызовом —
    // теперь сохранение само чистит половину, поэтому подкладываем её снова
    // напрямую, как это лежит в старых базах.
    storage.saveRuns([run(T0, T0 + 200_000, 150)], null);
    expect(storage.loadRuns()).toHaveLength(1);
    (storage as unknown as { db: { exec(sql: string): void } }).db.exec(
      `INSERT INTO run (area_id, asset, started_at, ended_at, duration_ms, is_hub)
       VALUES (5348, '${MAP}', ${T0 + 120_000}, ${T0 + 200_000}, 80000, 0)`,
    );
    expect(storage.loadRuns()).toHaveLength(2);
    // База прошлой версии: миграции до чистки половин (5-й) уже пройдены.
    (storage as unknown as { db: { exec(sql: string): void } }).db.exec('PRAGMA user_version = 4');
    storage.close();

    const reopened = new Storage(path);
    const runs = reopened.loadRuns();
    expect(runs).toHaveLength(1);
    expect(fe(runs)).toBe(150);
    reopened.close();
  });
});

/** Ждёт строк от tailer: опрос идёт раз в 300 мс. */
function collect(tailer: LogTailer, sink: string[][], count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (sink.flat().length >= count) return resolve();
      if (Date.now() - started > 5000) return reject(new Error(`строк ${sink.flat().length}`));
      setTimeout(check, 50);
    };
    tailer.start();
    check();
  });
}

describe('недописанная строка на стыке', () => {
  it('разбор останавливается на последнем переводе строки, дочитывание продолжает с него', async () => {
    // Игра успела записать «Num = 1» из будущего «Num = 151».
    const head = [init(T0, 150), line(T0 + 1, 'ItemChange@ ProtoName=PickItem start')].join('\n') + '\n';
    const full = line(T0 + 2, `BagMgr@:Modfy BagItem PageId = 102 SlotId = 0 ConfigBaseId = ${FE_ID} Num = 151`);
    writeFileSync(log, head + full.slice(0, full.length - 2));

    const scan = await analyzeLogFile(log, { current: true });
    expect(scan.position).toBe(Buffer.byteLength(head));

    // Игра дописывает строку и подбирает ещё одну ФЕ.
    appendFileSync(log, full.slice(full.length - 2) + '\n');
    appendFileSync(log, [line(T0 + 3, 'ItemChange@ ProtoName=PickItem end'), ...pick(T0 + 4, 152)].join('\n') + '\n');

    const live = new Live(scan);
    const sink: string[][] = [];
    const tailer = new LogTailer(log, { initialPosition: scan.position, onLines: (l) => sink.push(l) });
    try {
      await collect(tailer, sink, 5);
    } finally {
      tailer.stop();
    }
    expect(sink.flat()[0]).toBe(full);
    live.feed(sink.flat());
    expect(live.deltas).toEqual([1, 1]);
  });

  it('разбор старого файла дочитывает последнюю строку без перевода', async () => {
    writeFileSync(log.replace('UE_game', 'UE_game-backup'), [init(T0, 100), ...pick(T0 + 1, 105)].join('\n'));
    const scan = await analyzeLogFile(log.replace('UE_game', 'UE_game-backup'));
    expect(scan.inventory.get(FE_ID)).toBe(105);
  });

  it('старт с конца файла посреди строки пропускает обрубок', async () => {
    const full = line(T0 + 2, `BagMgr@:Modfy BagItem PageId = 102 SlotId = 0 ConfigBaseId = ${FE_ID} Num = 151`);
    writeFileSync(log, init(T0, 150) + '\n' + full.slice(0, -2));
    const sink: string[][] = [];
    const tailer = new LogTailer(log, { onLines: (l) => sink.push(l) });
    const next = line(T0 + 3, 'ItemChange@ ProtoName=PickItem end');
    const done = collect(tailer, sink, 1);
    appendFileSync(log, full.slice(-2) + '\n' + next + '\n');
    try {
      await done;
    } finally {
      tailer.stop();
    }
    expect(sink.flat()).toEqual([next]);
    expect(readFileSync(log, 'utf8')).toContain(full);
  });

  it('ошибка наблюдателя не роняет процесс: остаётся опрос', () => {
    writeFileSync(log, init(T0, 150) + '\n');
    const tailer = new LogTailer(log, { onLines: () => {} });
    tailer.start();
    const internals = tailer as unknown as { watcher: NodeJS.EventEmitter | null };
    expect(internals.watcher).not.toBeNull();
    expect(() => internals.watcher!.emit('error', new Error('EPERM'))).not.toThrow();
    expect(internals.watcher).toBeNull();
    tailer.stop();
  });
});
