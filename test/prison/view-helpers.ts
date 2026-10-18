/** Заготовки экранов (ScreenView) для тестов адаптера, меток и потока подсказок. */

import type { Beast, BoardView, Box, CellView, PickView, Tier, ToolId } from '../../src/core/prison/view.js';

/** Камера игрока (1–16) → внутренняя (0–15). */
export const C = (n: number) => n - 1;

/** Центр камеры c на условном кадре: по кругу, чтобы стрелки было видно. */
export function cellAt(c: number): { x: number; y: number; r: number } {
  const a = (c / 16) * 2 * Math.PI;
  return { x: Math.round(960 + 400 * Math.sin(a)), y: Math.round(500 - 400 * Math.cos(a)), r: 60 };
}

export interface BoardSpec {
  /** Узники: камера игрока → 'wolf3' и т.п. */
  inmates?: Record<number, string>;
  empty?: number[];
  events?: number[];
  shown?: Record<number, Tier>;
  warden?: number;
  daysLeft?: number | null;
  doors?: number[];
  decision?: BoardView['decision'];
  kinds?: string[];
  chain?: number[];
  tools?: ToolId[];
  chromatic?: number;
  objective?: string | null;
}

/** Доска по описанию (номера камер — как у игрока, 1–16). */
export function board(spec: BoardSpec): BoardView {
  const cells: CellView[] = Array.from({ length: 16 }, (_, c) => (c === 0 ? { kind: 'office' } : { kind: 'locked' }));
  for (const [n, s] of Object.entries(spec.inmates ?? {})) {
    const m = s.match(/^([a-z]+)(\d)$/)!;
    cells[C(Number(n))] = { kind: 'inmate', beast: m[1] as Beast, tier: Number(m[2]) as Tier };
  }
  for (const n of spec.empty ?? []) cells[C(n)] = { kind: 'empty' };
  for (const n of spec.events ?? []) cells[C(n)]!.event = true;
  for (const [n, t] of Object.entries(spec.shown ?? {})) cells[C(Number(n))]!.shownTier = t;
  for (const n of spec.chain ?? []) cells[C(n)]!.jaws = true;
  const doors = (spec.doors ?? []).map(C);
  const kinds = spec.kinds ?? [];
  return {
    cells,
    warden: spec.warden === undefined ? 0 : C(spec.warden),
    daysLeft: spec.daysLeft === undefined ? 20 : spec.daysLeft,
    doors,
    decision: spec.decision ?? null,
    chain: spec.chain ? { targets: spec.chain.map(C) } : null,
    tools: spec.tools ?? [],
    chromatic: spec.chromatic ?? 0,
    objective: spec.objective ?? null,
    at: {
      cells: cells.map((_, c) => cellAt(c)),
      doorCards: doors.map((_, i): Box => [700 + i * 240, 800, 920 + i * 240, 920]),
      decisionCards: kinds.map((_, i): Box => [700 + i * 240, 800, 920 + i * 240, 920]),
      decisionKinds: kinds,
      cancel: spec.chain ? [1655, 735, 1795, 875] : null,
    },
  };
}

export const MANAGE_ALL: BoardView['decision'] = { kind: 'manage', consume: true, replace: true, end: true };

export function pick(cards: (ToolId | null)[], reroll = true, reward = false): PickView {
  return {
    cards,
    boxes: cards.map((_, i): Box => [300 + i * 480, 200, 700 + i * 480, 900]),
    reroll,
    reward,
  };
}
