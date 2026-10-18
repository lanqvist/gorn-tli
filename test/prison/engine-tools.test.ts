import { describe, expect, it } from 'vitest';

import { LION, MAMMOTH, RAT, WOLF, type Action, type ToolId } from '../../src/core/prison/model.js';
import { applyCode, codeBuffer, decode, encode, legalCodes } from '../../src/core/prison/engine/actions.js';
import type { Rng } from '../../src/core/prison/engine/rng.js';
import { bite, canEat, morning, openCell } from '../../src/core/prison/engine/rules.js';
import {
  DOORS, DOORS_N, FLAGS, F_SCRATCH, F_TUSK, F_VIS_BEAST, F_VIS_TIER, HUNT_LEFT, LOCK, NEST, PHASE, PRE_TIER,
  P_PATROL, State, WARDEN,
} from '../../src/core/prison/engine/state.js';
import { NO, P, Seq, YES, beast, blank, hide, inmates, locked, manageAt, put, tier } from './engine-helpers.js';

const act = (s: State, a: Action, r: Rng = NO) => applyCode(s, encode(a), r, P);
const legal = (s: State) => {
  const buf = codeBuffer();
  const n = legalCodes(s, buf);
  return Array.from(buf.subarray(0, n), decode);
};
const withTools = (...tools: ToolId[]) => blank({ tools });

/** Обход из from в to (единственная карточка). */
function patrol(s: State, from: number, to: number, r: Rng): void {
  s.m[WARDEN] = from;
  s.m[DOORS] = to;
  s.m[DOORS_N] = 1;
  s.m[PHASE] = P_PATROL;
  act(s, { type: 'patrol', cell: to }, r);
}

function tierSum(s: State): number {
  let n = 0;
  for (let c = 1; c < 16; c++) if (tier(s, c) >= 0) n += tier(s, c);
  return n;
}

describe('орудия обхода и дверей', () => {
  it('Поддельный ключ: после открытия обходом 50 % — ещё одна случайная запертая камера', () => {
    const s = withTools('forged');
    patrol(s, 0, 3, YES);
    expect(locked(s, 3) || locked(s, 1)).toBe(false);
    expect(inmates(s)).toBe(2);
    const t = withTools('forged');
    patrol(t, 0, 3, NO);
    expect(inmates(t)).toBe(1);
  });

  it('Потерянная связка ключей: открываются обе соседние запертые камеры', () => {
    const s = withTools('keys');
    patrol(s, 0, 3, YES);
    expect([locked(s, 2), locked(s, 3), locked(s, 4), locked(s, 1)]).toEqual([false, false, false, true]);
  });

  it('Жетон каторжника: 25 % — узник за дверью +1', () => {
    const s = withTools('dogtag');
    patrol(s, 0, 3, YES);
    expect(tier(s, 3)).toBe(1);
  });

  it('Чёрный список экзекутора: запертых не больше 5 — 2 случайных узника +1', () => {
    const s = withTools('blacklist');
    for (let c = 1; c <= 10; c++) put(s, c, MAMMOTH, 0);
    patrol(s, 10, 11, YES);
    expect(tier(s, 1) + tier(s, 2)).toBe(2);
    expect(tierSum(s)).toBe(2);
    const t = withTools('blacklist');
    patrol(t, 0, 3, YES);
    expect(tierSum(t)).toBe(0);
  });

  it('Раскалённое клеймо: копия узника в случайной запертой камере, она открывается', () => {
    const s = withTools('fire');
    hide(s, 3, WOLF, 2);
    patrol(s, 0, 3, YES);
    expect([beast(s, 1), tier(s, 1)]).toEqual([WOLF, 2]);
  });

  it('Крюк отбора: Обычные больше не появляются (двери и замена)', () => {
    const s = withTools('hook');
    openCell(s, YES, P, 5);
    expect(tier(s, 5)).toBe(1);
    manageAt(s, 5, YES);
    act(s, { type: 'swap' }, YES);
    expect(tier(s, 5)).toBe(1);
  });

  it('Кандалы с короткой цепью: ход не длиннее 3 шагов, 50 % — открывается запертая камера', () => {
    const s = withTools('shortchain');
    patrol(s, 0, 3, YES);
    expect(inmates(s)).toBe(2);
    const t = withTools('shortchain');
    patrol(t, 0, 4, YES);
    expect(inmates(t)).toBe(1);
  });

  it('Кандалы с длинной цепью: ход от 4 шагов, 40 % — случайный узник +1', () => {
    const s = withTools('shackles');
    put(s, 10, LION, 1);
    patrol(s, 0, 4, YES);
    expect(tierSum(s)).toBe(2);
    const t = withTools('shackles');
    put(t, 10, LION, 1);
    patrol(t, 0, 3, YES);
    expect(tierSum(t)).toBe(1);
  });

  it('Столб для сожжения: замена узника ниже Легендарной, 40 % — новый Легендарный', () => {
    const s = withTools('stake');
    put(s, 1, LION, 1);
    manageAt(s, 1, YES);
    act(s, { type: 'swap' }, YES);
    expect(tier(s, 1)).toBe(3);
    const t = withTools('stake');
    put(t, 1, LION, 3);
    manageAt(t, 1, YES);
    act(t, { type: 'swap' }, YES);
    expect(tier(t, 1)).toBe(0);
  });
});

