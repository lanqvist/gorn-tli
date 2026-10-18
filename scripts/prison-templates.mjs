// Сборка эталонов распознавания тюрьмы из своих размеченных кадров.
//
//   node --import tsx scripts/prison-templates.mjs [шаг…]
//
// Шаги: board (карта доски и подписи номеров), cells (портреты, редкости,
// значки на камерах), digits (цифры дней и дверей), cards (ряд решений,
// карточки дверей), tools (орудия на панели и на картах выбора),
// objective (цели). Без шагов — все по порядку.
//
// Источники (см. README в папке данных):
//   ~/Documents/gorn-prison-data/images, labels — кадры и ручная разметка;
//   ~/Pictures/Горн — тюрьма/<дата>/ — кадры Горна 1920×1080;
//   ~/Documents/gorn-prison-data/labels/gorn-*.json — своя разметка кадров Горна.
// Набор labels/boards-ru4k.json в сборку не идёт: он для честной проверки.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decodePng } from '../src/core/prison/recognize/png.ts';
import { boardScore, gradient } from '../src/core/prison/recognize/geometry.ts';
import { NUMBER } from '../src/core/prison/recognize/layout.ts';
import { normalize, sample } from '../src/core/prison/recognize/sample.ts';
import { encodeU8, pack, unpack } from '../src/core/prison/recognize/templates.ts';
import { glyphs, glyphVec } from '../src/core/prison/recognize/text.ts';
import { NUMBER_RX, NUMBER_RY, calibrate } from '../src/core/prison/recognize/geometry.ts';
import { FACE, JAW, LOCK_RX, LOCK_RY, colorShare, faceVec, glow, isJawRed, jawVec, preyVec } from '../src/core/prison/recognize/cells.ts';
import {
  CHAIN_BANNER,
  CHROMATIC_HEADER,
  HEADER,
  HEADER_H,
  HEADER_W,
  LOCK,
  OBJECTIVE,
  PICK_CARDS,
  PICK_HEADER,
  PICK_REROLL,
  TOOL_SLOTS,
  TREASURE_CARDS,
  chromaticSlot,
  pickArt,
  pickTitle,
  portrait,
  toolSlot,
  treasureArt,
} from '../src/core/prison/recognize/layout.ts';
import { cardCenters, cardIconVec } from '../src/core/prison/recognize/cards.ts';

export const DATA = process.env.GORN_PRISON_DATA ?? join(homedir(), 'Documents', 'gorn-prison-data');
// Папка «Горн — тюрьма» — кольцевой буфер: старые кадры удаляются. Поэтому
// кадры, по которым собраны эталоны, скопированы в папку данных.
export const SHOTS = process.env.GORN_PRISON_SHOTS ?? join(DATA, 'images', 'gorn');
const OUT = new URL('../src/core/prison/recognize/templates/', import.meta.url);

const IDENTITY = { width: 1920, height: 1080, s: 1, tx: 0, ty: 0, score: 1 };

/** Кадры Горна: [{ path, name }] по всем датам. */
export function gornFrames(kind) {
  if (!existsSync(SHOTS)) return [];
  const out = [];
  for (const day of readdirSync(SHOTS).sort()) {
    const dir = join(SHOTS, day);
    for (const f of readdirSync(dir).sort()) {
      if (f.endsWith('.png') && (!kind || f.includes(`-${kind}.`))) out.push({ path: join(dir, f), name: `${day}/${f}` });
    }
  }
  return out;
}

export function load(path) {
  return decodePng(readFileSync(path));
}

function write(name, obj) {
  writeFileSync(new URL(name, OUT), JSON.stringify(obj) + '\n');
  console.log('записан', name);
}

// ── board ──────────────────────────────────────────────────────────────────
// Подписи номеров — с одного чистого кадра доски; карта перепадов — среднее
// по всем кадрам доски Горна (меняющееся содержимое камер усредняется,
// остаются стены и рамка).
const GRAD = { x0: 380, y0: 30, cell: 4, w: 290, h: 168 };
const REF_BOARD = '2026-10-17/221250-472-board.png';

