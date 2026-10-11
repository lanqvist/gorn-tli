import { afterEach, describe, expect, it } from 'vitest';

import { setUiLanguage } from '../src/core/i18n.js';
import { FIND, plural, pluralize, RUN } from '../src/core/plural.js';

describe('русские склонения после числительных', () => {
  it('четыре формы, а не две', () => {
    // Наивное «одна форма или множественное» даёт «2 забегов».
    expect(pluralize(1, RUN)).toBe('1 забег');
    expect(pluralize(2, RUN)).toBe('2 забега');
    expect(pluralize(4, RUN)).toBe('4 забега');
    expect(pluralize(5, RUN)).toBe('5 забегов');
    expect(pluralize(11, RUN)).toBe('11 забегов');
    expect(pluralize(21, RUN)).toBe('21 забег');
    expect(pluralize(22, RUN)).toBe('22 забега');
    expect(pluralize(25, RUN)).toBe('25 забегов');
    expect(pluralize(100, RUN)).toBe('100 забегов');
    expect(pluralize(101, RUN)).toBe('101 забег');
  });

  it('ноль берёт родительный множественного', () => {
    expect(pluralize(0, RUN)).toBe('0 забегов');
  });

  it('женский род склоняется отдельно', () => {
    expect(pluralize(1, FIND)).toBe('1 находка');
    expect(pluralize(3, FIND)).toBe('3 находки');
    expect(pluralize(7, FIND)).toBe('7 находок');
  });

  it('дробные берут форму родительного единственного', () => {
    expect(plural(1.5, RUN)).toBe('забега');
  });
});

describe('английские формы', () => {
  afterEach(() => setUiLanguage('ru'));

  it('единственное только для единицы', () => {
    setUiLanguage('en');
    expect(pluralize(1, RUN)).toBe('1 run');
    expect(pluralize(0, RUN)).toBe('0 runs');
    expect(pluralize(21, RUN)).toBe('21 runs');
    expect(pluralize(1.5, RUN)).toBe('1.5 runs');
  });
});
