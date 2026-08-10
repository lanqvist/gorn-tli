import { describe, expect, it } from 'vitest';

import { formatDelta, formatDuration, formatNumber } from '../src/core/format.js';
import { confidenceOf, median, percentile, perHour, summarize } from '../src/core/stats.js';

describe('честная статистика', () => {
  it('медиана устойчива к одной дорогой находке, среднее — нет', () => {
    // Типичный забег даёт около 900 ФЕ/час, один принёс редкую вещь.
    const rates = [880, 900, 910, 920, 940, 12_000];

    const s = summarize(rates);
    expect(Math.round(s.median)).toBe(915);
    expect(Math.round(s.mean)).toBe(2758);
    // Среднее втрое выше любого обычного забега — именно поэтому
    // главной метрикой сделана медиана.
    expect(s.mean).toBeGreaterThan(Math.max(...rates.slice(0, 5)));
  });

  it('доля лучшего забега показывает, на чём держится цифра', () => {
    const s = summarize([100, 100, 100, 9700]);
    expect(s.topShare).toBeCloseTo(0.97, 2);
  });

  it('бейдж достоверности меняется на осмысленных порогах', () => {
    expect(confidenceOf(1)).toBe('insufficient');
    expect(confidenceOf(14)).toBe('insufficient');
    expect(confidenceOf(15)).toBe('emerging');
    expect(confidenceOf(49)).toBe('emerging');
    expect(confidenceOf(50)).toBe('solid');
  });

  it('перцентили интерполируются', () => {
    const sorted = [0, 10, 20, 30, 40];
    expect(percentile(sorted, 0)).toBe(0);
    expect(percentile(sorted, 0.5)).toBe(20);
    expect(percentile(sorted, 1)).toBe(40);
    expect(percentile(sorted, 0.25)).toBe(10);
  });

  it('медиана чётного количества значений усредняет середину', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('пустая выборка не роняет расчёт', () => {
    const s = summarize([]);
    expect(s.median).toBe(0);
    expect(s.confidence).toBe('insufficient');
  });

  it('ФЕ в час считается из реального забега', () => {
    // Забег 10 августа: 44 ФЕ за 83,8 секунды.
    expect(Math.round(perHour(44, 83_773))).toBe(1891);
  });

  it('нулевая длительность не даёт бесконечность', () => {
    expect(perHour(100, 0)).toBe(0);
  });
});

describe('русское форматирование', () => {
  it('разряды разделяются неразрывным пробелом', () => {
    expect(formatNumber(1240)).toBe('1 240');
    expect(formatNumber(1234567)).toBe('1 234 567');
  });

  it('дробная часть отделяется запятой', () => {
    expect(formatNumber(12.5, 1)).toBe('12,5');
  });

  it('длительности читаются по-русски', () => {
    expect(formatDuration(50_000)).toBe('50 с');
    expect(formatDuration(167_000)).toBe('2 м 47 с');
    expect(formatDuration(5_940_000)).toBe('1 ч 39 м');
  });

  it('нулевые остатки не печатаются', () => {
    // «41 м 0 с» выглядит как недоделка. Проверено на экране дашборда.
    expect(formatDuration(2_460_000)).toBe(`41${' '}м`);
    expect(formatDuration(7_200_000)).toBe(`2${' '}ч`);
  });

  it('дельта к медиане показывается со знаком и процентом', () => {
    expect(formatDelta(240, 1040)).toBe('+240 (+23%)');
    expect(formatDelta(-180, 1040)).toBe('−180 (−17%)');
  });
});
