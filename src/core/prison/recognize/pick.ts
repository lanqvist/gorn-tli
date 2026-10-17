/**
 * Экраны без доски: выбор орудий (три карты) и сокровищница (четыре подарка).
 */
import type { Box, PickView, ToolId } from '../view.js';
import { TOOL_IDS } from '../view.js';
import {
  PICK_CARDS,
  PICK_HEADER,
  PICK_REROLL,
  TREASURE_CARDS,
  pickArt,
  pickCard,
  pickTitle,
  treasureArt,
  treasureCard,
} from './layout.js';
import { boxToFrame, dot, normalize, sample } from './sample.js';
import type { ScreensTemplate } from './templates.js';
import { nearest, scoresByLabel } from './templates.js';
import type { Frame, Geometry } from './types.js';

const HEADER_MIN = 0.6;
const CARD_MIN = 0.8;
const REROLL_MIN = 0.6;
const GIFT_MIN = 0.6;

const headerBuf = new Float32Array(100 * 6);
const artBuf = new Float32Array(16 * 16 * 3);
const titleBuf = new Float32Array(86 * 11);
const rerollBuf = new Float32Array(44 * 10);

/** Заголовок выбора орудий: «start» — в начале забега, «reward» — за цель; null — не выбор. */
export function pickHeader(frame: Frame, geo: Geometry, t: ScreensTemplate): 'start' | 'reward' | null {
  sample(frame, geo, PICK_HEADER, 100, 6, 1, headerBuf);
  if (normalize(headerBuf) < 3) return null;
  const best = nearest(headerBuf, t.pickHeaders);
  return best.score >= HEADER_MIN ? (best.label as 'start' | 'reward') : null;
}

/** Карта орудия: сумма сходства картинки и названия по каждому орудию. */
function readCard(frame: Frame, geo: Geometry, cx: number, t: ScreensTemplate): ToolId | null {
  // Картинку ищем с небольшим сдвигом: обрезанные скриншоты сдвигают экран на десяток px.
  let artScores = new Map<string, number>();
  let bestArt = -2;
  for (let dx = -12; dx <= 12; dx += 6) {
    sample(frame, geo, pickArt(cx + dx), 16, 16, 3, artBuf);
    normalize(artBuf);
    const s = scoresByLabel(artBuf, t.pickArt);
    const top = Math.max(...s.values());
    if (top > bestArt) {
      bestArt = top;
      artScores = s;
    }
  }
  sample(frame, geo, pickTitle(cx), 86, 11, 1, titleBuf);
  normalize(titleBuf);
  const titleScores = scoresByLabel(titleBuf, t.pickTitles);
  let id: string | null = null;
  let best = CARD_MIN;
  for (const [label, a] of artScores) {
    const s = (a + Math.max(titleScores.get(label) ?? 0, 0)) / 2;
    if (s > best) {
      best = s;
      id = label;
    }
  }
  return id && (TOOL_IDS as readonly string[]).includes(id) ? (id as ToolId) : null;
}

export function readPick(frame: Frame, geo: Geometry, t: ScreensTemplate, kind: 'start' | 'reward'): PickView {
  const cards = PICK_CARDS.map((cx) => readCard(frame, geo, cx, t));
  const boxes = PICK_CARDS.map((cx) => boxToFrame(geo, pickCard(cx)) as Box);
  sample(frame, geo, PICK_REROLL, 44, 10, 1, rerollBuf);
  let reroll = false;
  if (normalize(rerollBuf) >= 3) for (const r of t.reroll) if (dot(rerollBuf, r) >= REROLL_MIN) reroll = true;
  return { cards, boxes, reroll, reward: kind === 'reward' };
}

/** Сокровищница: все четыре места похожи на подарки. */
export function readTreasure(frame: Frame, geo: Geometry, t: ScreensTemplate): Box[] | null {
  for (const cx of TREASURE_CARDS) {
    sample(frame, geo, treasureArt(cx), 16, 16, 3, artBuf);
    normalize(artBuf);
    if (nearest(artBuf, t.gifts).score < GIFT_MIN) return null;
  }
  return TREASURE_CARDS.map((cx) => boxToFrame(geo, treasureCard(cx)) as Box);
}
