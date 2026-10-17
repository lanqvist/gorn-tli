/**
 * Доска тюрьмы: камеры, надзиратель, значки. Работает при известной
 * геометрии (geometry.ts) и читает только маленькие области кадра.
 */
import type { Beast, BoardView, Box as ViewBox, CellView, Tier } from '../view.js';
import { cardBox, cardCenters, classifyCard, readDoorNumber } from './cards.js';
import {
  borderColor,
  chainJawShare,
  eventShare,
  faceVec,
  FACE_LEN,
  glow,
  GLOW_BINS,
  isGold,
  colorShare,
  jawVec,
  JAW,
  lockScore,
} from './cells.js';
import { CANCEL, CELL_R, CHAIN_BANNER, DAYS, HEADER, HEADER_H, HEADER_W, WARDEN, portrait } from './layout.js';
import { readChromatic, readObjective, readTools } from './panels.js';
import { boxToFrame, dot, hsv, normalize, sample, toFrame } from './sample.js';
import type { CellsTemplate, ScreensTemplate } from './templates.js';
import { nearest } from './templates.js';
import type { DigitSet } from './text.js';
import { glyphs, readDigit } from './text.js';
import type { Frame, Geometry } from './types.js';

const BEASTS: readonly string[] = ['mammoth', 'lion', 'wolf', 'rat'];

/** Пороги, подобранные по своим кадрам (scripts/prison-templates.mjs, кадры Горна). */
const LOCK_SURE = 0.5;
const LOCK_MAYBE = 0.25;
const PORTRAIT_MIN = 0.5;
const EVENT_MIN = 0.08;
const JAW_MIN = 0.63;
const CHAIN_JAW_MIN = 0.05;
const WARDEN_MIN = 0.12;

const faceBuf = new Float32Array(FACE_LEN);
const jawBuf = new Float32Array(JAW.w * JAW.h);
const glowBuf = new Float32Array(3 * GLOW_BINS.length);

/** Лучший класс портрета и его сходство. */
export function classifyFace(frame: Frame, geo: Geometry, cell: number, t: CellsTemplate): { label: string; score: number } {
  faceVec(frame, geo, cell, faceBuf);
  let label = '';
  let score = -2;
  for (const p of t.beasts) {
    const s = dot(faceBuf, p.v);
    if (s > score) {
      score = s;
      label = p.label;
    }
  }
  return { label, score };
}

const G_RED = 1;
const G_ORANGE = 2;
const G_YELLOW = 3;
const G_GREEN = 4;

/**
 * Редкость по рамке портрета и свечению вокруг. Рамка: синяя — Магическая,
 * фиолетовая — Редкая, тёплая ненасыщенная (серебро) — Обычная, тёплая
 * насыщенная — Легендарная или Величайшая; их различает пламя вокруг
 * (оранжевое или красное). Зелёное в свечении бывает только у радужной.
 */
export function readTier(frame: Frame, geo: Geometry, cell: number, chainTarget = false): Tier {
  const [r, g, b] = borderColor(frame, geo, cell);
  const [h, s] = hsv(r, g, b);
  const gl = glow(frame, geo, cell, glowBuf);
  const both = 2 * GLOW_BINS.length;
  if (gl[both + G_GREEN]! > 0.04 && !chainTarget) return 5;
  if (s >= 0.12 && h >= 180 && h < 252) return 1;
  if (s >= 0.12 && h >= 252 && h < 330) return 2;
  if (s < 0.3) return 0;
  // На цели цепочки вокруг портрета красное пламя клыков: смотрим только рамку.
  if (chainTarget) return h >= 12 && h < 70 ? 3 : 4;
  const red = gl[both + G_RED]!;
  const orange = gl[both + G_ORANGE]! + gl[both + G_YELLOW]!;
  if (red > orange) return 4;
  if (orange > red) return 3;
  return h >= 12 && h < 70 ? 3 : 4;
}

export interface CellRead {
  view: CellView;
  /** Для отладки: сходства. */
  lock: number;
  face: { label: string; score: number };
}

/** Одна камера (не допросная). chain — экран цепочки. */
export function readCell(frame: Frame, geo: Geometry, cell: number, t: CellsTemplate, chain: boolean): CellRead {
  const lock = lockScore(frame, geo, cell, t.lock);
  const face = classifyFace(frame, geo, cell, t);
  const view: CellView = { kind: 'empty' };
  const isBeast = BEASTS.includes(face.label) && face.score >= PORTRAIT_MIN;
  if (lock >= LOCK_SURE || (lock >= LOCK_MAYBE && !isBeast)) {
    view.kind = 'locked';
    if (face.label === 'unknown' && face.score >= PORTRAIT_MIN) view.shownTier = readTier(frame, geo, cell);
  } else if (isBeast) {
    view.kind = 'inmate';
    view.beast = face.label as Beast;
    const target = chain && chainJawShare(frame, geo, cell) >= CHAIN_JAW_MIN;
    view.tier = readTier(frame, geo, cell, target);
    if (chain) view.jaws = target;
    else view.jaws = dot(jawVec(frame, geo, cell, jawBuf), t.jaw) >= JAW_MIN;
  }
  if (eventShare(frame, geo, cell) >= EVENT_MIN) view.event = true;
  return { view, lock, face };
}

/** Камера надзирателя: где ярче всего золото стрелки. */
export function readWarden(frame: Frame, geo: Geometry): number | null {
  let best = -1;
  let bestShare = WARDEN_MIN;
  for (let c = 0; c < WARDEN.length; c++) {
    const [x, y] = WARDEN[c]!;
    const share = colorShare(frame, geo, [x - 10, y - 10, x + 10, y + 10], 2, isGold);
    if (share > bestShare) {
      bestShare = share;
      best = c;
    }
  }
  return best >= 0 ? best : null;
}