describe('орудия пожирания', () => {
  it('Шипастая железная плеть: укус 35 % — ещё +1', () => {
    const s = withTools('whip');
    put(s, 1, MAMMOTH, 1);
    put(s, 2, LION, 1);
    bite(s, YES, P, 1, 2, false);
    expect(tier(s, 1)).toBe(3);
  });

  it('Ржавая пила: после Пожирания 25 % — +1', () => {
    const s = withTools('saw');
    put(s, 1, MAMMOTH, 1);
    put(s, 2, LION, 1);
    manageAt(s, 1, YES);
    act(s, { type: 'devour', to: 2 }, YES);
    expect(tier(s, 1)).toBe(3);
  });

  it('Ржавая пила срабатывает и на укусе цепочки («цепное Пожирание»)', () => {
    const s = withTools('saw');
    put(s, 1, MAMMOTH, 0);
    put(s, 2, LION, 0);
    put(s, 3, RAT, 2);
    manageAt(s, 1, YES);
    act(s, { type: 'devour', to: 2 }, YES); // 0 + 1 + пила: Редкий мамонт
    expect([beast(s, 1), tier(s, 1)]).toEqual([MAMMOTH, 2]);
    bite(s, YES, P, 3, 1, true); // укус в цепочке: 2 + 1 + пила
    expect(tier(s, 3)).toBe(4);
  });

  it('Шипастый ошейник: укус в цепочке 80 % — +1', () => {
    const s = withTools('collar');
    put(s, 1, MAMMOTH, 1);
    put(s, 2, LION, 1);
    bite(s, YES, P, 1, 2, true);
    expect(tier(s, 1)).toBe(3);
    put(s, 1, MAMMOTH, 1);
    put(s, 2, LION, 1);
    bite(s, YES, P, 1, 2, false);
    expect(tier(s, 1)).toBe(2);
  });

  it('Пыточный намордник: +2, если до укуса на поле не больше 4 узников (с едоком и жертвой)', () => {
    const s = withTools('muzzle');
    for (let c = 3; c <= 4; c++) put(s, c, WOLF, 0);
    put(s, 1, MAMMOTH, 1);
    put(s, 2, LION, 1);
    bite(s, NO, P, 1, 2, false); // 4 до укуса
    expect(tier(s, 1)).toBe(4);
    const t = withTools('muzzle');
    for (let c = 3; c <= 5; c++) put(t, c, WOLF, 0);
    put(t, 1, MAMMOTH, 1);
    put(t, 2, LION, 1);
    bite(t, NO, P, 1, 2, false); // 5 до укуса, 4 после — без добавки (кадры 18.10)
    expect(tier(t, 1)).toBe(2);
  });

  it('Железная дева мстителя: после Пожирания 30 % — открывается камера с едой для едока', () => {
    const s = withTools('revenge');
    put(s, 1, MAMMOTH, 1);
    put(s, 2, LION, 1);
    manageAt(s, 1, YES);
    act(s, { type: 'devour', to: 2 }, YES);
    // едок — Редкий мамонт (YES), еда — Редкий лев в первой запертой камере
    expect([beast(s, 1), tier(s, 1)]).toEqual([MAMMOTH, 2]);
    expect([beast(s, 2), tier(s, 2)]).toEqual([LION, 2]);
  });

  it('Переполненная клетка зверей: 40 % — камера съеденного сразу открывается с новым узником', () => {
    const s = withTools('cage');
    put(s, 1, MAMMOTH, 1);
    put(s, 2, LION, 1);
    bite(s, YES, P, 1, 2, false);
    expect(locked(s, 2)).toBe(false);
    expect([beast(s, 2), tier(s, 2)]).toEqual([MAMMOTH, 0]);
  });

  it('Шампур (клиент 148): крыса ест крысу той же редкости, после Пожирания ещё +2', () => {
    const s = blank();
    put(s, 1, RAT, 1);
    put(s, 2, RAT, 1);
    expect(canEat(s, 1, 2)).toBe(false);
    const t = withTools('skewer');
    put(t, 1, RAT, 1);
    put(t, 2, RAT, 1);
    expect(canEat(t, 1, 2)).toBe(true);
    bite(t, NO, P, 1, 2, false);
    expect(tier(t, 1)).toBe(4); // 1 + 1 + 2
    const u = withTools('skewer');
    put(u, 1, RAT, 0);
    put(u, 2, MAMMOTH, 0);
    bite(u, NO, P, 1, 2, false); // за мамонта — обычный +1 (кадры 18.10: Крыса 3 съела Мамонта 3 → Крыса 4)
    expect(tier(u, 1)).toBe(1);
  });

  it('Железная корона: лев ест любого той же редкости, укус льва +2', () => {
    const s = withTools('crown');
    put(s, 1, LION, 1);
    put(s, 2, MAMMOTH, 1);
    put(s, 3, MAMMOTH, 2);
    expect(canEat(s, 1, 2)).toBe(true);
    expect(canEat(s, 1, 3)).toBe(false);
    bite(s, NO, P, 1, 2, false);
    expect(tier(s, 1)).toBe(4);
  });

  it('Молот «Слоновья нога»: мамонт ест свою еду и выше, прирост max(1, еда + 2 − едок)', () => {
    const s = withTools('maul');
    put(s, 1, MAMMOTH, 0);
    put(s, 2, LION, 1);
    put(s, 3, MAMMOTH, 2);
    put(s, 4, LION, 1);
    expect(canEat(s, 1, 2)).toBe(true);
    expect(canEat(s, 3, 4)).toBe(false);
    bite(s, NO, P, 1, 2, false);
    expect(tier(s, 1)).toBe(3);
    const t = withTools('maul');
    put(t, 1, MAMMOTH, 1);
    put(t, 2, LION, 1);
    bite(t, NO, P, 1, 2, false);
    expect(tier(t, 1)).toBe(3);
  });

  it('«Подавление» только у Гильотины: «Схватка узников» ест ниже без него', () => {
    const p = { ...P, oppressStep: 0.5 };
    const s = blank({ start: 'cagefight' });
    put(s, 1, WOLF, 2);
    put(s, 2, RAT, 0);
    bite(s, new Seq([0.99]), p, 1, 2, false);
    expect(tier(s, 1)).toBe(3);
  });

  it('«Подавление»: укус узника ниже — шанс повышения −5 % за ранг разницы', () => {
    const p = { ...P, oppressStep: 0.5 };
    const s = withTools('guillotine');
    put(s, 1, WOLF, 2);
    put(s, 2, RAT, 0);
    bite(s, new Seq([0.5]), p, 1, 2, false); // шанс 1 − 0,5 · 2 = 0: не повысился
    expect(tier(s, 1)).toBe(2);
    const t = withTools('guillotine');
    put(t, 1, WOLF, 2);
    put(t, 2, RAT, 1);
    bite(t, new Seq([0.4]), p, 1, 2, false); // шанс 0,5
    expect(tier(t, 1)).toBe(3);
  });

  it('Клыкастая гильотина: волк ест крыс ниже по редкости', () => {
    const s = withTools('guillotine');
    put(s, 1, WOLF, 2);
    put(s, 2, RAT, 0);
    put(s, 3, LION, 0);
    expect(canEat(s, 1, 2)).toBe(true);
    expect(canEat(s, 1, 3)).toBe(false);
    const t = blank();
    put(t, 1, WOLF, 2);
    put(t, 2, RAT, 0);
    expect(canEat(t, 1, 2)).toBe(false);
  });

  it('Железная дева мстителя: еда — любой зверь, над которым у едока преимущество', () => {
    const s = withTools('revenge');
    put(s, 1, MAMMOTH, 1);
    put(s, 2, LION, 1);
    manageAt(s, 1, YES);
    act(s, { type: 'devour', to: 2 }, new Seq([0, 0, 0, 0, 0.6, 0]));
    // Seq: шансы да, новый зверь — мамонт, дева да, камера 2, вторая еда (волк)
    expect([beast(s, 2), tier(s, 2)]).toEqual([WOLF, 2]);
  });

  it('Голодная удушающая цепь: утром самый редкий убирает соседей, +1 за каждого 40 %', () => {
    const s = withTools('ravenous');
    put(s, 5, LION, 2);
    put(s, 4, RAT, 0);
    put(s, 6, WOLF, 1);
    put(s, 10, MAMMOTH, 1);
    morning(s, YES, P);
    expect(locked(s, 4) && locked(s, 6)).toBe(true);
    expect(tier(s, 5)).toBe(4);
    expect(tier(s, 10)).toBe(1);
  });
});

