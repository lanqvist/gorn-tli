/**
 * Поток подсказок в тюрьме: кадр игры → распознавание → ход → метки.
 *
 * Симулятор свой (src/core/prison: распознавание, память забега, движок,
 * стратегия и проверка вариантами), связка с кадрами — ownAdvisor.ts. Здесь
 * только процесс: кадр приходит из main-процесса (BGRA, как отдаёт
 * desktopCapturer, или RGBA из потока экрана), уходят тексты и метки в
 * пикселях кадра. Расчёт тяжёлый, поэтому он в отдельном процессе
 * (utilityProcess) с пониженным приоритетом: не тормозит ни интерфейс и
 * разбор лога Горна, ни саму игру.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync } from 'node:zlib';
import { constants, setPriority } from 'node:os';

import type { Frame } from '../../core/prison/recognize/types.js';
import { OwnAdvisor } from './ownAdvisor.js';
import type { PrisonShotMessage, PrisonWorkerReply, SavedNear } from './protocol.js';

/** Канал к main-процессу Горна (Electron utilityProcess). */
const port = (process as unknown as { parentPort: { postMessage(m: unknown): void; on(ev: 'message', fn: (e: { data: unknown }) => void): void } }).parentPort;
try {
  // Игра важнее подсказки: процессор ей, расчёт — в остаток.
  setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  // Нет прав на смену приоритета — считаем как есть.
}

/** BGRA/RGBA → RGBA без уменьшения: распознавание берёт выборки и не зависит от размера кадра. */
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

const own = new OwnAdvisor(reply);

port.on('message', (e) => {
  const msg = e.data as PrisonShotMessage | { type: 'reset' } | { type: 'init'; state: unknown; near: SavedNear | null };
  if (msg.type === 'init') {
    own.init(msg.state, msg.near);
    return;
  }
  if (msg.type === 'reset') {
    own.reset();
    return;
  }
  // Пиксели нужны и для PNG: копия до того, как разбор их отдаст.
  const keep = msg.savePath ? new Uint8Array(msg.buffer.slice(0)) : null;
  const frame = msg.buffer.byteLength ? toFrame(msg.width, msg.height, new Uint8Array(msg.buffer), msg.format === 'rgba') : null;
  void own
    .handle(msg, frame)
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
