/**
 * Скорость распознавания на своих кадрах 1920×1080 («Горн — тюрьма»,
 * копия в images/gorn папки данных). Бюджеты — docs/prison/architecture.md.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { calibrate } from '../../src/core/prison/recognize/geometry.js';
import { read } from '../../src/core/prison/recognize/index.js';
import type { Frame, Geometry } from '../../src/core/prison/recognize/types.js';
import { DATA, frame } from './data.js';

/** Кадры Горна: снимок в папке данных, иначе сама папка «Горн — тюрьма». */
function shots(): string[] {
  for (const root of [join(DATA, 'images', 'gorn'), join(homedir(), 'Pictures', 'Горн — тюрьма')]) {
    if (!existsSync(root)) continue;
    const out: string[] = [];
    for (const day of readdirSync(root)) {
      for (const f of readdirSync(join(root, day))) if (f.endsWith('-board.png')) out.push(join(root, day, f));
    }
    if (out.length) return out.slice(0, 120);
  }
  return [];
}

const FILES = shots();

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

function time<T>(fn: () => T): [T, number] {
  const t = performance.now();
  const r = fn();
  return [r, performance.now() - t];
}

describe.skipIf(FILES.length === 0)('скорость распознавания', { timeout: 300_000 }, () => {
  const frames: Frame[] = FILES.map((p) => frame(p));

  it('кадр 1920×1080 при известной геометрии ≤ 30 мс, цепочка ≤ 50 мс, калибровка ≤ 300 мс', () => {
    // Прогрев: эталоны читаются один раз на процесс.
    let geo: Geometry | null = read(frames[0]!, null).geo;
    const board: number[] = [];
    const chain: number[] = [];
    const calib: number[] = [];
    for (const f of frames) {
      const [r, ms] = time(() => read(f, geo));
      geo = r.geo ?? geo;
      if (r.view.screen === 'board') (r.view.board.chain ? chain : board).push(ms);
      const [, cms] = time(() => calibrate(f));
      calib.push(cms);
    }
    const line = (name: string, xs: number[]) =>
      `${name}: n=${xs.length} медиана ${quantile(xs, 0.5).toFixed(1)} мс, p95 ${quantile(xs, 0.95).toFixed(1)} мс, макс ${Math.max(...xs).toFixed(1)} мс`;
    console.log([line('доска', board), line('цепочка', chain), line('калибровка', calib)].join('\n'));
    expect(quantile(board, 0.95)).toBeLessThanOrEqual(30);
    if (chain.length) expect(quantile(chain, 0.95)).toBeLessThanOrEqual(50);
    expect(quantile(calib, 0.95)).toBeLessThanOrEqual(300);
  });
});
