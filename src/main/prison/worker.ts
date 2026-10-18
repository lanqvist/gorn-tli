/**
 * Поток подсказок в тюрьме: кадр игры → распознавание → ход → метки.
 *
 * Два пути, выбор — настройка разработчика prisonEngine (ключ
 * --gorn-engine): 'own' — свой симулятор (src/core/prison, связка в
 * ownAdvisor.ts), 'vendor' — код «Tartarus Simulator» (vendor/tartarus:
 * сканер доски, движок, решатель и перенос анализатора без страницы,
 * advisor.js). Здесь связка: кадр приходит из main-процесса (BGRA, как
 * отдаёт desktopCapturer), уходят тексты и метки в пикселях кадра. Расчёт
 * тяжёлый, поэтому он в отдельном процессе (utilityProcess) с пониженным
 * приоритетом: не тормозит ни интерфейс и разбор лога Горна, ни саму игру.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { constants, setPriority } from 'node:os';

import type { Frame } from '../../core/prison/recognize/types.js';
import type { PrisonFrameKind } from '../../core/prisonTriggers.js';
import { OwnAdvisor } from './ownAdvisor.js';
import type { BoardNear, PrisonHint, PrisonShotMessage, PrisonWorkerReply, SavedNear } from './protocol.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- код симулятора без типов */
type Any = any;

/** Канал к main-процессу Горна (Electron utilityProcess). */
const port = (process as unknown as { parentPort: { postMessage(m: unknown): void; on(ev: 'message', fn: (e: { data: unknown }) => void): void } }).parentPort;
const arg = (name: string): string | null => (process.argv.includes(name) ? (process.argv[process.argv.indexOf(name) + 1] ?? null) : null);
const vendorDir: string = arg('--gorn-vendor') ?? '';
const engine: 'own' | 'vendor' = arg('--gorn-engine') === 'own' ? 'own' : 'vendor';
try {
  // Игра важнее подсказки: процессор ей, расчёт — в остаток.
  setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  // Нет прав на смену приоритета — считаем как есть.
}
// Код симулятора грузится только для прежнего пути.
let Scan: Any;
let SCAN: Any;
let PICK: Any;
let hint: (rec: Any, ctx: Any) => { text: string; marks: Any[] } | null = () => null;
let REF: Any;
let SIMS: string[] = [];
let advisor: Any;
if (engine === 'vendor') {
  const req = createRequire(join(vendorDir, 'advisor.js'));
  Scan = req('./scan.js');
  SCAN = req('./scan-data.js');
  PICK = req('./pick-data.js');
  req('./scan-data-ru.js');
  const vendor = req('./advisor.js') as { createAdvisor: () => Any; hint: typeof hint };
  hint = vendor.hint;
  REF = Scan.withPanelIcons(SCAN, PICK);
  SIMS = [...new Set<string>(REF.tools.map((x: Any) => (SCAN.toolNames[x.id] || {}).sim).filter(Boolean))];
  advisor = vendor.createAdvisor();
}

/** Сканер настроен на картинки до ~2600 px: 4K уменьшаем вдвое. */
const MAX_WIDTH = 2600;

interface Image {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** BGRA/RGBA → RGBA, с уменьшением в целое число раз усреднением блоков. */
function toImage(width: number, height: number, bgra: Uint8Array, rgba: boolean): { img: Image; scale: number } {
  const R = rgba ? 0 : 2;
  const B = rgba ? 2 : 0;
  const f = Math.max(1, Math.ceil(width / MAX_WIDTH));
  const w = Math.floor(width / f);
  const h = Math.floor(height / f);
  const out = new Uint8ClampedArray(w * h * 4);
  const area = f * f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < f; dy++) {
        let i = ((y * f + dy) * width + x * f) * 4;
        for (let dx = 0; dx < f; dx++, i += 4) {
          b += bgra[i + B]!;
          g += bgra[i + 1]!;
          r += bgra[i + R]!;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / area;
      out[o + 1] = g / area;
      out[o + 2] = b / area;
      out[o + 3] = 255;
    }
  }
  return { img: { width: w, height: h, data: out }, scale: f };
}

/** BGRA/RGBA → RGBA без уменьшения: своё распознавание берёт выборки и не зависит от размера кадра. */
function toFrame(width: number, height: number, buf: Uint8Array, rgba: boolean): Frame {
  if (rgba) return { width, height, data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, width * height * 4) };
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = buf[i + 2]!;
    data[i + 1] = buf[i + 1]!;
    data[i + 2] = buf[i]!;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