describe('орудия замены', () => {
  it('Висельная петля: после замены нет Обычных и Магических', () => {
    const s = withTools('rope');
    put(s, 1, LION, 1);
    manageAt(s, 1, YES);
    act(s, { type: 'swap' }, YES);
    expect(tier(s, 1)).toBe(2);
  });

  it('Железный пест: узник сохраняет прежнего зверя', () => {
    const s = withTools('pestle');
    put(s, 1, LION, 1);
    manageAt(s, 1, YES);
    act(s, { type: 'swap' }, YES);
    expect(beast(s, 1)).toBe(LION);
  });

  it('Весы тюремщика: 80 % — показан лучший узник за запертыми дверями', () => {
    const s = withTools('scales');
    put(s, 1, LION, 1);
    manageAt(s, 1, YES);
    act(s, { type: 'swap' }, new Seq([0, 0, 0, 0.3, 0.1, 0.7, 0.2, 0.95, 0.4, 0.6, 0.5, 0.8, 0.05, 0.9, 0.15, 0.45]));
    let shown = -1;
    let best = -1;
    for (let c = 2; c < 16; c++) {
      if (!locked(s, c)) continue;
      best = Math.max(best, s.m[PRE_TIER + c]!);
      if ((s.m[FLAGS + c]! & (F_VIS_TIER | F_VIS_BEAST)) === (F_VIS_TIER | F_VIS_BEAST)) {
        expect(shown).toBe(-1);
        shown = c;
      }
    }
    expect(shown).toBeGreaterThan(0);
    expect(s.m[PRE_TIER + shown]).toBe(best);
  });

  it('Палаческая секира: новый выше прежнего — открываются 2 запертые камеры', () => {
    const s = withTools('axe');
    put(s, 1, LION, 0);
    manageAt(s, 1, YES);
    act(s, { type: 'swap' }, new Seq([0.85, 0]));
    expect(tier(s, 1)).toBe(2);
    expect(inmates(s)).toBe(3);
    const t = withTools('axe');
    put(t, 1, LION, 3);
    manageAt(t, 1, YES);
    act(t, { type: 'swap' }, new Seq([0.85, 0]));
    expect(inmates(t)).toBe(1);
  });

  it('Рассечённый саркофаг: выше нового столько же, сколько ниже — +3', () => {
    const s = withTools('maiden');
    put(s, 1, LION, 1);
    manageAt(s, 1, YES);
    act(s, { type: 'swap' }, YES);
    expect(tier(s, 1)).toBe(3);
    const t = withTools('maiden');
    put(t, 1, LION, 1);
    put(t, 5, WOLF, 2);
    manageAt(t, 1, YES);
    act(t, { type: 'swap' }, YES);
    expect(tier(t, 1)).toBe(0);
  });

  it('Гильотина козла отпущения: при 2+ других — 2 убираются, новый гарантированно выше прежнего', () => {
    const s = withTools('scapegoat');
    put(s, 1, LION, 1);
    put(s, 2, WOLF, 0);
    put(s, 3, RAT, 3);
    manageAt(s, 1, YES);
    act(s, { type: 'swap' }, YES);
    expect(tier(s, 1)).toBe(2);
    expect(locked(s, 2) && locked(s, 3)).toBe(true);
    const t = withTools('scapegoat');
    put(t, 1, LION, 1);
    put(t, 2, WOLF, 0);
    manageAt(t, 1, YES);
    act(t, { type: 'swap' }, YES);
    expect(tier(t, 1)).toBe(0);
    expect(tier(t, 2)).toBe(0);
  });
});

