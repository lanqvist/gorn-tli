/**
 * Иконка приложения: build/icon.png (256×256) и build/icon.ico.
 *
 *   node scripts/make-icon.mjs
 *
 * Рисуем и кодируем сами, без графических пакетов и без Chromium:
 * попытка отрисовать webp через Electron упиралась в то, что снимок
 * со скрытого окна не отдаётся, а ради одного файла держать зависимость
 * от браузерного движка незачем.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 256;

/** Минимальный кодировщик PNG: RGBA без фильтрации. */
function encodePng(width, height, rgba) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // бит на канал
  ihdr.writeUInt8(6, 9); // цветовой тип: RGBA
  // сжатие, фильтрация, чересстрочность — по умолчанию нулями

  // Каждой строке предшествует байт фильтра.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/**
 * ICO — контейнер, в который PNG кладётся как есть.
 * Шесть байт заголовка, запись каталога на шестнадцать, дальше данные.
 */
function pngToIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0);
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);

  return Buffer.concat([header, entry, png]);
}

/** Цвета взяты из интерфейса: подложка и акцент. */
const BG = [23, 25, 34];
const FLAME_HOT = [255, 196, 92];
const FLAME_COOL = [214, 74, 42];

const pixels = Buffer.alloc(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;

    // Скруглённая подложка.
    const r = SIZE * 0.22;
    const dx = Math.max(r - x, 0, x - (SIZE - r));
    const dy = Math.max(r - y, 0, y - (SIZE - r));
    const corner = Math.hypot(dx, dy);
    const inside = corner <= r ? 1 : Math.max(0, 1 - (corner - r));

    // Пламя: язык, сужающийся кверху и подобранный книзу.
    const u = (x - SIZE / 2) / (SIZE * 0.5);
    const v = (y - SIZE * 0.5) / (SIZE * 0.42);
    // Ширина максимальна чуть ниже середины, к обоим концам сходит на нет.
    const taper = Math.cos(v * 1.15) ** 1.7;
    const wave = 0.05 * Math.sin(v * 4.6);
    const flame = Math.abs(u) / Math.max(0.001, taper * 0.62 + wave);
    // Резкая граница: множитель больше — уже переходная зона.
    const inFlame = Math.max(0, Math.min(1, (1 - flame) * 14));

    // Внутри пламени цвет теплеет к низу.
    const heat = Math.max(0, Math.min(1, (v + 0.9) / 1.6));
    const flameColor = [0, 1, 2].map((c) =>
      Math.round(FLAME_COOL[c] + (FLAME_HOT[c] - FLAME_COOL[c]) * heat),
    );

    for (let c = 0; c < 3; c++) {
      pixels[i + c] = Math.round(BG[c] + (flameColor[c] - BG[c]) * inFlame);
    }
    pixels[i + 3] = Math.round(255 * inside);
  }
}

const png = encodePng(SIZE, SIZE, pixels);
const ico = pngToIco(png, SIZE);

mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build/icon.png'), png);
writeFileSync(join(root, 'build/icon.ico'), ico);

console.log(`build/icon.png  ${png.length} байт`);
console.log(`build/icon.ico  ${ico.length} байт`);
