import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { read } from '../../src/core/prison/recognize/index.js';
import type { Frame, Geometry } from '../../src/core/prison/recognize/types.js';
import type { ScreenView } from '../../src/core/prison/view.js';
import { compareBoard, frame, HAVE_DATA, labels, Score, type BoardLabel } from './data.js';

function board(view: ScreenView) {
  if (view.screen !== 'board') throw new Error(`экран ${view.screen}, ждали доску`);
  return view.board;
}

function boards(set: string, dir: string): Score {
  const score = new Score();
  for (const [name, l] of Object.entries(labels<BoardLabel>(set))) {
    const { view } = read(frame(`${dir}/${name}`), null);
    if (view.screen !== 'board') {
      score.add('screen', false, name, () => view.screen);
      continue;
    }
    score.add('screen', true, name, () => '');
    compareBoard(score, name, board(view), l);
  }
  return score;
}

describe.skipIf(!HAVE_DATA)('распознавание тюрьмы на размеченных кадрах', { timeout: 300_000 }, () => {
  it('честный набор boards-ru4k.json: все поля ≥ 99 %', () => {
    const score = boards('boards-ru4k.json', 'ru4k');
    console.log('boards-ru4k\n' + score.table());
    expect(score.errors).toEqual([]);
    expect(score.worst()).toBeGreaterThanOrEqual(0.99);
  });

  it('boards-ru.json: все поля верны', () => {
    const score = boards('boards-ru.json', 'ru');
    console.log('boards-ru\n' + score.table());
    expect(score.errors).toEqual([]);
  });

  it('выбор орудий: все карты picks-panels-digits.json', () => {
    const errors: string[] = [];
    for (const [key, cards] of Object.entries(labels<{ picks: Record<string, string[]> }>('picks-panels-digits.json'))) {
      if (key !== 'picks') continue;
      for (const [name, exp] of Object.entries(cards as unknown as Record<string, string[]>)) {
        const { view } = read(frame(name), null);
        if (view.screen !== 'pick') errors.push(`${name}: экран ${view.screen}`);
        else if (JSON.stringify(view.pick.cards) !== JSON.stringify(exp)) errors.push(`${name}: ${JSON.stringify(view.pick.cards)}`);
      }
    }
    expect(errors).toEqual([]);
  });

  it('панели орудий и цифры picks-panels-digits.json', () => {
    const all = labels<Record<string, unknown>>('picks-panels-digits.json');
    const errors: string[] = [];
    for (const [name, exp] of Object.entries(all.panels as Record<string, string[]>)) {
      const b = board(read(frame(name), null).view);
      if (JSON.stringify(b.tools) !== JSON.stringify(exp)) errors.push(`${name}: орудия ${JSON.stringify(b.tools)}`);
    }
    for (const [name, exp] of Object.entries(all.digits as Record<string, { days: number; doors: number[] }>)) {
      const b = board(read(frame(name), null).view);
      const doors = b.doors.filter((d) => d !== 0).map((d) => d + 1);
      if (b.daysLeft !== exp.days) errors.push(`${name}: дни ${b.daysLeft}`);
      if (JSON.stringify(doors) !== JSON.stringify(exp.doors)) errors.push(`${name}: двери ${JSON.stringify(doors)}`);
    }
    expect(errors).toEqual([]);
  });

  it('тип экрана и фаза на кадрах ru/ и ru4k/', () => {
    const errors: string[] = [];
    type L = { screen: string; phase?: string; reroll?: boolean; reward?: boolean; targets?: number[] };
    for (const [name, l] of Object.entries(labels<L>('screens-ru.json'))) {
      const { view } = read(frame(name), null);
      if (view.screen !== l.screen) {
        errors.push(`${name}: экран ${view.screen}, ждали ${l.screen}`);
        continue;
      }
      if (view.screen === 'pick') {
        if (l.reward !== undefined && view.pick.reward !== l.reward) errors.push(`${name}: reward ${view.pick.reward}`);
        if (l.reroll !== undefined && view.pick.reroll !== l.reroll) errors.push(`${name}: reroll ${view.pick.reroll}`);
      }
      if (view.screen === 'treasure' && view.gifts.length !== 4) errors.push(`${name}: подарков ${view.gifts.length}`);
      if (view.screen === 'board' && l.phase) {
        const b = view.board;
        const phase = b.chain ? 'chain' : b.decision ? b.decision.kind : b.doors.length ? 'patrol' : 'none';
        if (phase !== l.phase) errors.push(`${name}: фаза ${phase}, ждали ${l.phase}`);
        if (l.targets && JSON.stringify(b.chain?.targets.map((c) => c + 1)) !== JSON.stringify(l.targets)) {
          errors.push(`${name}: цели ${JSON.stringify(b.chain?.targets.map((c) => c + 1))}`);
        }
      }
    }
    expect(errors).toEqual([]);
  });
});