/** Метки из пикселей уменьшенной картинки — в пиксели кадра. */
function scaleHint(h: { text: string; marks: Any[] }, scale: number): Pick<PrisonHint, 'text' | 'marks'> {
  const p = (v: number[]) => v.map((x) => x * scale);
  return {
    text: h.text,
    marks: h.marks.map((m: Any) =>
      m.kind === 'arrow' ? { kind: 'arrow', from: p(m.from), to: p(m.to) } : m.kind === 'ring' ? { kind: 'ring', at: p(m.at), r: m.r * scale } : { kind: 'box', box: p(m.box) },
    ),
  };
}

// ---------- PNG для сохранения кадров ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Кадр BGRA/RGBA → PNG (RGB, без прозрачности). */
function encodePng(width: number, height: number, bgra: Uint8Array, rgba: boolean): Buffer {
  const R = rgba ? 0 : 2;
  const B = rgba ? 2 : 0;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const o = row + 1 + x * 3;
      raw[o] = bgra[i + R]!;
      raw[o + 1] = bgra[i + 1]!;
      raw[o + 2] = bgra[i + B]!;
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8;
  head[9] = 2;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', head), chunk('IDAT', deflateSync(raw, { level: 3 })), chunk('IEND', new Uint8Array(0))]);
}

function reply(msg: PrisonWorkerReply): void {
  port.postMessage(msg);
}

/** Модель доски — в main-процесс, чтобы пережить перезапуск Горна. */
function saveState(): void {
  reply({ type: 'state', id: 0, model: advisor.model });
}

/** Последний кадр: расчёт по более старому бросается на полпути. */
let current = 0;
/** Доска, увиденная сразу после окна сокровищницы: по ней советуется подарок. */
let boardBehindTreasure = false;
/** Где была доска на прошлом кадре того же размера: поиск рядом в 4 раза быстрее. */
let near: BoardNear | null = null;

const sleep0 = () => new Promise<void>((r) => setImmediate(r));
/** Столько проверять подарок до первой рамки. */
const GIFT_WARM_MS = 500;

/** Имена и похожие орудия — к прочитанной панели орудий. */
function nameTools(board: Any): void {
  if (!board.tools || !board.tools.tools) return;
  for (const t of board.tools.tools) {
    Object.assign(t, SCAN.toolNames[t.id] || {});
    for (const a of t.alts || []) a.sim = (SCAN.toolNames[a.id] || {}).sim;
  }
  board.tools.sims = SIMS;
}

