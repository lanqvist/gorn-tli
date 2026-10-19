import { describe, expect, it } from 'vitest';

import { tierOf, tiersOf } from '../src/renderer/tiers.js';

describe('ступени ценности в главном окне', () => {
  it('пороги — из настроек оверлея, иначе авто, оранжевое — пятая часть золота', () => {
    expect(tiersOf(50, 5, 80)).toEqual({ gold: 50, orange: 5 });
    expect(tiersOf(0, 0, 80)).toEqual({ gold: 80, orange: 16 });
  });

  it('ступень по цене строки; без цены или без порогов — без ступени', () => {
    const t = tiersOf(50, 5, 0);
    expect(tierOf(68, t)).toBe('gold');
    expect(tierOf(13, t)).toBe('orange');
    expect(tierOf(3.1, t)).toBe('plain');
    expect(tierOf(null, t)).toBeNull();
    expect(tierOf(68, { gold: 0, orange: 0 })).toBeNull();
  });
});
