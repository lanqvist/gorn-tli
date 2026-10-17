import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SR,
  master,
  measure,
  measureStereo,
  osc,
  rng,
  toWav,
  toWavStereo,
} from '../src/sfx/dsp.js';
import { LOUDNESS, TIERS, VARIANTS, assetName, limitsFor, renderSound } from '../src/sfx/kit.js';

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

  it('WAV стерео: каналы чередуются, левый — первым', () => {
    const wav = toWavStereo({ l: new Float32Array([1, 0]), r: new Float32Array([-1, 0.5]) });
    const view = new DataView(wav.buffer);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint32(40, true)).toBe(8);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32767);
    expect(view.getInt16(50, true)).toBe(Math.round(0.5 * 32767));
  });
});

describe('звуки Горна', () => {
  const all = TIERS.flatMap((tier) =>
    Array.from({ length: VARIANTS[tier] }, (_, v) => [tier, v] as const),
  );

  it('рендер детерминирован: тот же рецепт — тот же файл', () => {
    expect(renderSound('pickup', 0)).toEqual(renderSound('pickup', 0));
  });

  it.each(all)('%s #%i: не громче прежнего звука по пику, громкости и энергии', (tier, v) => {
    const st = renderSound(tier, v);
    const m = measureStereo(st);
    const old = limitsFor(tier);
    let finite = true;
    for (const x of st.l) if (!Number.isFinite(x)) finite = false;
    for (const x of st.r) if (!Number.isFinite(x)) finite = false;
    expect(finite).toBe(true);
    expect(m.peakDb).toBeLessThanOrEqual(old.peakDb + 0.01);
    expect(m.rmsDb).toBeLessThanOrEqual(old.rmsDb);
    expect(m.energyDb).toBeLessThanOrEqual(old.energyDb);
    expect(m.durationSec).toBeLessThan(3.2);
  });

  it('лесенка: чем весомее событие, тем громче', () => {
    const loud = (tier: (typeof TIERS)[number]) => measureStereo(renderSound(tier, 0)).rmsDb;
    expect(loud('pickup')).toBeLessThan(loud('pickupBig'));
    expect(loud('pickupBig')).toBeLessThan(loud('whistle'));
    expect(loud('whistle')).toBeLessThan(loud('jackpot'));
    expect(loud('runEnd')).toBeLessThan(loud('jackpot'));
    expect(loud('runLoss')).toBeLessThan(loud('runEnd'));
    expect(LOUDNESS.record).toBeGreaterThanOrEqual(LOUDNESS.jackpot);
  });

  it('ассеты — ровно наши файлы: все ступени и варианты, стерео 24 кГц, ничего лишнего', () => {
    const dir = join(import.meta.dirname, '../src/renderer/assets/sfx');
    const expected = all.map(([tier, v]) => assetName(tier, v)).sort();
    expect(readdirSync(dir).sort()).toEqual(expected);
    for (const name of expected) {
      const path = join(dir, name);
      expect(existsSync(path)).toBe(true);
      const bytes = readFileSync(path);
      expect(bytes.readUInt16LE(22)).toBe(2);
      expect(bytes.readUInt32LE(24)).toBe(SR);
    }
  });
});