async function handle(msg: PrisonShotMessage): Promise<void> {
  current = msg.id;
  const t0 = Date.now();
  // Окно подарков приходит без картинки: рамка ставится по месту карточки.
  const { img, scale } = msg.buffer.byteLength
    ? toImage(msg.width, msg.height, new Uint8Array(msg.buffer), msg.format === 'rgba')
    : { img: null, scale: 1 };
  const size = img ? `${img.width}x${img.height}` : '';
  const frame = { w: msg.width, h: msg.height };
  const ctx: Any = { img: img ? { w: img.width, h: img.height } : { w: msg.width, h: msg.height } };
  let kind: PrisonFrameKind | 'manual' = msg.kind;

  if (msg.asTreasure && img) {
    // Доска снята, а окно подарков уже открыто: обновить по ней доску
    // (если это точно доска, а не уже само окно), совет — по подаркам.
    const board = Scan.scan(img, REF, { near: near && near.size === size ? near : null });
    if (board.ok && !board.loc.byLabels && board.loc.score >= 0.8) {
      nameTools(board);
      advisor.board(board);
      if (msg.treasureClosed) boardBehindTreasure = true;
    }
    kind = 'treasure';
  }

  if (kind === 'treasure') {
    // Доска за сокровищницей уже видна (просмотр или подарок перед этим;
    // при «Изобилии» окна идут подряд) — совет по подарку сразу, с рамкой
    // на карточке. Иначе — попросить показать доску.
    if (boardBehindTreasure) advisor.treasure('view');
    else {
      advisor.treasure(msg.after);
      saveState();
      reply({ type: 'hint', id: msg.id, phase: 'final', frame, text: 'Подарок: нажми «Посмотреть состояние тюрьмы» и вернись — подскажу, какой взять', marks: [], live: false });
      return;
    }
  }
  if (kind === 'theme') {
    // Окно темы прежний путь не читает (его тема — с панели доски).
    reply({ type: 'clear', id: msg.id });
    return;
  }
  if (kind === 'objective') {
    if (advisor.objective(Scan.readObjectiveTitle(img))) saveState();
    reply({ type: 'clear', id: msg.id });
    return;
  }

  if (!img) {
    reply({ type: 'clear', id: msg.id });
    return;
  }
  if (kind === 'board' || kind === 'manual') {
    const board = Scan.scan(img, REF, { near: near && near.size === size ? near : null });
    // Место доски — только с уверенно найденной: на затемнённом экране
    // выбора жертвы она ставится по номерам камер, неточно, и следующий
    // обычный кадр по такой подсказке шёл в полный поиск (секунда).
    if (board.ok && !board.loc.byLabels && board.loc.score >= 0.8) {
      const moved = !near || near.size !== size || Math.abs(near.s - board.loc.s) > 0.01 || Math.abs(near.tx - board.loc.tx) > 4 || Math.abs(near.ty - board.loc.ty) > 4;
      near = { s: board.loc.s, tx: board.loc.tx, ty: board.loc.ty, size };
      if (moved) reply({ type: 'near', id: 0, near });
    }
    if (board.ok) nameTools(board);
    // Доска без дверей, без ряда решений и без выбора жертвы — экран между
    // состояниями (карточки ещё выезжают). Совет по нему был бы «Завершить
    // день»: лучше ничего, а автокадр переснимется.
    // Доска после взятого подарка — тоже без дверей: её совет «Завершить
    // день» мелькал между окнами «Изобилия». Её только запомнить (по ней
    // советуется следующий подарок). Совет нужен лишь на просмотре доски
    // из сокровищницы.
    if (board.ok && !msg.treasureView && !(board.doors && board.doors.cells.length) && !board.decision && !board.chain) {
      if (msg.treasureClosed && !board.loc.byLabels) {
        nameTools(board);
        advisor.board(board);
        boardBehindTreasure = true;
        saveState();
      }
      reply({ type: 'clear', id: msg.id });
      return;
    }
    if (board.ok) {
      // Цель забега — с панели слева на каждом кадре: окно цели в начале
      // забега могло пройти мимо (Горн перезапускали, кадр не снялся).
      const goal = board.objective ? Scan.readObjectiveTitle(img, board.objective) : null;
      if (goal && goal.id && goal.id !== advisor.model.objective) advisor.objective(goal);
      advisor.board(board);
      boardBehindTreasure = !!msg.treasureClosed;
      // Просмотр доски из сокровищницы: совет по подарку сразу (текстом —
      // карточек на этом экране нет).
      if (msg.treasureView) advisor.treasure('view');
      ctx.scan = board;
      kind = 'board';
    } else if (kind === 'board') {
      reply({ type: 'clear', id: msg.id });
      return;
    }
  }
  if (kind === 'instruments' || kind === 'manual') {
    const p = Scan.scanPick(img, SCAN, PICK);
    // Неузнанная карта (нет эталона) не должна глушить совет по двум
    // остальным и по «Обновить»: выбор — из узнанных, игроку — пометка.
    const sure = p.ok ? p.cards.filter((c: Any) => c && c.conf >= 0.3) : [];
    if (!p.ok || sure.length < 2) {
      reply({ type: 'clear', id: msg.id });
      return;
    }
    ctx.unsure = p.cards.length - sure.length;
    p.cards = sure;
    // После «Обновить» кнопка видна, но обновлений не осталось.
    if (msg.rerolled) p.reroll = false;
    advisor.pick(p, msg.fresh);
    ctx.pick = p;
  }
  saveState();

  const run = advisor.begin();
  if (!run || run.problems) {
    // Выбор жертвы в цепочке, а модель не объясняет подсвеченные цели
    // (орудие меняет, кто кого ест, или редкость на тёмном экране прочиталась
    // не так): экрану верить больше — совет по самой редкой из подсвеченных,
    // а не молчание на каждом кадре до конца цепочки.
    const targets: number[] = ctx.scan?.chain?.targets ?? [];
    if (run?.problems && targets.length) {
      const tierOf = (n: number) => {
        const known = advisor.model.cells[n];
        const seen = ctx.scan.cells[n];
        return Math.max(known && known.kind === 'inmate' ? known.tier : -1, seen && seen.kind === 'inmate' ? seen.tier : -1);
      };
      const to = targets.reduce((a, b) => (tierOf(b) > tierOf(a) ? b : a));
      const h = hint({ action: { type: 'chain', to } }, { ...ctx, st: null });
      console.log(`[тюрьма] кадр ${msg.id}: модель не сходится с экраном (${run.problems.join(', ')}), совет по подсвеченным целям`);
      if (h) {
        reply({ type: 'hint', id: msg.id, phase: 'final', frame, live: false, ...scaleHint(h, scale) });
        return;
      }
    }
    if (run?.problems) console.log(`[тюрьма] кадр ${msg.id}: нет совета (${run.problems.join(', ')})`);
    reply({ type: 'clear', id: msg.id });
    return;
  }
  let sent = '';
  const send = (rec: Any, phase: 'instant' | 'final') => {
    if (!rec) return;
    ctx.st = run.st;
    const h = hint(rec, ctx);
    if (!h) return;
    if (ctx.unsure) h.text += ' · одну карту не узнал';
    const key = JSON.stringify(rec.action);
    if (phase === 'final' && key === sent) {
      reply({ type: 'settled', id: msg.id, live: !!rec.live });
      return;
    }
    sent = key;
    reply({ type: 'hint', id: msg.id, phase, frame, live: !!rec.live, ...scaleHint(h, scale) });
  };
  // Подарок: мгновенный выбор стратегии часто переигрывается проверкой
  // (рамка прыгала с карточки на карточку) — сначала немного проверить.
  let rec = run.instant;
  const m = advisor.model;
  if (m.step === 'choice' && m.choice && m.choice.kind === 'gift') {
    const warm = Date.now() + GIFT_WARM_MS;
    while (!run.done && Date.now() < warm) {
      await sleep0();
      if (current !== msg.id) return;
      rec = run.step(100);
    }
  }
  if (rec) {
    send(rec, run.done ? 'final' : 'instant');
    console.log(`[тюрьма] кадр ${msg.id}: совет через ${Date.now() - t0} мс`);
    if (run.done) return;
  }
  // Проверка вариантами — кусками, с паузой на новые сообщения: пришёл
  // новый кадр — этот расчёт больше никому не нужен.
  const until = Date.now() + msg.budgetMs;
  while (!run.done && Date.now() < until) {
    await sleep0();
    if (current !== msg.id) return;
    rec = run.step(150);
  }
  if (current !== msg.id) return;
  send(rec, 'final');
}