describe('утренние орудия', () => {
  it('Железные щипцы: «бивень» на мамонте; замена в этой камере — 4 случайных узника +1', () => {
    const s = withTools('tongs');
    put(s, 3, MAMMOTH, 1);
    put(s, 5, LION, 0);
    put(s, 6, WOLF, 0);
    put(s, 7, RAT, 0);
    put(s, 8, RAT, 1);
    morning(s, YES, P);
    expect(s.m[FLAGS + 3]! & F_TUSK).toBeTruthy();
    manageAt(s, 3, YES);
    act(s, { type: 'swap' }, YES);
    expect([tier(s, 3), tier(s, 5), tier(s, 6), tier(s, 7), tier(s, 8)]).toEqual([1, 1, 1, 1, 1]);
    // «Бивень» — метка камеры (tlidb): после замены остаётся, сходит, когда камера пустеет
    expect(s.m[FLAGS + 3]! & F_TUSK).toBeTruthy();
  });

  it('Клещи, Когти и Ящик (клиент 141, 145, 147) ставят по метке каждое утро', () => {
    const s = withTools('tongs', 'claws', 'ironbox');
    put(s, 3, MAMMOTH, 0);
    put(s, 4, MAMMOTH, 0);
    morning(s, YES, P);
    morning(s, YES, P);
    let tusks = 0;
    let scratches = 0;
    let nests = 0;
    for (let c = 1; c < 16; c++) {
      if (s.m[FLAGS + c]! & F_TUSK) tusks++;
      if (s.m[LOCK + c] === 1 && s.m[FLAGS + c]! & F_SCRATCH) scratches++;
      if (s.m[NEST + c]! > 0) nests++;
    }
    expect([tusks, scratches, nests]).toEqual([2, 2, 2]);
  });

  it('Грязные когти: царапина показывает редкость, волк той же редкости ест сквозь дверь, прирост 3', () => {
    const s = withTools('claws');
    morning(s, YES, P);
    expect(s.m[FLAGS + 1]! & F_SCRATCH).toBeTruthy();
    expect(s.m[FLAGS + 1]! & F_VIS_TIER).toBeTruthy();
    expect(s.m[PRE_TIER + 1]).toBe(0);
    put(s, 5, WOLF, 0);
    put(s, 6, WOLF, 1);
    put(s, 7, LION, 0);
    expect(canEat(s, 5, 1)).toBe(true);
    expect(canEat(s, 6, 1)).toBe(false);
    expect(canEat(s, 7, 1)).toBe(false);
    manageAt(s, 5, YES);
    expect(legal(s)).toContainEqual({ type: 'devour', to: 1 });
    bite(s, NO, P, 5, 1, false);
    expect(tier(s, 5)).toBe(3);
    expect(locked(s, 1)).toBe(true);
    expect(s.m[FLAGS + 1]).toBe(0);
    expect(s.m[PRE_TIER + 1]).toBe(-1);
  });

  it('Шевелящийся железный ящик: гнездо через 2 дня открывается Редкой крысой', () => {
    const s = withTools('ironbox');
    morning(s, YES, P);
    expect(s.m[NEST + 1]).toBe(2);
    morning(s, YES, P);
    expect(s.m[NEST + 1]).toBe(1);
    morning(s, YES, P);
    expect([beast(s, 1), tier(s, 1)]).toEqual([RAT, 2]);
  });

  it('обход в гнездо его уничтожает', () => {
    const s = withTools('ironbox');
    s.m[NEST + 3] = 2;
    patrol(s, 0, 3, YES);
    expect(s.m[NEST + 3]).toBe(0);
    expect(tier(s, 3)).toBe(0);
  });

  it('Монета судьбы: пара одинаковых — один уходит, другой +2', () => {
    const s = withTools('coin');
    put(s, 2, MAMMOTH, 1);
    put(s, 5, MAMMOTH, 1);
    put(s, 7, LION, 1);
    morning(s, YES, P);
    expect(locked(s, 2)).toBe(true);
    expect(tier(s, 5)).toBe(3);
    expect(tier(s, 7)).toBe(1);
  });

  it('Окровавленный капкан: «Выслеживание» в камере льва, «Добыча» 3 хода — оба +1 каждое утро', () => {
    const s = withTools('trap');
    put(s, 2, LION, 0);
    put(s, 3, WOLF, 0);
    put(s, 9, RAT, 2);
    manageAt(s, 9);
    expect(legal(s).some((a) => a.type === 'hunt')).toBe(false); // не лев
    manageAt(s, 2);
    expect(legal(s).filter((a) => a.type === 'hunt')).toEqual([{ type: 'hunt', to: 3 }]);
    act(s, { type: 'hunt', to: 3 }, YES);
    // это действие дня: день кончился, первое утро уже прошло
    expect(s.m[PHASE]).toBe(P_PATROL);
    expect(s.m[HUNT_LEFT]).toBe(2);
    for (let i = 0; i < 3; i++) morning(s, YES, P);
    expect([tier(s, 2), tier(s, 3), tier(s, 9)]).toEqual([3, 3, 2]);
  });

  it('«Добыча» сходит, когда лев или добыча сменили кодовое имя', () => {
    const s = withTools('trap');
    put(s, 2, LION, 0);
    put(s, 3, WOLF, 0);
    put(s, 4, RAT, 0);
    manageAt(s, 2);
    act(s, { type: 'hunt', to: 3 }, YES);
    expect(s.m[HUNT_LEFT]).toBe(2);
    // волк съедает крысу и меняет зверя (Seq: прирост без шансов, новый зверь — мамонт)
    bite(s, new Seq([0]), P, 3, 4, false);
    expect(beast(s, 3)).toBe(MAMMOTH);
    expect(s.m[HUNT_LEFT]).toBe(0);
  });
});

