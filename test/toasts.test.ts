import { describe, expect, it } from 'vitest';

import { mergePickup, type Toast } from '../src/renderer/overlay/toasts.js';

const pickup: Toast = { id: 1, kind: 'pickup', fe: 0.8 };

describe('склейка подборов', () => {
  it('мелочь к мелочи — сумма растёт, ступень та же', () => {
    const next = mergePickup(pickup, 0.4, null);
    expect(next).toMatchObject({ id: 1, kind: 'pickup', leaving: false });
    expect(next.fe).toBeCloseTo(1.2);
  });

  it('оранжевая находка поднимает мелочь до оранжевой с названием', () => {
    const next = mergePickup(pickup, 12, { name: 'Ценный эмбер ×4', icon: null, fe: 12 });
    expect(next).toMatchObject({ kind: 'notable', name: 'Ценный эмбер ×4', topFe: 12, more: 0 });
  });

  it('у оранжевой название — самой дорогой находки, остальные — «и ещё N»', () => {
    const orange = mergePickup(pickup, 12, { name: 'Ценный эмбер ×4', icon: null, fe: 12 });
    const cheaper = mergePickup(orange, 6, { name: 'Редкий эмбер', icon: null, fe: 6 });
    expect(cheaper).toMatchObject({ name: 'Ценный эмбер ×4', more: 1 });
    const pricier = mergePickup(cheaper, 17, { name: 'Злой Компас грабителя', icon: null, fe: 17 });
    expect(pricier).toMatchObject({ name: 'Злой Компас грабителя', topFe: 17, more: 2 });
  });

  it('мелочь в оранжевую не понижает её и снимает затухание', () => {
    const orange: Toast = { id: 2, kind: 'notable', fe: 12, name: 'Ценный эмбер', topFe: 12, leaving: true };
    const next = mergePickup(orange, 0.3, null);
    expect(next).toMatchObject({ kind: 'notable', name: 'Ценный эмбер', leaving: false });
  });
});