const own = engine === 'own' ? new OwnAdvisor(reply) : null;

port.on('message', (e) => {
  const msg = e.data as PrisonShotMessage | { type: 'reset' } | { type: 'init'; state: unknown; near: SavedNear | null };
  if (own) {
    if (msg.type === 'init') own.init(msg.state, msg.near);
    else if (msg.type === 'reset') own.reset();
    else {
      const keep = msg.savePath ? new Uint8Array(msg.buffer.slice(0)) : null;
      const frame = msg.buffer.byteLength ? toFrame(msg.width, msg.height, new Uint8Array(msg.buffer), msg.format === 'rgba') : null;
      void own
        .handle(msg, frame)
        .catch((err: unknown) => reply({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) }))
        .finally(() => savePng(msg, keep));
    }
    return;
  }
  if (msg.type === 'init') {
    near = msg.near && 'size' in msg.near ? msg.near : null;
    if (msg.state) {
      try {
        advisor.load(msg.state);
      } catch {
        // Испорченное сохранение — начинаем с чистой доски.
      }
    }
    return;
  }
  if (msg.type === 'reset') {
    advisor.reset();
    saveState();
    return;
  }
  // Пиксели нужны и для PNG: копия до того, как разбор их отдаст.
  const keep = msg.savePath ? new Uint8Array(msg.buffer.slice(0)) : null;
  void handle(msg)
    .catch((err: unknown) => reply({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) }))
    .finally(() => savePng(msg, keep));
});

/** PNG — после совета: игроку важнее подсказка, чем файл. */
function savePng(msg: PrisonShotMessage, keep: Uint8Array | null): void {
  if (!keep || !msg.savePath) return;
  try {
    mkdirSync(dirname(msg.savePath), { recursive: true });
    writeFileSync(msg.savePath, encodePng(msg.width, msg.height, keep, msg.format === 'rgba'));
  } catch (err) {
    console.warn('[тюрьма] кадр не сохранён:', err instanceof Error ? err.message : err);
  }
}
