/**
 * Жадная базовая стратегия — точка сравнения для настройки, не для советов:
 * есть, когда можно, есть дальше, пока можно; иначе заменить слабого.
 */

import { CELLS, OFFICE } from '../model.js';
import {
  A_ACCEPT, A_BESTOW, A_CHAIN, A_DEVOUR, A_END, A_GIFT, A_HUNT, A_PATROL, A_SWAP, A_TOOL, applyCode,
} from '../engine/actions.js';
import type { Rng } from '../engine/rng.js';
import { huntTargets, targets } from '../engine/rules.js';
import {
  CHAIN_EATER, DOORS, DOORS_N, LOCK, OFFER, OFFER_GIFT, OFFER_KIND, PHASE, P_CHAIN, P_END, P_EVENT, P_HUNT,
  P_MANAGE, P_OFFICE, P_PATROL, P_PICK, P_RATWAY, STORAGE, TIER, WARDEN, type State,
} from '../engine/state.js';
import type { Params } from '../model.js';

const code = (kind: number, arg = 0) => (kind << 6) | arg;

function lowest(mask: number): number {
  for (let c = 1; c < CELLS; c++) if ((mask >>> c) & 1) return c;
  return -1;
}

export function greedyCode(s: State): number {
  const m = s.m;
  switch (m[PHASE]) {
    case P_PICK:
      return code(m[OFFER_KIND] === OFFER_GIFT ? A_GIFT : A_TOOL, m[OFFER]!);
    case P_HUNT:
      return code(A_HUNT, lowest(huntTargets(s)));
    case P_PATROL: {
      // камера, где узник может есть; иначе запертая; иначе первая
      let locked = -1;
      for (let i = 0; i < m[DOORS_N]!; i++) {
        const c = m[DOORS + i]!;
        if (c !== OFFICE && m[TIER + c]! >= 0 && targets(s, c) !== 0) return code(A_PATROL, c);
        if (locked < 0 && m[LOCK + c] === 1) locked = c;
      }
      return code(A_PATROL, locked >= 0 ? locked : m[DOORS]!);
    }
    case P_EVENT:
      return code(A_ACCEPT);
    case P_OFFICE:
      return code(A_BESTOW);
    case P_RATWAY: {
      for (let c = 1; c < CELLS; c++) if (c !== m[WARDEN] && m[TIER + c]! >= 0 && targets(s, c) !== 0) return code(A_PATROL, c);
      for (let c = 1; c < CELLS; c++) if (c !== m[WARDEN]) return code(A_PATROL, c);
      return code(A_PATROL, 1);
    }
    case P_MANAGE: {
      const e = m[WARDEN]!;
      const j = lowest(targets(s, e));
      if (j >= 0) return code(A_DEVOUR, j);
      return code(m[TIER + e]! <= 1 ? A_SWAP : A_END);
    }
    case P_CHAIN:
      return code(A_CHAIN, lowest(targets(s, m[CHAIN_EATER]!)));
  }
  throw new Error('тюрьма: забег окончен, ходов нет');
}

/** Доиграть забег жадной стратегией; вернуть счёт. */
export function greedyPlayout(s: State, r: Rng, p: Params): number {
  while (s.m[PHASE] !== P_END) applyCode(s, greedyCode(s), r, p);
  return s.m[STORAGE]!;
}
