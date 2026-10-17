import { describe, expect, it } from 'vitest';

import { planPrune, shotOutcome, type ShotEntry } from '../src/core/prisonShots.js';

const HOUR = 3_600_000;
const NOW = 1_000 * HOUR;
const shot = (base: string, hoursAgo: number, outcome: ShotEntry['outcome'], png = 100): ShotEntry => ({ base, at: NOW - hoursAgo * HOUR, outcome, png, json: true });
const policy = { hintPngMs: 2 * HOUR, missPngMs: 7 * 24 * HOUR, jsonMs: 30 * 24 * HOUR, maxBytes: 1_000 };

describe('shotOutcome', () => {
  it('отличает подсказку, сбой и ручной кадр', () => {
    expect(shotOutcome({ kind: 'board', hints: [{ type: 'hint' }, { type: 'settled' }] })).toBe('hint');
    expect(shotOutcome({ kind: 'board', hints: [{ type: 'clear' }] })).toBe('miss');
    expect(shotOutcome({ kind: 'board', hints: [{ type: 'hint' }, { type: 'error' }] })).toBe('miss');
    expect(shotOutcome({ kind: 'manual', hints: [{ type: 'hint' }] })).toBe('manual');
  });
});

describe('planPrune', () => {
  it('картинку с подсказкой убирает через 2 часа, сбой держит неделю', () => {
    const drop = planPrune([shot('a', 1, 'hint'), shot('b', 3, 'hint'), shot('c', 3, 'miss'), shot('d', 200, 'manual')], NOW, policy);
    expect(drop).toEqual(['b.png', 'd.png']);
  });

  it('старше 30 дней удаляет и описание', () => {
    expect(planPrune([shot('a', 31 * 24, 'miss')], NOW, policy)).toEqual(['a.png', 'a.json']);
    expect(planPrune([{ ...shot('b', 31 * 24, 'hint'), png: 0 }], NOW, policy)).toEqual(['b.json']);
  });

  it('сверх потолка удаляет самые старые картинки', () => {
    const drop = planPrune([shot('new', 1, 'miss', 600), shot('old', 5, 'miss', 600), shot('mid', 3, 'miss', 300)], NOW, policy);
    expect(drop).toEqual(['old.png']);
  });
});
