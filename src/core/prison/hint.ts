/**
 * Ход → подсказка поверх игры: текст и метки в пикселях кадра (стрелка от
 * надзирателя к камере, кольцо, рамка на карточке). Места берутся из
 * распознанного экрана: BoardView.at, PickView.boxes, места подарков.
 */

import { GIFT_IDS, GIFT_NAMES, OFFICE, TOOL_IDS, TOOL_NAMES, type Action, type GiftId, type ToolId } from './model.js';
import type { BoardView, Box, PickView } from './view.js';

export type HintMark =
  | { kind: 'arrow'; from: number[]; to: number[] }
  | { kind: 'ring'; at: number[]; r: number }
  | { kind: 'box'; box: number[] };

export interface Hint {
  text: string;
  marks: HintMark[];
}

export interface HintContext {
  /** Доска на этом кадре (для мест камер и карточек). */
  board?: BoardView | null;
  /** Выбор орудий на этом кадре. */
  pick?: PickView | null;
  /** Места подарков сокровищницы (окно приходит без снимка — по геометрии). */
  gifts?: Box[] | null;
  /** Кнопка «Обновить» на выборе орудий. */
  reroll?: Box | null;
  /** Камера надзирателя (из памяти, если на кадре не видно). */
  warden: number | null;
  /** «Крысиная тропа»: переход, а не обход. */
  ratway?: boolean;
  /**
   * Экран выбора цели до первого укуса: Замена и конец дня — через
   * «Отменить» (ряда решений на этом экране нет).
   */
  cancelFirst?: boolean;
  /** Короткая причина хода от стратегии. */
  reason?: string;
}

/** Русское название орудия или подарка (без прозвища зверя после двоеточия). */
export function itemName(id: ToolId | GiftId): string {
  if ((GIFT_IDS as readonly string[]).includes(id)) return GIFT_NAMES[id as GiftId];
  return TOOL_NAMES[id as ToolId].split(':')[0]!;
}

const cellName = (n: number) => (n === OFFICE ? 'допросную' : `№${n + 1}`);

/** Порядок карточек ряда решений в игре, если распознавание не сказало виды. */
const MANAGE_ORDER = ['consume', 'replace', 'end'];
const OFFICE_ORDER = ['instigate', 'bestow'];

/** Подпись вместе с причиной — не длиннее этого. */
const TEXT_MAX = 60;

export function hint(a: Action, ctx: HintContext): Hint {
  const marks: HintMark[] = [];
  const at = ctx.board?.at ?? null;
  const from = at && ctx.warden !== null ? at.cells[ctx.warden] : undefined;

  const toCell = (n: number) => {
    const c = at?.cells[n];
    if (!c) return;
    if (from && n !== ctx.warden) marks.push({ kind: 'arrow', from: [from.x, from.y], to: [c.x, c.y] });
    marks.push({ kind: 'ring', at: [c.x, c.y], r: c.r });
  };
  const card = (kind: string) => {
    if (!at || !ctx.board?.decision) return;
    let i = at.decisionKinds ? at.decisionKinds.indexOf(kind) : -1;
    if (!at.decisionKinds) {
      const d = ctx.board.decision;
      const order = d.kind === 'office' ? OFFICE_ORDER : d.kind === 'manage' ? MANAGE_ORDER.filter((k) => d[k as 'consume']) : [];
      i = order.indexOf(kind);
    }
    const box = i >= 0 ? at.decisionCards[i] : undefined;
    if (box) marks.push({ kind: 'box', box: [...box] });
  };

  if (ctx.cancelFirst && (a.type === 'swap' || a.type === 'end')) {
    if (at?.cancel) marks.push({ kind: 'box', box: [...at.cancel] });
    return { text: `Отменить, затем «${a.type === 'swap' ? 'Заменить' : 'Завершить день'}»`, marks };
  }

  let text = '';
  switch (a.type) {
    case 'patrol': {
      text = ctx.ratway ? `Выбери ${cellName(a.cell)}` : `Иди в ${cellName(a.cell)}`;
      toCell(a.cell);
      const i = ctx.board ? ctx.board.doors.indexOf(a.cell) : -1;
      const box = i >= 0 ? at?.doorCards[i] : undefined;
      if (box) marks.push({ kind: 'box', box: [...box] });
      break;
    }
    case 'devour':
      text = `Пожирание: съесть ${cellName(a.to)}`;
      card('consume');
      toCell(a.to);
      break;
    case 'chain':
      text = `Цепочка: съесть ${cellName(a.to)}`;
      toCell(a.to);
      break;
    case 'stopchain':
      text = 'Остановить цепочку (Отменить)';
      if (at?.cancel) marks.push({ kind: 'box', box: [...at.cancel] });
      break;
    case 'swap':
      text = 'Заменить';
      card('replace');
      if (from) marks.push({ kind: 'ring', at: [from.x, from.y], r: from.r });
      break;
    case 'end':
      text = 'Завершить день';
      card('end');
      break;
    case 'hunt':
      text = `Метка добычи: ${cellName(a.to)}`;
      card('hunt');
      toCell(a.to);
      break;
    case 'office':
      text = a.choice === 'bestow' ? 'Наградить' : 'Подстрекнуть';
      card(a.choice);
      break;
    case 'event':
      text = a.accept ? 'Принять событие' : 'Пропустить событие';
      break;
    case 'choose': {
      text = `Взять: ${itemName(a.id)}`;
      if ((TOOL_IDS as readonly string[]).includes(a.id)) {
        const i = ctx.pick ? ctx.pick.cards.indexOf(a.id as ToolId) : -1;
        const box = i >= 0 ? ctx.pick!.boxes[i] : undefined;
        if (box) marks.push({ kind: 'box', box: [...box] });
      } else if (ctx.gifts) {
        const box = ctx.gifts[GIFT_IDS.indexOf(a.id as GiftId)];
        if (box) marks.push({ kind: 'box', box: [...box] });
      }
      break;
    }
    case 'reroll':
      text = 'Обновить выбор';
      if (ctx.reroll) marks.push({ kind: 'box', box: [...ctx.reroll] });
      break;
  }
  if (ctx.reason && text.length + 3 + ctx.reason.length <= TEXT_MAX) text += ` · ${ctx.reason}`;
  return { text, marks };
}
