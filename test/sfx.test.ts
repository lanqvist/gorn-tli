import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SR, master, measure, osc, rng, toWav } from '../src/sfx/dsp.js';
import { TIERS, VARIANTS, assetName, renderSound } from '../src/sfx/kit.js';

describe('офлайн-движок звуков', () => {
  it('генератор случайности детерминирован по сиду', () => {
    const a = rng(42);
    const b = rng(42);
    const seqA = Array.from({ length: 5 }, a);
    expect(Array.from({ length: 5 }, b)).toEqual(seqA);
    expect(Array.from({ length: 5 }, rng(43))).not.toEqual(seqA);
  });

  it('мастер выводит громкость к цели и держит пики под потолком', () => {
    const tone = osc('saw', 220, 0.5);
    const out = master(tone, -18, -6);
    const m = measure(out);
    expect(m.rmsDb).toBeGreaterThan(-18.6);
    expect(m.rmsDb).toBeLessThan(-17.4);
    expect(m.peakDb).toBeLessThanOrEqual(-5.99);
  });

  it('WAV: 16 бит, моно, правильные размеры в заголовке', () => {
    const wav = toWav(new Float32Array([0, 0.5, -1, 1]));
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(SR);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect(view.getInt16(44 + 2 * 2, true)).toBe(-32767);
  });
});

describe('звуки Горна', () => {
  const all = TIERS.flatMap((tier) =>
    Array.from({ length: VARIANTS[tier] }, (_, v) => [tier, v] as const),
  );

  it('рендер детерминирован: тот же рецепт — тот же файл', () => {
    expect(renderSound('pickup', 0)).toEqual(renderSound('pickup', 0));
  });

  it.each(all)('%s #%i: короткий, не громче прежних, без клиппинга', (tier, v) => {
    const sig = renderSound(tier, v);
    const m = measure(sig);
    let finite = true;
    for (const x of sig) if (!Number.isFinite(x)) finite = false;
    expect(finite).toBe(true);
    // Потолок пиков мастера — −4.5 дБFS; самый громкий прежний звук был −4.4.
    expect(m.peakDb).toBeLessThanOrEqual(-4.49);
    // Громче прежнего итога карты (≈ −10.7 дБ RMS на полной громкости) — нельзя.
    expect(m.rmsDb).toBeLessThan(-12);
    expect(m.durationSec).toBeLessThan(1.7);
  });

  it('у каждой ступени и варианта есть файл в ассетах (npm run sounds)', () => {
    const dir = join(import.meta.dirname, '../src/renderer/assets/sfx');
    for (const [tier, v] of all) expect(existsSync(join(dir, assetName(tier, v)))).toBe(true);
  });
});
