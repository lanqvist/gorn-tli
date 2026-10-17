/**
 * PNG без зависимостей: чтение кадров для тестов и сборки эталонов, запись
 * вырезок для проверки глазами. Только 8 бит на канал, без чересстрочности.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import type { Frame } from './types.js';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function decodePng(buf: Uint8Array): Frame {
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIGNATURE[i]) throw new Error('не PNG');
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos < buf.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4]!, buf[pos + 5]!, buf[pos + 6]!, buf[pos + 7]!);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      const depth = body[8]!;
      colorType = body[9]!;
      if (depth !== 8) throw new Error(`PNG: глубина ${depth} не поддержана`);
      if (body[12] !== 0) throw new Error('PNG: чересстрочный не поддержан');
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8ClampedArray(width * height * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++]!;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      let v = raw[src++]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    let o = y * width * 4;
    for (let x = 0; x < width; x++, o += 4) {
      if (colorType === 6) {
        out[o] = cur[x * 4]!;
        out[o + 1] = cur[x * 4 + 1]!;
        out[o + 2] = cur[x * 4 + 2]!;
        out[o + 3] = cur[x * 4 + 3]!;
      } else if (colorType === 2) {
        out[o] = cur[x * 3]!;
        out[o + 1] = cur[x * 3 + 1]!;
        out[o + 2] = cur[x * 3 + 2]!;
        out[o + 3] = 255;
      } else if (colorType === 3 && palette) {
        const i = cur[x]!;
        out[o] = palette[i * 3]!;
        out[o + 1] = palette[i * 3 + 1]!;
        out[o + 2] = palette[i * 3 + 2]!;
        out[o + 3] = trns && i < trns.length ? trns[i]! : 255;
      } else {
        const g = cur[x * channels]!;
        out[o] = g;
        out[o + 1] = g;
        out[o + 2] = g;
        out[o + 3] = colorType === 4 ? cur[x * 2 + 1]! : 255;
      }
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return { width, height, data: out };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** RGBA → PNG (фильтр «нет», для отладочных вырезок). */
export function encodePng(frame: Frame): Buffer {
  const { width, height, data } = frame;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
