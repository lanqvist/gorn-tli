import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { read } from '../../src/core/prison/recognize/index.js';
import type { Frame, Geometry } from '../../src/core/prison/recognize/types.js';
import type { ScreenView } from '../../src/core/prison/view.js';
import { compareBoard, DATA, frame, HAVE_DATA, labels, Score, type BoardLabel } from './data.js';

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

/**
 * Кадр Горна за день: копия в папке данных (images/gorn-new, images/gorn)
 * или ещё не перенесённый из «Изображения/Горн — тюрьма». null — нигде нет.
 */
function gornShot(day: string, name: string): string | null {
  for (const dir of [join(DATA, 'images', 'gorn-new', day), join(DATA, 'images', 'gorn', day), join(homedir(), 'Pictures', 'Горн — тюрьма', day)]) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

/** Свои кадры Горна, где надпись над карточками дверей не узнаётся (часто — со «Пойти в допросную»). */
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

describe.skipIf(!Object.keys(DOORS_NO_HEADER).every((n) => gornShot('2026-10-17', n)))('двери без узнанной надписи над карточками', () => {
  it('номера дверей читаются по карточкам, допросная — 0, порядок как на экране', () => {
    for (const [name, doors] of Object.entries(DOORS_NO_HEADER)) {
      const b = board(read(frame(gornShot('2026-10-17', name)!), null).view);
      expect(b.doors, name).toEqual(doors.map((n) => (n === 0 ? 0 : n - 1)));
      expect(b.decision, name).toBeNull();
    }
  });
});

const DAY2 = ['113706-965-board.png', '113707-820-board.png', '113709-369-board.png', '113713-948-manual.png', '113719-070-manual.png', '113721-896-board.png', '113434-621-board.png', '113441-963-board.png', '113506-316-board.png'];

describe.skipIf(!DAY2.every((n) => gornShot('2026-10-18', n)))('ряд решений без надписи и панель орудий (кадры 2026-10-18)', () => {
  const at = (name: string) => board(read(frame(gornShot('2026-10-18', name)!), null).view);

  it('одна карточка «Завершить» по центру — ряд решений из одного конца дня', () => {
    for (const name of ['113707-820-board.png', '113709-369-board.png', '113713-948-manual.png', '113719-070-manual.png']) {
      const b = at(name);
      expect(b.decision, name).toEqual({ kind: 'manage', consume: false, replace: false, end: true });
      expect(b.at.decisionKinds, name).toEqual(['end']);
      expect(b.at.decisionCards, name).toHaveLength(1);
    }
  });

  it('надпись есть, а карточка ещё не выехала — не ряд решений', () => {
    expect(at('113706-965-board.png').decision).toBeNull();
  });

  it('ряды из двух карточек: Замена + Завершить, Пожирание + Завершить', () => {
    expect(at('113434-621-board.png').at.decisionKinds).toEqual(['replace', 'end']);
    expect(at('113506-316-board.png').at.decisionKinds).toEqual(['consume', 'end']);
  });

  it('панель орудий: «Монета судьбы» и «Раскалённое клеймо»; стена с отсветом — не орудие', () => {
    for (const name of ['113707-820-board.png', '113713-948-manual.png', '113721-896-board.png']) expect(at(name).tools, name).toEqual(['coin', 'fire']);
    expect(at('113441-963-board.png').tools).toEqual(['coin']);
  });
});

const PANELS: Record<string, string[]> = {
  '125242-629-board.png': ['muzzle', 'scapegoat'],
  '131213-208-board.png': ['skewer'],
  '131347-199-board.png': ['skewer', 'axe'],
  '132431-694-board.png': ['maiden'],
  '132502-727-board.png': ['maiden', 'revenge'],
  // Кадры для проверки (в эталоны не входят): «Крюк отбора», «Шипастый ошейник», «Переполненная клетка», «Кишащий железный ящик».
  '171022-899-board.png': ['coin', 'hook'],
  '171102-232-board.png': ['coin', 'hook'],
  '173758-268-board.png': ['collar'],
  '174011-513-board.png': ['collar', 'skewer'],
  '174028-246-board.png': ['collar', 'skewer'],
  '175936-705-board.png': ['collar', 'cage'],
  '180035-952-board.png': ['collar', 'cage'],
  '180055-997-board.png': ['collar', 'cage'],
  '184015-567-board.png': ['hook', 'ironbox'],
  '184118-933-board.png': ['hook', 'ironbox'],
  '184201-534-board.png': ['hook', 'ironbox'],
  '191640-677-board.png': ['trap'],
  '191642-891-board.png': ['trap'],
  // «Голодная удушающая цепь» (читалась как «Плеть»), «Кандалы с длинной цепью», «Молот».
  '202455-005-board.png': ['rope', 'ravenous'],
  '202508-004-board.png': ['rope', 'ravenous'],
  '202521-837-board.png': ['rope', 'ravenous'],
  '204001-427-board.png': ['trap', 'shackles'],
  '204034-268-board.png': ['trap', 'shackles'],
  '204052-277-board.png': ['trap', 'shackles'],
  '210427-523-board.png': ['maul', 'coin'],
  '210447-789-board.png': ['maul', 'coin'],
  '210500-681-board.png': ['maul', 'coin'],
};

/** Кадры 2026-10-19, не вошедшие в эталоны: «Весы тюремщика» (scales) на панели. */
const PANELS_19: Record<string, string[]> = {
  '145757-503-board.png': ['rope', 'scales'],
  '145808-234-board.png': ['rope', 'scales'],
  '145829-899-board.png': ['rope', 'scales'],
};

describe.skipIf(!Object.keys(PANELS_19).every((n) => gornShot('2026-10-19', n)))('панель орудий (забег 2026-10-19 14:54)', () => {
  it('«Весы тюремщика» — не «без эталона»', () => {
    for (const [name, tools] of Object.entries(PANELS_19)) {
      const b = board(read(frame(gornShot('2026-10-19', name)!), null).view);
      expect(b.toolSlots, name).toEqual(tools);
    }
  });
});

/** Кадры 2026-10-19 22:49, не вошедшие в эталоны: «Клещи порока» (tongs) на панели. */
const PANELS_TONGS: Record<string, string[]> = {
  '225107-912-board.png': ['maul', 'tongs'],
  '225147-790-board.png': ['maul', 'tongs'],
  '225221-368-board.png': ['maul', 'tongs'],
};

describe.skipIf(!Object.keys(PANELS_TONGS).every((n) => gornShot('2026-10-19', n)))('панель орудий (забег 2026-10-19 22:49)', () => {
  it('«Клещи порока» — не «без эталона» (раньше орудие было только «предположительно»)', () => {
    for (const [name, tools] of Object.entries(PANELS_TONGS)) {
      const b = board(read(frame(gornShot('2026-10-19', name)!), null).view);
      expect(b.toolSlots, name).toEqual(tools);
    }
  });
});

describe.skipIf(!gornShot('2026-10-18', '140412-100-instruments.png') || !gornShot('2026-10-19', '210657-658-instruments.png'))('карта выбора под курсором всплывает', () => {
  it('«Жетон каторжника» и «Чёрный список экзекутора» под курсором узнаются', () => {
    const p1 = read(frame(gornShot('2026-10-18', '140412-100-instruments.png')!), null).view;
    const p2 = read(frame(gornShot('2026-10-19', '210657-658-instruments.png')!), null).view;
    expect(p1.screen === 'pick' && p1.pick.cards).toEqual(['shortchain', 'dogtag', 'pestle']);
    expect(p2.screen === 'pick' && p2.pick.cards).toEqual(['stake', 'blacklist', 'rope']);
  });
});

describe.skipIf(!['172404-856-instruments.png', '175837-884-instruments.png', '201141-701-instruments.png'].every((n) => gornShot('2026-10-19', n)))('карты выбора (забеги 2026-10-19)', () => {
  it('«Висельная петля» под курсором (20:11:41)', () => {
    const p = read(frame(gornShot('2026-10-19', '201141-701-instruments.png')!), null).view;
    expect(p.screen === 'pick' && p.pick.cards).toEqual(['cage', 'shortchain', 'rope']);
  });

  it('«Грязный железный коготь: Вожак» узнаётся (17:24:04 — эталон, 17:58:37 — проверка)', () => {
    const p1 = read(frame(gornShot('2026-10-19', '172404-856-instruments.png')!), null).view;
    const p2 = read(frame(gornShot('2026-10-19', '175837-884-instruments.png')!), null).view;
    expect(p1.screen === 'pick' && p1.pick.cards).toEqual(['claws', 'maiden', 'dogtag']);
    expect(p2.screen === 'pick' && p2.pick.cards).toEqual(['claws', 'revenge', 'maiden']);
  });
});

describe.skipIf(!Object.keys(PANELS).every((n) => gornShot('2026-10-18', n)))('панель орудий и карты выбора (забеги 2026-10-18)', () => {
  it('иконки панели: Шампур, Секира, Саркофаг, Дева мстителя, Козёл отпущения, Крюк, Ошейник, Клетка, Железный ящик, Капкан, Цепь, Кандалы, Молот; пустое место с отсветом — не орудие', () => {
    for (const [name, tools] of Object.entries(PANELS)) {
      const b = board(read(frame(gornShot('2026-10-18', name)!), null).view);
      expect(b.toolSlots, name).toEqual(tools);
    }
  });

  it('карты выбора: Гильотина с волчьими клыками, Весы тюремщика, Столб под курсором', () => {
    const p1 = read(frame(gornShot('2026-10-18', '132417-742-instruments.png')!), null).view;
    const p2 = read(frame(gornShot('2026-10-18', '132439-724-instruments.png')!), null).view;
    expect(p1.screen === 'pick' && p1.pick.cards).toEqual(['maiden', 'forged', 'guillotine']);
    expect(p2.screen === 'pick' && p2.pick.cards).toEqual(['hook', 'scales', 'revenge']);
    // Курсор на «Столбе для сожжения»: карта подсвечена (17:57:46).
    const p3 = read(frame(gornShot('2026-10-18', '175746-589-instruments.png')!), null).view;
    expect(p3.screen === 'pick' && p3.pick.cards).toEqual(['collar', 'stake', 'saw']);
    // «Молот Слоновья нога» и «Клещи порока» (20:48; кадр не из эталонов).
    const p4 = read(frame(gornShot('2026-10-18', '204846-672-instruments.png')!), null).view;
    expect(p4.screen === 'pick' && p4.pick.cards).toEqual(['revenge', 'maul', 'tongs']);
    // «Пыточный намордник» под курсором (21:21:33).
    const p5 = read(frame(gornShot('2026-10-18', '212133-440-instruments.png')!), null).view;
    expect(p5.screen === 'pick' && p5.pick.cards).toEqual(['scales', 'shortchain', 'muzzle']);
  });
});

/** Хранилище на кадрах, не вошедших в эталоны (забег 18.10 18:05–18:09, «Железный закон»). */
const VAULT: Record<string, number> = {
  // Камера сдвинута, справа круглые окна вместо панели — не видно (раньше читалось 0).
  '180707-942-board.png': -1,
  '180823-947-board.png': -1,
  '180848-685-board.png': -1,
  // Доска из окна подарка (затемнение): тусклые портреты — занятые места.
  '180724-098-board.png': 6,
  '180842-459-board.png': 10,
};

describe.skipIf(!Object.keys(VAULT).every((n) => gornShot('2026-10-18', n)))('хранилище и панель за окном подарка (забег 2026-10-18 18:05)', () => {
  it('сдвинутая камера — «не видно», затемнение — все портреты; пустая ячейка — не «Плеть»', () => {
    for (const [name, n] of Object.entries(VAULT)) {
      const b = board(read(frame(gornShot('2026-10-18', name)!), null).view);
      expect(b.chromatic, name).toBe(n);
      expect(b.tools.includes('whip'), name).toBe(false);
    }
  });
});

describe.skipIf(!['185837-234-board.png', '185907-643-board.png', '184201-534-board.png'].every((n) => gornShot('2026-10-18', n)))('редкость не нарисована после переподключения (забег 2026-10-18 18:58)', () => {
  const cells = (name: string) => board(read(frame(gornShot('2026-10-18', name)!), null).view).cells;
  const unknown = (name: string) => cells(name).flatMap((c, i) => (c.tierUnknown ? [i] : []));

  it('прежние узники без свечения — редкость неизвестна', () => {
    expect(unknown('185837-234-board.png')).toEqual([1, 3, 4, 7, 8, 11, 12, 15]);
  });

  it('новые узники после переподключения со свечением; обычная доска — без флага', () => {
    const c = cells('185907-643-board.png');
    // №10 и №11 — обычные с белым свечением, №9 и №16 — прежние, без свечения.
    expect([c[9]!.tier, c[9]!.tierUnknown, c[10]!.tier, c[10]!.tierUnknown]).toEqual([0, undefined, 0, undefined]);
    expect(unknown('185907-643-board.png')).toEqual([8, 15]);
    expect(unknown('184201-534-board.png')).toEqual([]);
  });
});

describe.skipIf(!['191617-510-board.png', '191646-199-board.png', '191647-757-board.png'].every((n) => gornShot('2026-10-18', n)))('ряд решений с «Выслеживанием» (забег 2026-10-18 19:16)', () => {
  it('три и четыре карточки; «Выслеживание» — не «Завершить»', () => {
    const kinds = (name: string) => board(read(frame(gornShot('2026-10-18', name)!), null).view).at.decisionKinds;
    expect(kinds('191617-510-board.png')).toEqual(['consume', 'hunt', 'end']);
    for (const n of ['191646-199-board.png', '191647-757-board.png']) {
      const b = board(read(frame(gornShot('2026-10-18', n)!), null).view);
      expect(b.at.decisionKinds, n).toEqual(['consume', 'replace', 'hunt', 'end']);
      expect(b.decision, n).toMatchObject({ kind: 'manage', hunt: true });
      expect(b.at.decisionCards.length, n).toBe(4);
    }
  });
});

describe.skipIf(!['193251-271-board.png', '193131-795-board.png', '191645-322-board.png', '184201-534-board.png'].every((n) => gornShot('2026-10-18', n)))('метка «Добыча» на портрете (забеги 2026-10-18 19:16, 19:30)', () => {
  const prey = (name: string) => board(read(frame(gornShot('2026-10-18', name)!), null).view).cells.flatMap((c, i) => (c.prey ? [i] : []));
  it('прицел виден и на затемнённом экране выбора цели; без меток — пусто', () => {
    expect(prey('193251-271-board.png')).toEqual([9]);
    expect(prey('193131-795-board.png')).toEqual([9, 10]);
    expect(prey('191645-322-board.png')).toEqual([13]);
    expect(prey('184201-534-board.png')).toEqual([]);
  });
});