export function readCells(frame: Frame, geo: Geometry, t: CellsTemplate, chain: boolean): CellView[] {
  const cells: CellView[] = [{ kind: 'office' }];
  for (let c = 1; c < 16; c++) cells.push(readCell(frame, geo, c, t, chain).view);
  return cells;
}

// ── вся доска ───────────────────────────────────────────────────────────────

const CHAIN_RED = 0.3;
const HEADER_MIN = 0.6;
const CARD_MIN = 0.6;

const isBannerRed = (r: number, g: number, b: number): boolean => r > 90 && r > 2 * g && r > 2 * b;
const headerBuf = new Float32Array(HEADER_W * HEADER_H);

/** Экран цепочки: красная полоса «Выберите узника для пожирания». */
export function isChain(frame: Frame, geo: Geometry): boolean {
  return colorShare(frame, geo, CHAIN_BANNER, 4, isBannerRed) >= CHAIN_RED;
}

/** Надпись над карточками: patrol, manage, ratway или null. */
export function readHeader(frame: Frame, geo: Geometry, t: ScreensTemplate): 'patrol' | 'manage' | 'ratway' | null {
  sample(frame, geo, HEADER, HEADER_W, HEADER_H, 1, headerBuf);
  if (normalize(headerBuf) < 3) return null;
  const best = nearest(headerBuf, t.headers);
  if (best.score < HEADER_MIN || best.label === 'none') return null;
  return best.label as 'patrol' | 'manage' | 'ratway';
}

/** Дни до бунта: крупные цифры сверху (на последних днях они красные). */
export function readDays(frame: Frame, geo: Geometry, digits: DigitSet): number | null {
  const gs = glyphs(frame, geo, DAYS, { contrast: 50, maxSat: 1 }).filter((g) => g.y1 - g.y0 >= 24 * geo.s);
  if (gs.length === 0 || gs.length > 2) return null;
  let s = '';
  for (const g of gs) {
    const r = readDigit(frame, g, digits, 0.6);
    if (r.d < 0) return null;
    s += r.d;
  }
  const n = Number(s);
  return n >= 1 && n <= 30 ? n : null;
}

/** Опорный центр камеры для меток: портрет, у допросной — середина комнаты. */
function cellCenter(c: number): [number, number] {
  return c === 0 ? [518, 140] : portrait(c);
}

export interface BoardTemplates {
  cells: CellsTemplate;
  screens: ScreensTemplate;
  digits: DigitSet;
}

function reachable(from: number, to: number): boolean {
  const d = (to - from + 16) % 16;
  return d >= 1 && d <= 6;
}

/** Доска целиком при известной геометрии. */
export function readBoard(frame: Frame, geo: Geometry, t: BoardTemplates): BoardView {
  const chain = isChain(frame, geo);
  const header = chain ? null : readHeader(frame, geo, t.screens);
  const cells = readCells(frame, geo, t.cells, chain);
  const at: BoardView['at'] = {
    cells: cells.map((_, c) => {
      const [x, y] = toFrame(geo, ...cellCenter(c));
      return { x, y, r: CELL_R * geo.s };
    }),
    doorCards: [],
    decisionCards: [],
    cancel: chain ? (boxToFrame(geo, CANCEL) as ViewBox) : null,
  };
  // На экране цепочки доска обычно затемнена и панели скрыты; в первые
  // кадры цепочки они ещё видны. Видна строка дней — читаем и панели.
  const daysLeft = readDays(frame, geo, t.digits);
  const panels = !chain || daysLeft !== null;
  const board: BoardView = {
    cells,
    warden: readWarden(frame, geo),
    daysLeft,
    doors: [],
    decision: null,
    chain: null,
    tools: panels ? readTools(frame, geo, t.screens) : [],
    chromatic: panels ? readChromatic(frame, geo, t.screens) : -1,
    objective: panels ? readObjective(frame, geo, t.screens) : null,
    at,
  };
  if (chain) {
    board.chain = { targets: cells.flatMap((c, i) => (c.jaws ? [i] : [])) };
    return board;
  }
  if (header === 'ratway') {
    board.decision = { kind: 'ratway' };
    return board;
  }
  if (header === null) return board;
  const centers = cardCenters(frame, geo);
  if (header === 'patrol') {
    for (const cx of centers) {
      const n = readDoorNumber(frame, geo, cx, t.digits);
      if (n === null) continue;
      const cell = n === 0 ? 0 : n - 1;
      // Двери — на 1–6 шагов вперёд от надзирателя (rules.md §3): иное — ошибка чтения.
      if (board.warden !== null && !reachable(board.warden, cell)) continue;
      board.doors.push(cell);
      at.doorCards.push(boxToFrame(geo, cardBox(cx)) as ViewBox);
    }
    return board;
  }
  // header === 'manage'
  const kinds: string[] = [];
  for (const cx of centers) {
    const r = classifyCard(frame, geo, cx, t.screens.cards);
    if (r.score < CARD_MIN) continue;
    kinds.push(r.label);
    at.decisionCards.push(boxToFrame(geo, cardBox(cx)) as ViewBox);
  }
  if (kinds.includes('bestow') || kinds.includes('instigate')) board.decision = { kind: 'office' };
  else if (kinds.length > 0) {
    board.decision = {
      kind: 'manage',
      consume: kinds.includes('consume'),
      replace: kinds.includes('replace'),
      end: kinds.includes('end'),
    };
  }
  return board;
}