function buildBoard() {
  const ref = load(join(SHOTS, REF_BOARD));
  const numbers = NUMBER.map(([x, y]) => {
    const v = sample(ref, IDENTITY, [x - NUMBER_RX, y - NUMBER_RY, x + NUMBER_RX, y + NUMBER_RY], NUMBER_RX * 2, NUMBER_RY * 2);
    normalize(v);
    return pack(v);
  });
  const tpl = { grad: { ...GRAD, data: '' }, numbers: numbers.map(unpack) };
  const sum = new Float32Array(GRAD.w * GRAD.h);
  let n = 0;
  for (const f of gornFrames('board')) {
    const frame = load(f.path);
    if (frame.width !== 1920 || frame.height !== 1080) continue;
    if (boardScore(frame, IDENTITY, tpl) < 0.9) continue;
    const lum = sample(frame, IDENTITY, [GRAD.x0, GRAD.y0, GRAD.x0 + GRAD.w * GRAD.cell, GRAD.y0 + GRAD.h * GRAD.cell], GRAD.w, GRAD.h);
    const g = gradient(lum, GRAD.w, GRAD.h);
    for (let i = 0; i < g.length; i++) sum[i] += g[i];
    n++;
  }
  let max = 0;
  for (const v of sum) max = Math.max(max, v);
  const bytes = new Uint8Array(sum.length);
  for (let i = 0; i < sum.length; i++) bytes[i] = Math.round((sum[i] / max) * 255);
  console.log(`board: ${n} кадров доски в среднем`);
  write('board.json', { grad: { ...GRAD, data: encodeU8(bytes) }, numbers });
}


// ── общее ──────────────────────────────────────────────────────────────────

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Ручная разметка из папки данных (без служебного _about). */
export function labels(name) {
  const path = join(DATA, 'labels', name);
  if (!existsSync(path)) return {};
  const { _about, ...rest } = readJson(path);
  return rest;
}

/**
 * Путь к кадру по ключу разметки: «ru/…», «ru4k/…», «ru1080/…», «gorn-new/…»
 * (внутри images/) или «<дата>/…» (кадры Горна в SHOTS).
 */
