/**
 * Панели вокруг доски: орудия слева, хранилище призматических справа, цель.
 */
import type { ToolId } from '../view.js';
import { TOOL_IDS } from '../view.js';
import { CHROMATIC_HEADER, OBJECTIVE, TOOL_SLOTS, chromaticSlot, toolSlot } from './layout.js';
import { dot, normalize, sample } from './sample.js';
import type { ScreensTemplate } from './templates.js';
import { nearest, scoresByLabel } from './templates.js';
import type { Frame, Geometry } from './types.js';

const TOOL_MIN = 0.75;
const OBJECTIVE_MIN = 0.8;
const HEADER_MIN = 0.35;

const toolBuf = new Float32Array(12 * 18 * 3);
const slotBuf = new Float32Array(12 * 16 * 3);
const objBuf = new Float32Array(80 * 15);
const headBuf = new Float32Array(92 * 20);

/**
 * Места панели орудий слева направо: орудие или null — место занято
 * иконкой, которой нет среди эталонов. Первое пустое место — конец списка.
 */
export function readToolSlots(frame: Frame, geo: Geometry, t: ScreensTemplate): (ToolId | null)[] {
  const out: (ToolId | null)[] = [];
  for (let i = 0; i < TOOL_SLOTS; i++) {
    sample(frame, geo, toolSlot(i), 12, 18, 3, toolBuf);
    normalize(toolBuf);
    const best = nearest(toolBuf, t.tools);
    if (best.label === 'empty') break;
    out.push(best.score >= TOOL_MIN && (TOOL_IDS as readonly string[]).includes(best.label) ? (best.label as ToolId) : null);
  }
  return out;
}

/** Узнанные орудия на панели (неузнанные иконки пропускаются). */
export function readTools(frame: Frame, geo: Geometry, t: ScreensTemplate): ToolId[] {
  return readToolSlots(frame, geo, t).filter((x): x is ToolId => x !== null);
}

/**
 * Призматических в хранилище: занятые места (портрет, а не пустая ячейка).
 * −1 — панель скрыта (режим «Посмотреть состояние тюрьмы», затемнение):
 * заголовка панели не видно и ни одного портрета.
 */
export function readChromatic(frame: Frame, geo: Geometry, t: ScreensTemplate): number {
  sample(frame, geo, CHROMATIC_HEADER, 92, 20, 1, headBuf);
  normalize(headBuf);
  let head = -1;
  for (const h of t.chromaticHeader) head = Math.max(head, dot(headBuf, h));
  let n = 0;
  for (let i = 0; i < 10; i++) {
    sample(frame, geo, chromaticSlot(i), 12, 16, 3, slotBuf);
    normalize(slotBuf);
    const s = scoresByLabel(slotBuf, t.chromatic);
    if ((s.get('filled') ?? -2) > (s.get('empty') ?? -2)) n++;
  }
  return n === 0 && head < HEADER_MIN ? -1 : n;
}

/**
 * Цель забега: doors («За дверью камеры»), jungle («Закон джунглей»),
 * beastking («Загнанный зверь-царь»), walk («Путь обхода тюрьмы»);
 * null — не узнана (в том числе «Подводные течения»: своих кадров нет).
 */
export function readObjective(frame: Frame, geo: Geometry, t: ScreensTemplate): string | null {
  sample(frame, geo, OBJECTIVE, 80, 15, 1, objBuf);
  if (normalize(objBuf) < 3) return null;
  const best = nearest(objBuf, t.objectives);
  return best.score >= OBJECTIVE_MIN ? best.label : null;
}