/** Кадр, пересэмплированный в другой размер и масштаб интерфейса (ближайший сосед). */
function warp(f: Frame, w: number, h: number, k: number, tx: number, ty: number): Frame {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.floor((x - tx) / k);
      const sy = Math.floor((y - ty) / k);
      const o = (y * w + x) * 4;
      data[o + 3] = 255;
      if (sx < 0 || sy < 0 || sx >= f.width || sy >= f.height) continue;
      const s = (sy * f.width + sx) * 4;
      data[o] = f.data[s]!;
      data[o + 1] = f.data[s + 1]!;
      data[o + 2] = f.data[s + 2]!;
    }
  }
  return { width: w, height: h, data };
}

const sameBoard = (a: ScreenView, b: ScreenView): string => {
  const strip = (v: ScreenView) => (v.screen === 'board' ? { ...v.board, at: null } : v);
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b)) ? '' : `${JSON.stringify(strip(a))}\n≠ ${JSON.stringify(strip(b))}`;
};

describe.skipIf(!HAVE_DATA)('другие разрешения и масштаб интерфейса', { timeout: 300_000 }, () => {
  const names = Object.keys(labels<BoardLabel>('boards-ru.json'));

  it.each([
    ['2560×1440', 2560, 1440, 4 / 3, 0, 0],
    ['1280×720', 1280, 720, 2 / 3, 0, 0],
    ['1920×1080, интерфейс 90 %', 1920, 1080, 0.9, 96, 54],
    ['2560×1080 (21:9)', 2560, 1080, 1, 320, 0],
  ])('%s: доска читается так же', (_, w, h, k, tx, ty) => {
    const errors: string[] = [];
    for (const name of names.slice(0, 3)) {
      // Опорный кадр — 2000 px по ширине, приводим к 1920×1080 и масштабируем.
      const src = frame(`ru/${name}`);
      const base = warp(src, 1920, 1080, 1920 / 2000, 0, 0);
      const want = read(base, null).view;
      const got = read(warp(base, w, h, k, tx, ty), null).view;
      const diff = sameBoard(want, got);
      if (diff) errors.push(`${name}: ${diff}`);
    }
    expect(errors).toEqual([]);
  });
});