export function framePath(key) {
  if (/^(ru(4k|1080)?|gorn-new)\//.test(key)) return join(DATA, 'images', key);
  return join(SHOTS, key);
}

const frameCache = new Map();
/** Кадр и его геометрия (калибровка один раз на кадр). */
export function frameAt(key) {
  let hit = frameCache.get(key);
  if (!hit) {
    const frame = load(framePath(key));
    const geo = frame.width === 1920 && frame.height === 1080 && /^(gorn-new\/)?\d/.test(key) ? IDENTITY : calibrate(frame);
    hit = { frame, geo };
    if (frameCache.size > 60) frameCache.clear();
    frameCache.set(key, hit);
  }
  return hit;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** k-средних по косинусу: k нормированных прототипов из нормированных векторов. */
export function prototypes(vectors, k, seed = 1) {
  if (vectors.length <= k) return vectors.map((v) => Float32Array.from(v));
  let rnd = seed;
  const next = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;
  const cents = [Float32Array.from(vectors[0])];
  while (cents.length < k) {
    const d = vectors.map((v) => 1 - Math.max(...cents.map((c) => dot(v, c))));
    let r = next() * d.reduce((a, b) => a + b, 0);
    let i = 0;
    while ((r -= d[i]) > 0 && i < d.length - 1) i++;
    cents.push(Float32Array.from(vectors[i]));
  }
  for (let it = 0; it < 15; it++) {
    const sums = cents.map((c) => new Float32Array(c.length));
    for (const v of vectors) {
      let best = 0;
      let bs = -2;
      cents.forEach((c, j) => {
        const s = dot(v, c);
        if (s > bs) {
          bs = s;
          best = j;
        }
      });
      for (let i = 0; i < v.length; i++) sums[best][i] += v[i];
    }
    sums.forEach((m, j) => {
      if (m.some((x) => x !== 0)) {
        normalize(m);
        cents[j] = m;
      }
    });
  }
  return cents;
}

// ── cells ──────────────────────────────────────────────────────────────────
// Портреты: прототипы k-средних по классам из своей разметки камер
// (labels/gorn-cells.json, labels/boards-ru.json). Замок и клыки — средний
// нормированный вид по многим кадрам.

/** Разметка камер: ключ кадра → { номер 1–16: класс }. */
function cellLabels() {
  const out = {};
  for (const [key, cells] of Object.entries(labels('gorn-cells.json'))) out[key] = cells;
  for (const [name, b] of Object.entries(labels('boards-ru.json'))) {
    const cells = {};
    for (const [n, v] of Object.entries(b.inmates)) cells[n] = v.split('/')[0];
    for (const n of b.locked) cells[n] = 'locked';
    out[`ru/${name}`] = cells;
  }
  return out;
}

function buildCells() {
  const byClass = {};
  const lockSum = new Float32Array(18 * 27);
  const jawSum = new Float32Array(JAW.w * JAW.h);
  let jaws = 0;
  let locks = 0;
  for (const [key, cells] of Object.entries(cellLabels())) {
    const { frame, geo } = frameAt(key);
    if (!geo) {
      console.warn('нет доски на', key);
      continue;
    }
    for (const [n, cls] of Object.entries(cells)) {
      const c = Number(n) - 1;
      (byClass[cls] ??= []).push(faceVec(frame, geo, c));
      if (cls === 'locked' && locks < 600) {
        const [x, y] = LOCK[c];
        const v = sample(frame, geo, [x - LOCK_RX, y - LOCK_RY, x + LOCK_RX, y + LOCK_RY], 18, 27);
        normalize(v);
        for (let i = 0; i < v.length; i++) lockSum[i] += v[i];
        locks++;
      }
      // Клыки: красного над портретом много, а свечение вокруг не красное и не оранжевое.
      if (cls !== 'locked' && cls !== 'unknown' && jaws < 400) {
        const [px, py] = portrait(c);
        const red = colorShare(frame, geo, [px - 18, py - 42, px + 18, py - 20], 2, isJawRed);
        const g = glow(frame, geo, c);
        if (red > 0.45 && g[16 + 1] + g[16 + 2] < 0.02) {
          const v = jawVec(frame, geo, c);
          for (let i = 0; i < v.length; i++) jawSum[i] += v[i];
          jaws++;
        }
      }
    }
  }
  normalize(lockSum);
  normalize(jawSum);
  const K = { locked: 10, unknown: 6, mammoth: 8, lion: 8, wolf: 8, rat: 8 };
  const beasts = [];
  for (const [cls, vs] of Object.entries(byClass)) {
    for (const v of prototypes(vs, K[cls] ?? 6)) beasts.push({ label: cls, v: pack(v) });
    console.log(`cells: ${cls} — ${vs.length} образцов`);
  }
  console.log(`cells: замков ${locks}, клыков ${jaws}`);
  write('cells.json', { lock: pack(lockSum), jaw: pack(jawSum), face: FACE, beasts });
}

// ── digits ─────────────────────────────────────────────────────────────────
// Цифры дней до бунта (крупные) с кадров Горна по своей разметке дней; тем
// же шрифтом написаны номера на карточках дверей, картинка знака
// нормируется по его рамке, поэтому эталоны общие.

export const DAY_BAND = [700, 8, 1220, 52];
export const DAY_INK = { contrast: 70, maxSat: 0.3 };

function buildDigits() {
  const byDigit = Array.from({ length: 10 }, () => []);
  const aspects = Array.from({ length: 10 }, () => []);
  const sets = [labels('gorn-screens.json')];
  for (const [key, v] of Object.entries(sets[0])) {
    if (v.days === undefined) continue;
    const { frame, geo } = frameAt(key);
    const gs = glyphs(frame, geo, DAY_BAND, DAY_INK).filter((g) => g.y1 - g.y0 >= 24 * geo.s);
    const ds = String(v.days);
    if (gs.length !== ds.length) {
      console.warn('digits: не то число знаков', key, gs.length, ds);
      continue;
    }
    gs.forEach((g, i) => {
      const d = Number(ds[i]);
      byDigit[d].push(glyphVec(frame, g));
      aspects[d].push((g.x1 - g.x0) / (g.y1 - g.y0));
    });
  }
  const protos = [];
  byDigit.forEach((vs, d) => {
    if (vs.length === 0) console.warn('digits: нет образцов цифры', d);
    for (const v of prototypes(vs, 3)) protos.push({ d, v: pack(v) });
  });
  const aspect = aspects.map((a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 1000) / 1000 : 0.5));
  console.log('digits:', byDigit.map((v, d) => `${d}:${v.length}`).join(' '));
  write('digits.json', { protos, aspect });
}

// ── screens ────────────────────────────────────────────────────────────────
// Надписи, карточки решений, панель орудий, хранилище, цель, выбор орудий,
// сокровищница: прототипы нормированных картинок областей по своей разметке
// (labels/gorn-screens.json, gorn-picks.json, screens-ru.json,
// boards-ru.json, picks-panels-digits.json).

function vecOf(frame, geo, box, w, h, ch) {
  const v = sample(frame, geo, box, w, h, ch);
  normalize(v);
  return v;
}

/** Классы → прототипы: { label, v }[]. */
function protoList(byLabel, k) {
  const out = [];
  for (const [label, vs] of Object.entries(byLabel)) {
    for (const v of prototypes(vs, k)) out.push({ label, v: pack(v) });
  }
  return out;
}

function push(map, label, v) {
  (map[label] ??= []).push(v);
}

/** Геометрия экрана без доски (выбор орудий, сокровищница): по умолчанию. */
function plainGeo(frame) {
  const s = Math.min(frame.height / 1080, frame.width / 1920);
  return { width: frame.width, height: frame.height, s, tx: (frame.width - 1920 * s) / 2, ty: (frame.height - 1080 * s) / 2, score: 0 };
}

function buildScreens() {
  const headers = {};
  const cards = {};
  const tools = {};
  const chroma = {};
  const objectives = {};
  const chromaHeader = [];
  const preySum = new Float32Array(16 * 18 * 3);
  let preyN = 0;
  const gorn = { ...labels('gorn-screens.json'), ...labels('gorn-new-screens.json') };
  const ru = labels('screens-ru.json');
  const boardsRu = labels('boards-ru.json');
  const panelsRu = labels('picks-panels-digits.json').panels;

  const boardFrames = [];
  for (const [key, v] of Object.entries(gorn)) boardFrames.push([key, v]);
  for (const [key, v] of Object.entries(ru)) if (v.screen === 'board') boardFrames.push([key, { ...v, header: v.phase === 'office' ? 'manage' : v.phase }]);
  for (const [name, b] of Object.entries(boardsRu)) {
    const key = `ru/${name}`;
    const extra = { tools: b.tools.map((t) => (t === 'casket' ? 'revenge' : t)), chromatic: b.chromatic };
    const i = boardFrames.findIndex(([k]) => k === key);
    if (i >= 0) Object.assign(boardFrames[i][1], extra);
    else boardFrames.push([key, extra]);
  }
  for (const [key, list] of Object.entries(panelsRu)) {
    const i = boardFrames.findIndex(([k]) => k === key);
    if (i >= 0) boardFrames[i][1] = { ...boardFrames[i][1], tools: list };
    else boardFrames.push([key, { tools: list }]);
  }

  for (const [key, v] of boardFrames) {
    const { frame, geo } = frameAt(key);
    if (!geo) {
      console.warn('screens: нет доски на', key);
      continue;
    }
    if (v.header === 'patrol' || v.header === 'manage' || v.header === 'ratway') {
      push(headers, v.header, vecOf(frame, geo, HEADER, HEADER_W, HEADER_H, 1));
    } else if (v.header === undefined && v.phase === undefined && key.startsWith('20')) {
      // Кадры Горна без надписи над карточками (цепочка, переходы).
      push(headers, 'none', vecOf(frame, geo, HEADER, HEADER_W, HEADER_H, 1));
    }
    if (v.cards) {
      const centers = cardCenters(frame, geo);
      if (centers.length === v.cards.length) v.cards.forEach((c, i) => push(cards, c, cardIconVec(frame, geo, centers[i])));
    }
    if (v.tools) {
      for (let i = 0; i < TOOL_SLOTS; i++) push(tools, v.tools[i] ?? 'empty', vecOf(frame, geo, toolSlot(i), 12, 18, 3));
    }
    if (v.chromatic !== undefined && v.chromatic >= 0) {
      for (let i = 0; i < 10; i++) push(chroma, i < v.chromatic ? 'filled' : 'empty', vecOf(frame, geo, chromaticSlot(i), 12, 16, 3));
      if (chromaHeader.length < 200) chromaHeader.push(vecOf(frame, geo, CHROMATIC_HEADER, 92, 20, 1));
    }
    if (v.objective) push(objectives, v.objective, vecOf(frame, geo, OBJECTIVE, 80, 15, 1));
    // Метка «Добыча»: номера камер (с 1), где на портрете прицел.
    // Прицел мелкий и резкий: сдвиг на полпикселя заметно меняет картинку. Эталон —
    // по калиброванной геометрии (как в работе) и со сдвигами ±1 px.
    if (v.prey?.length) {
      const cal = calibrate(frame) ?? geo;
      for (const n of v.prey) {
        for (const dx of [-1, 0, 1]) {
          for (const dy of [-1, 0, 1]) {
            const pv = preyVec(frame, { ...cal, tx: cal.tx + dx * cal.s, ty: cal.ty + dy * cal.s }, n - 1);
            for (let i = 0; i < pv.length; i++) preySum[i] += pv[i];
          }
        }
        preyN++;
      }
    }
  }
  normalize(preySum);
  // «Путь обхода тюрьмы» на кадрах ru/ — та же цель.
  for (const [name] of Object.entries(boardsRu)) {
    const { frame, geo } = frameAt(`ru/${name}`);
    if (geo) push(objectives, 'walk', vecOf(frame, geo, OBJECTIVE, 80, 15, 1));
  }

  // Выбор орудий: картинка и название каждой карты.
  const art = {};
  const titles = {};
  const pickHeaders = {};
  const reroll = { yes: [], no: [] };
  const picks = [];
  for (const [key, list] of Object.entries(labels('picks-panels-digits.json').picks)) picks.push([key, { cards: list, ...(ru[key] ?? {}) }]);
  for (const [key, v] of Object.entries(labels('gorn-picks.json'))) picks.push([key, v]);
  // Карты выбора — только с кадров выбора; на кадрах доски cards — ряд решений.
  for (const [key, v] of Object.entries(labels('gorn-new-screens.json'))) if (v.cards && !key.endsWith('-board.png')) picks.push([key, v]);
  for (const [key, v] of picks) {
    const frame = load(framePath(key));
    const geo = plainGeo(frame);
    v.cards.forEach((id, i) => {
      const cx = PICK_CARDS[i];
      push(art, id, vecOf(frame, geo, pickArt(cx), 16, 16, 3));
      push(titles, id, vecOf(frame, geo, pickTitle(cx), 86, 11, 1));
    });
    if (v.reward !== undefined) push(pickHeaders, v.reward ? 'reward' : 'start', vecOf(frame, geo, PICK_HEADER, 100, 6, 1));
    if (v.reroll === true) reroll.yes.push(vecOf(frame, geo, PICK_REROLL, 44, 10, 1));
  }

  // Сокровищница: четыре подарка по порядку.
  const gifts = {};
  const treasureKeys = Object.entries(ru).filter(([, v]) => v.screen === 'treasure').map(([k]) => k);
  for (const key of treasureKeys) {
    const frame = load(framePath(key));
    const geo = plainGeo(frame);
    ['ring', 'horn', 'wine', 'brand'].forEach((id, i) => push(gifts, id, vecOf(frame, geo, treasureArt(TREASURE_CARDS[i]), 16, 16, 3)));
  }

  for (const [name, m] of Object.entries({ headers, cards, tools, chroma, objectives, art, titles, pickHeaders, gifts })) {
    console.log(`screens: ${name} — ${Object.entries(m).map(([k, v]) => `${k}:${v.length}`).join(' ')}`);
  }
  write('screens.json', {
    headers: protoList(headers, 4),
    cards: protoList(cards, 3),
    tools: protoList(tools, 3),
    chromatic: protoList(chroma, 16),
    chromaticHeader: prototypes(chromaHeader, 2).map(pack),
    objectives: protoList(objectives, 3),
    pickArt: protoList(art, 2),
    pickTitles: protoList(titles, 2),
    pickHeaders: protoList(pickHeaders, 2),
    reroll: prototypes(reroll.yes, 2).map(pack),
    gifts: protoList(gifts, 2),
    ...(preyN ? { prey: pack(preySum) } : {}),
  });
  console.log(`screens: метка «Добыча» — ${preyN} образцов`);
}

const STEPS = { board: buildBoard, cells: buildCells, digits: buildDigits, screens: buildScreens };

const want = process.argv.slice(2);
for (const [name, fn] of Object.entries(STEPS)) {
  if (want.length === 0 || want.includes(name)) fn();
}
