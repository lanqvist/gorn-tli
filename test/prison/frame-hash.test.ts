import { describe, expect, it } from 'vitest';

import { frameHash, screenChanged } from '../../src/core/prison/frameHash.js';

const frame = (w: number, h: number, fill: (i: number) => number) => {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i++) px[i] = fill(i) & 255;
  return { width: w, height: h, buffer: px.buffer };
};

describe('застывший поток экрана', () => {
  it('тот же кадр — тот же отпечаток; другой кадр или размер — другой', () => {
    const a = frame(320, 180, (i) => i * 7);
    const b = frame(320, 180, (i) => i * 7);
    const c = frame(320, 180, (i) => i * 7 + (i > 1000 ? 1 : 0));
    expect(frameHash(a)).toBe(frameHash(b));
    expect(frameHash(a)).not.toBe(frameHash(c));
    expect(frameHash(frame(160, 90, (i) => i * 7))).not.toBe(frameHash(a));
  });

  it('новое окно или начало дня в строках лога — экран точно сменился', () => {
    expect(screenChanged(['[2026.10.18-19.51.38:219][1]TLLua: Display: [Game] S16BoardRelicPop Run'])).toBe(true);
    expect(screenChanged(['[S16LastDay] check cur=0 max=30 played=false'])).toBe(true);
    expect(screenChanged(['UIButton@ normal-click Btn_S16Board_ActionCell'])).toBe(false);
  });
});