describe.skipIf(!HAVE_DATA)('кадры Горна 1920×1080 (своя разметка, по ней же собраны эталоны)', { timeout: 600_000 }, () => {
  type S = { header?: string; days?: number; cards?: string[]; tools?: string[]; chromatic?: number; objective?: string; screen?: string };
  type P = { cards: string[]; reward: boolean };
  it('все размеченные поля', () => {
    const screens = { ...labels<S>('gorn-screens.json'), ...labels<S>('gorn-new-screens.json') };
    const cells = labels<Record<string, string>>('gorn-cells.json');
    const picks = labels<P>('gorn-picks.json');
    const keys = [...new Set([...Object.keys(screens), ...Object.keys(cells), ...Object.keys(picks)])].sort();
    const score = new Score();
    let geo: Geometry | null = null;
    for (const key of keys) {
      const path = key.startsWith('gorn-new/') ? key : `gorn/${key}`;
      const r = read(frame(path), geo);
      geo = r.geo ?? geo;
      const v = r.view;
      const s = screens[key];
      const p = picks[key] ?? (s?.cards && path.includes('instruments') ? (s as P) : undefined);
      if (p) {
        score.add('pick', v.screen === 'pick' && JSON.stringify(v.pick.cards) === JSON.stringify(p.cards) && v.pick.reward === p.reward, key, () =>
          JSON.stringify(v.screen === 'pick' ? v.pick.cards : v.screen),
        );
        continue;
      }
      if (s?.screen) {
        score.add('screen', v.screen === s.screen, key, () => v.screen);
        continue;
      }
      if (v.screen !== 'board') {
        score.add('screen', false, key, () => v.screen);
        continue;
      }
      const b = v.board;
      for (const [n, cls] of Object.entries(cells[key] ?? {})) {
        const c = b.cells[Number(n) - 1]!;
        const got = c.kind === 'inmate' ? c.beast : c.kind === 'locked' ? (c.shownTier !== undefined ? 'unknown' : 'locked') : c.kind;
        score.add('cell', got === cls, `${key} №${n}`, () => `${cls} → ${got}`);
      }
      if (!s) continue;
      if (s.days !== undefined) score.add('days', b.daysLeft === s.days, key, () => `${s.days} → ${b.daysLeft}`);
      if (s.header) {
        const got = b.decision ? (b.decision.kind === 'office' ? 'manage' : b.decision.kind) : b.doors.length ? 'patrol' : 'none';
        score.add('header', got === s.header, key, () => `${s.header} → ${got}`);
      }
      if (s.cards) {
        const d = b.decision;
        const want = s.cards.includes('bestow') ? 'office' : `manage ${s.cards.includes('consume')} ${s.cards.includes('replace')} ${s.cards.includes('end')}`;
        const got = !d ? 'null' : d.kind === 'manage' ? `manage ${d.consume} ${d.replace} ${d.end}` : d.kind;
        score.add('cards', got === want, key, () => `${want} → ${got}`);
      }
      if (s.tools) score.add('tools', JSON.stringify(b.tools) === JSON.stringify(s.tools), key, () => `${s.tools} → ${b.tools}`);
      if (s.chromatic !== undefined) score.add('chromatic', b.chromatic === s.chromatic, key, () => `${s.chromatic} → ${b.chromatic}`);
      if (s.objective) score.add('objective', b.objective === s.objective, key, () => `${s.objective} → ${b.objective}`);
    }
    console.log('кадры Горна\n' + score.table());
    expect(score.errors).toEqual([]);
  });
});

/** Свои кадры Горна, где надпись над карточками дверей не узнаётся (часто — со «Пойти в допросную»). */
const GORN_DAY = join(homedir(), 'Pictures', 'Горн — тюрьма', '2026-10-17');
const DOORS_NO_HEADER: Record<string, number[]> = {
  // камеры как у игрока; 0 — допросная
  '234506-094-board.png': [0, 2, 4],
  '234349-040-board.png': [2, 3, 4],
  '234228-172-board.png': [14, 16, 2],
  '234203-271-board.png': [8, 10, 11],
  '223556-618-board.png': [13, 0, 2],
  '223830-694-board.png': [11, 12, 15],
  '234119-032-board.png': [7, 8, 11],
};

describe.skipIf(!existsSync(GORN_DAY))('двери без узнанной надписи над карточками', () => {
  it('номера дверей читаются по карточкам, допросная — 0, порядок как на экране', () => {
    for (const [name, doors] of Object.entries(DOORS_NO_HEADER)) {
      const b = board(read(frame(join(GORN_DAY, name)), null).view);
      expect(b.doors, name).toEqual(doors.map((n) => (n === 0 ? 0 : n - 1)));
      expect(b.decision, name).toBeNull();
    }
  });
});
