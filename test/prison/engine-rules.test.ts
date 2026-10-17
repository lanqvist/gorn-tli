import { describe, expect, it } from 'vitest';

import {
  EVENT, LION, MAMMOTH, OBJECTIVE, RAT, TOOL, TOOL_IDS, WOLF,
} from '../../src/core/prison/model.js';
import {
  applyCode, codeBuffer, createEngine, decode, encode, legalCodes, settle,
} from '../../src/core/prison/engine/actions.js';
import { Rng } from '../../src/core/prison/engine/rng.js';
import {
  bite, canEat, dealDoors, eventDecision, openCell, raise, relock, rollTier, runEvent, takeGift, targets,
} from '../../src/core/prison/engine/rules.js';
import {
  CHAIN_EATER, CHAIN_REACTION, DAY, DAY_LIMIT, DOORS, DOORS_N, EVT, FLAGS, F_VIS_RARE, F_VIS_TIER, NEXT,
  OBJECTIVE_ID, OBJ_DONE, OBJ_PROGRESS, OFFER_KIND, OFFER_N, OFFER_GIFT, OFFER_TOOL, OFFER, PHASE, PICK_GIFTS,
  PICK_TOOLS, PRE_TIER, P_CHAIN, P_EVENT, P_MANAGE, P_MORNING, P_OFFICE, P_PATROL, P_PICK, P_RATWAY, REROLLS, STAT_BITES,
  STAT_EVENTS, STAT_STEPS, STORAGE, State, TOOLS, USED, WARDEN, dist,
} from '../../src/core/prison/engine/state.js';
import { NO, P, Seq, YES, beast, blank, hide, inmates, locked, manageAt, put, tier } from './engine-helpers.js';

const legal = (s: State) => {
  const buf = codeBuffer();
  const n = legalCodes(s, buf);
  return Array.from(buf.subarray(0, n), decode);
};
const act = (s: State, a: Parameters<typeof encode>[0], r: Rng = NO) => applyCode(s, encode(a), r, P);

/** Надзиратель в камере from, единственный пункт назначения — to. */
function doorTo(s: State, from: number, to: number): void {
  s.m[WARDEN] = from;
  s.m[DOORS] = to;
  s.m[DOORS_N] = 1;
  s.m[PHASE] = P_PATROL;
}

describe('поле и начало забега', () => {
  it('допросная открыта, остальные заперты, надзиратель в допросной, сначала выбор орудия', () => {
    const e = createEngine(P);
    const s = new State();
    e.start(s, new Rng(3));
    expect(s.m[WARDEN]).toBe(0);
    expect(locked(s, 0)).toBe(false);
    for (let c = 1; c < 16; c++) expect(locked(s, c)).toBe(true);
    expect(s.m[PHASE]).toBe(P_PICK);
    const moves = e.legal(s);
    expect(moves.filter((a) => a.type === 'choose')).toHaveLength(3);
    expect(moves).toContainEqual({ type: 'reroll' });
  });

  it('расстояние — шаги по часовой стрелке', () => {
    expect(dist(0, 3)).toBe(3);
    expect(dist(14, 2)).toBe(4);
    expect(dist(5, 5)).toBe(0);
  });

  it('забег — 20 дней, «Железный закон» — 30', () => {
    expect(blank().m[DAY_LIMIT]).toBe(20);
    expect(blank({ start: 'ironlaw' }).m[DAY_LIMIT]).toBe(30);
  });

  it('события за дверями в начале забега — по шансу doorEvent', () => {
    const s = new State();
    const e = createEngine();
    let events = 0;
    const r = new Rng(11);
    for (let i = 0; i < 2000; i++) {
      e.start(s, r);
      for (let c = 1; c < 16; c++) if (s.m[EVT + c] !== 0) events++;
    }
    expect(events / (2000 * 15)).toBeCloseTo(0.064, 1);
  });
});

describe('выбор орудий', () => {
  it('обновление выбора одно на забег', () => {
    const e = createEngine(P);
    const s = new State();
    e.start(s, new Rng(5));
    e.apply(s, { type: 'reroll' }, new Rng(6));
    expect(s.m[REROLLS]).toBe(0);
    expect(s.m[PHASE]).toBe(P_PICK);
    expect(e.legal(s)).not.toContainEqual({ type: 'reroll' });
    const pick = e.legal(s)[0]!;
    e.apply(s, pick, new Rng(6));
    expect(s.m[TOOLS]).not.toBe(0);
    expect(s.m[PHASE]).toBe(P_PATROL);
  });

  it('предлагаются только орудия, которых ещё нет', () => {
    const s = blank({ tools: TOOL_IDS.filter((t) => t !== 'keys' && t !== 'coin') });
    s.m[PICK_TOOLS] = 1;
    settle(s, new Rng(1), P);
    expect(s.m[PHASE]).toBe(P_PICK);
    expect(s.m[OFFER_KIND]).toBe(OFFER_TOOL);
    expect(s.m[OFFER_N]).toBe(2);
    const offered = [s.m[OFFER]!, s.m[OFFER + 1]!].sort((a, b) => a - b);
    expect(offered).toEqual([TOOL.keys, TOOL.coin].sort((a, b) => a - b));
  });
});

describe('утро: пункты назначения', () => {
  it('обычно 3 карточки, в 16,9 % — 2', () => {
    const s = blank();
    dealDoors(s, NO, P);
    expect(s.m[DOORS_N]).toBe(3);
    dealDoors(s, YES, P);
    expect(s.m[DOORS_N]).toBe(2);
    const r = new Rng(9);
    let twos = 0;
    for (let i = 0; i < 20000; i++) {
      dealDoors(s, r, P);
      if (s.m[DOORS_N] === 2) twos++;
    }
    expect(twos / 20000).toBeCloseTo(0.169, 1);
  });

  it('карточки — среди шагов 1–6, допросная тоже, шаги поровну', () => {
    const s = blank();
    s.m[WARDEN] = 13;
    const hits = new Array<number>(16).fill(0);
    const r = new Rng(10);
    for (let i = 0; i < 30000; i++) {
      dealDoors(s, r, P);
      const seen = new Set<number>();
      for (let k = 0; k < s.m[DOORS_N]!; k++) {
        const step = dist(13, s.m[DOORS + k]!);
        expect(step).toBeGreaterThanOrEqual(1);
        expect(step).toBeLessThanOrEqual(6);
        expect(seen.has(step)).toBe(false);
        seen.add(step);
        hits[step]!++;
      }
    }
    const mean = hits.slice(1, 7).reduce((a, b) => a + b) / 6;
    for (let k = 1; k <= 6; k++) expect(Math.abs(hits[k]! - mean) / mean).toBeLessThan(0.05);
    expect(hits[3]).toBeGreaterThan(0); // 13 + 3 = допросная
  });

  it('Поддельный ключ, Плеть и Столб убирают по карточке, но не меньше одной; без шанса «на одну меньше»', () => {
    const s = blank({ tools: ['forged'] });
    dealDoors(s, YES, P);
    expect(s.m[DOORS_N]).toBe(2);
    const t = blank({ tools: ['forged', 'whip', 'stake'] });
    dealDoors(t, YES, P);
    expect(t.m[DOORS_N]).toBe(1);
  });
});

describe('обход', () => {
  it('запертая камера назначения открывается, шаги считаются', () => {
    const s = blank();
    doorTo(s, 0, 3);
    act(s, { type: 'patrol', cell: 3 }, YES);
    expect(s.m[WARDEN]).toBe(3);
    expect(locked(s, 3)).toBe(false);
    expect(tier(s, 3)).toBe(0);
    expect(locked(s, 1)).toBe(true);
    expect(s.m[STAT_STEPS]).toBe(3);
    expect(s.m[PHASE]).toBe(P_MANAGE);
  });

  it('закреплённый узник выходит таким, каким был закреплён', () => {
    const s = blank();
    hide(s, 4, WOLF, 3);
    doorTo(s, 0, 4);
    act(s, { type: 'patrol', cell: 4 });
    expect([beast(s, 4), tier(s, 4)]).toEqual([WOLF, 3]);
  });

  it('событие за дверью: окно, пропуск убирает событие', () => {
    const s = blank();
    s.m[EVT + 2] = EVENT.freedom + 1;
    doorTo(s, 0, 2);
    act(s, { type: 'patrol', cell: 2 });
    expect(s.m[PHASE]).toBe(P_EVENT);
    expect(legal(s)).toEqual([{ type: 'event', accept: true }, { type: 'event', accept: false }]);
    act(s, { type: 'event', accept: false });
    expect(s.m[EVT + 2]).toBe(0);
    expect(s.m[STAT_EVENTS]).toBe(0);
    expect(s.m[PHASE]).toBe(P_MANAGE);
  });

  it('событие в открытой камере срабатывает при обходе в неё', () => {
    const s = blank();
    put(s, 5, LION, 1);
    s.m[EVT + 5] = EVENT.chain + 1;
    doorTo(s, 1, 5);
    act(s, { type: 'patrol', cell: 5 });
    expect(s.m[PHASE]).toBe(P_EVENT);
    act(s, { type: 'event', accept: true });
    expect(s.m[CHAIN_REACTION]).toBe(1);
    expect(s.m[STAT_EVENTS]).toBe(1);
  });
});

describe('допросная', () => {
  it('обход в допросную — выбор Наградить / Подстрекнуть, потом день кончается', () => {
    const s = blank();
    put(s, 9, RAT, 1);
    doorTo(s, 12, 0);
    act(s, { type: 'patrol', cell: 0 });
    expect(s.m[PHASE]).toBe(P_OFFICE);
    act(s, { type: 'office', choice: 'bestow' }, YES);
    expect(tier(s, 9)).toBe(2);
    expect(s.m[DAY]).toBe(1);
    expect(s.m[PHASE]).toBe(P_PATROL);
  });

  it('Подстрекнуть: одна запертая дверь без события получает событие (tlidb)', () => {
    const s = blank();
    s.m[EVT + 1] = EVENT.raven + 1;
    doorTo(s, 12, 0);
    act(s, { type: 'patrol', cell: 0 });
    act(s, { type: 'office', choice: 'instigate' }, YES);
    let n = 0;
    for (let c = 1; c < 16; c++) if (s.m[EVT + c] !== 0) n++;
    expect(n).toBe(2);
    expect(s.m[EVT + 1]).toBe(EVENT.raven + 1);
  });

  it('«Тирания»: ещё 3 выбора за визит', () => {
    const s = blank({ start: 'tyranny' });
    doorTo(s, 12, 0);
    act(s, { type: 'patrol', cell: 0 });
    for (let i = 0; i < 3; i++) {
      act(s, { type: 'office', choice: 'instigate' });
      expect(s.m[PHASE]).toBe(P_OFFICE);
    }
    act(s, { type: 'office', choice: 'instigate' });
    expect(s.m[PHASE]).toBe(P_PATROL);
  });
});

describe('кто кого ест', () => {
  it('первая еда той же редкости: мамонт → лев → волк → крыса → мамонт', () => {
    const s = blank();
    put(s, 1, MAMMOTH, 1);
    put(s, 2, LION, 1);
    put(s, 3, WOLF, 1);
    put(s, 4, RAT, 1);
    expect(canEat(s, 1, 2)).toBe(true);
    expect(canEat(s, 2, 3)).toBe(true);
    expect(canEat(s, 3, 4)).toBe(true);
    expect(canEat(s, 4, 1)).toBe(true);
    expect(canEat(s, 3, 1)).toBe(false);
    expect(canEat(s, 4, 2)).toBe(false);
    expect(canEat(s, 2, 1)).toBe(false);
  });

  it('ниже или выше по редкости есть нельзя', () => {
    const s = blank();
    put(s, 1, MAMMOTH, 2);
    put(s, 2, LION, 1);
    put(s, 3, LION, 3);
    expect(targets(s, 1)).toBe(0);
  });

  it('вторая еда на любой редкости (tlidb «Преимущество»): мамонт ест волка, лев — крысу', () => {
    const s = blank();
    put(s, 1, MAMMOTH, 0);
    put(s, 2, WOLF, 0);
    put(s, 3, LION, 2);
    put(s, 4, RAT, 2);
    put(s, 5, WOLF, 3);
    put(s, 6, MAMMOTH, 3);
    expect(canEat(s, 1, 2)).toBe(true);
    expect(canEat(s, 3, 4)).toBe(true);
    expect(canEat(s, 5, 6)).toBe(false); // у волка и крысы второй еды нет
  });

  it('Призматический никого не ест', () => {
    const s = blank();
    put(s, 1, MAMMOTH, 5);
    put(s, 2, LION, 5);
    expect(canEat(s, 1, 2)).toBe(false);
  });

  it('«Бой в клетке»: едят на любой редкости, зверь после укуса не меняется', () => {
    const s = blank({ start: 'cagefight' });
    put(s, 1, MAMMOTH, 1);
    put(s, 2, LION, 0);
    put(s, 3, LION, 3);
    expect(canEat(s, 1, 2)).toBe(true);
    expect(canEat(s, 1, 3)).toBe(true);
    bite(s, NO, P, 1, 2, false);
    expect(beast(s, 1)).toBe(MAMMOTH);
  });
});

describe('пожирание', () => {
  it('укус: съеденный уходит (камера запирается), едок +1, зверь меняется, день кончается', () => {
    const s = blank();
    put(s, 1, MAMMOTH, 1);
    put(s, 2, LION, 1);
    manageAt(s, 1);
    expect(legal(s)).toEqual([{ type: 'devour', to: 2 }, { type: 'swap' }, { type: 'end' }]);
    act(s, { type: 'devour', to: 2 });
    expect(locked(s, 2)).toBe(true);
    expect(tier(s, 2)).toBe(-1);
    expect(tier(s, 1)).toBe(2);
    expect(beast(s, 1)).toBe(RAT); // NO → последний зверь
    expect(s.m[DAY]).toBe(1);
    expect(s.m[USED]).toBe(0);
  });

  it('новый зверь едока — равновероятно из четырёх', () => {
    const counts = [0, 0, 0, 0];
    const r = new Rng(21);
    const s = blank();
    for (let i = 0; i < 8000; i++) {
      put(s, 1, MAMMOTH, 1);
      put(s, 2, LION, 1);
      bite(s, r, P, 1, 2, false);
      counts[beast(s, 1)]!++;
    }
    for (const c of counts) expect(c / 8000).toBeCloseTo(0.25, 1);
  });

  it('цепочка: пока у нового зверя есть цели, можно есть дальше или отменить', () => {
    const s = blank();
    put(s, 1, MAMMOTH, 1);
    put(s, 2, LION, 1);
    put(s, 3, MAMMOTH, 2); // после укуса едок станет Редкой крысой (NO)
    manageAt(s, 1);
    act(s, { type: 'devour', to: 2 });
    expect(s.m[PHASE]).toBe(P_CHAIN);
    expect(s.m[CHAIN_EATER]).toBe(1);
    expect(legal(s)).toEqual([{ type: 'chain', to: 3 }, { type: 'stopchain' }]);
    act(s, { type: 'stopchain' });
    expect(s.m[DAY]).toBe(1);
    expect(tier(s, 3)).toBe(2);
  });

  it('цепочка продолжается укусом', () => {
    const s = blank();
    put(s, 1, MAMMOTH, 1);
    put(s, 2, LION, 1);
    put(s, 3, MAMMOTH, 2);
    manageAt(s, 1);
    act(s, { type: 'devour', to: 2 });
    act(s, { type: 'chain', to: 3 });
    expect(tier(s, 1)).toBe(3);
    expect(locked(s, 3)).toBe(true);
    expect(s.m[STAT_BITES]).toBe(2);
    expect(s.m[DAY]).toBe(1);
  });

  it('Пожирание и Замена в один день исключают друг друга', () => {
    const s = blank();
    put(s, 1, MAMMOTH, 1);
    put(s, 2, LION, 1);
    put(s, 3, MAMMOTH, 2);
    manageAt(s, 1);
    act(s, { type: 'devour', to: 2 });
    expect(legal(s).some((a) => a.type === 'swap')).toBe(false);
  });

  it('«Закон джунглей» считает каждый укус', () => {
    const s = blank({ objective: OBJECTIVE.jungle });
    for (let i = 0; i < 4; i++) {
      put(s, 1, MAMMOTH, 1);
      put(s, 2, LION, 1);
      bite(s, NO, P, 1, 2, false);
    }
    expect(s.m[OBJ_DONE]).toBe(1);
    expect(s.m[PICK_TOOLS]).toBe(1);
    expect(s.m[OBJECTIVE_ID]).not.toBe(OBJECTIVE.jungle);
  });
});

describe('призматические и сокровищница', () => {
  it('Призматический уходит в хранилище, камера запирается, открывается сокровищница', () => {
    const s = blank();
    put(s, 4, LION, 4);
    raise(s, NO, P, 4, 1);
    expect(s.m[STORAGE]).toBe(1);
    expect(locked(s, 4)).toBe(true);
    expect(s.m[PICK_GIFTS]).toBe(1);
    settle(s, NO, P);
    expect(s.m[PHASE]).toBe(P_PICK);
    expect(s.m[OFFER_KIND]).toBe(OFFER_GIFT);
    expect(legal(s)).toEqual(['ring', 'horn', 'wine', 'brand'].map((id) => ({ type: 'choose', id })));
  });

  it('«Изобилие» — 3 подарка подряд', () => {
    const s = blank({ start: 'abundance' });
    put(s, 4, LION, 4);
    raise(s, NO, P, 4, 1);
    expect(s.m[PICK_GIFTS]).toBe(3);
  });

  it('при полном хранилище рост стоит на Величайшей', () => {
    const s = blank();
    s.m[STORAGE] = 10;
    put(s, 4, LION, 3);
    raise(s, NO, P, 4, 3);
    expect(tier(s, 4)).toBe(4);
    expect(s.m[STORAGE]).toBe(10);
  });

  it('подарок «Трёхглавое кольцо» открывает до 3 запертых камер', () => {
    const s = blank();
    takeGift(s, YES, P, 0);
    expect(inmates(s)).toBe(3);
  });

  it('подарок «Медный боевой рог»: каждый узник с целью кусает один раз', () => {
    const s = blank();
    put(s, 1, MAMMOTH, 1);
    put(s, 2, LION, 1);
    put(s, 3, WOLF, 1);
    takeGift(s, YES, P, 1);
    expect(s.m[STAT_BITES]).toBe(1);
    expect(tier(s, 1)).toBe(2);
    expect(locked(s, 2)).toBe(true);
    expect(s.m[USED]).toBe(0);
  });

  it('подарок «Багряное вино»: все ниже Легендарной +1', () => {
    const s = blank();
    put(s, 1, MAMMOTH, 0);
    put(s, 2, LION, 2);
    put(s, 3, WOLF, 3);
    takeGift(s, YES, P, 2);
    expect([tier(s, 1), tier(s, 2), tier(s, 3)]).toEqual([1, 3, 3]);
  });

  it('подарок «Клеймо первородного греха»: узники без еды меняют зверя, чтобы еда появилась', () => {
    const s = blank();
    put(s, 1, MAMMOTH, 0);
    put(s, 2, MAMMOTH, 0);
    takeGift(s, YES, P, 3);
    expect(beast(s, 1)).toBe(RAT);
    expect(targets(s, 1)).not.toBe(0);
    expect(beast(s, 2)).toBe(MAMMOTH); // любая смена оставила бы крысу без еды
  });
});

describe('замена', () => {
  it('узник меняется на нового, день кончается', () => {
    const s = blank();
    put(s, 1, LION, 2);
    manageAt(s, 1);
    act(s, { type: 'swap' }, YES);
    expect([beast(s, 1), tier(s, 1)]).toEqual([MAMMOTH, 0]);
    expect(s.m[DAY]).toBe(1);
  });

  it('редкость нового — по шансам замены', () => {
    const r = new Rng(31);
    const hits = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 40000; i++) hits[rollTier(r, P.replaceOdds, 0)]!++;
    P.replaceOdds.forEach((q, t) => expect(hits[t]! / 40000).toBeCloseTo(q, 2));
  });
});

describe('двери', () => {
  it('кто за дверью — по шансам двери', () => {
    const s = blank();
    const r = new Rng(41);
    const hits = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 40000; i++) {
      openCell(s, r, P, 5);
      hits[tier(s, 5)]!++;
      relock(s, r, P, 5);
    }
    const sum = P.doorOdds.reduce((a, b) => a + b);
    P.doorOdds.forEach((q, t) => expect(hits[t]! / 40000).toBeCloseTo(q / sum, 2));
  });
});

describe('события', () => {
  it('Цепная реакция: следующий обход открывает запертые камеры на пути, их события не срабатывают', () => {
    const s = blank();
    s.m[EVT + 2] = EVENT.freedom + 1;
    runEvent(s, NO, P, 1, EVENT.chain);
    doorTo(s, 0, 4);
    act(s, { type: 'patrol', cell: 4 });
    for (const c of [1, 2, 3, 4]) expect(locked(s, c)).toBe(false);
    expect(s.m[EVT + 2]).toBe(EVENT.freedom + 1);
    expect(s.m[PHASE]).toBe(P_MANAGE);
    expect(s.m[CHAIN_REACTION]).toBe(0);
  });

  it('Казнь: палач убирает свою первую еду ниже своей редкости, +1 за жертву', () => {
    const s = blank();
    put(s, 1, MAMMOTH, 2);
    put(s, 2, LION, 0);
    put(s, 3, LION, 1);
    put(s, 4, LION, 2);
    put(s, 5, WOLF, 0);
    runEvent(s, NO, P, 1, EVENT.execution);
    expect(tier(s, 1)).toBe(4);
    expect(locked(s, 2) && locked(s, 3)).toBe(true);
    expect(tier(s, 4)).toBe(2);
    expect(tier(s, 5)).toBe(0);
  });

  it('Закулисные махинации: Величайший, дефицитное кодовое имя', () => {
    const s = blank();
    put(s, 1, RAT, 0);
    put(s, 2, MAMMOTH, 1);
    put(s, 3, MAMMOTH, 1);
    put(s, 4, WOLF, 1);
    put(s, 5, RAT, 1);
    put(s, 6, WOLF, 1);
    put(s, 7, RAT, 1);
    runEvent(s, YES, P, 1, EVENT.behind);
    expect([beast(s, 1), tier(s, 1)]).toEqual([LION, 4]);
  });

  it('Зверский аппетит: случайный узник самой низкой редкости, 5 попыток +1', () => {
    const s = blank();
    put(s, 1, MAMMOTH, 2);
    put(s, 2, LION, 0);
    put(s, 3, WOLF, 0);
    runEvent(s, new Seq([0, 0, 0.9]), P, 1, EVENT.appetite);
    expect([tier(s, 1), tier(s, 2), tier(s, 3)]).toEqual([2, 1, 0]);
  });

  it('Каторжник: запертая камера открывается с Легендарным или Величайшим', () => {
    const s = blank();
    runEvent(s, YES, P, 5, EVENT.convict);
    expect(tier(s, 1)).toBe(3);
    const t = blank();
    runEvent(t, NO, P, 5, EVENT.convict);
    expect(tier(t, 15)).toBe(4);
  });

  it('Шёпот ворона: следующие 4 запертые камеры показывают редкость', () => {
    const s = blank();
    s.m[WARDEN] = 5;
    put(s, 5, LION, 1);
    put(s, 7, LION, 1);
    runEvent(s, NO, P, 5, EVENT.raven);
    for (const c of [6, 8, 9, 10]) {
      expect(s.m[FLAGS + c]! & F_VIS_TIER).toBeTruthy();
      expect(s.m[PRE_TIER + c]).toBeGreaterThanOrEqual(0);
    }
    expect(s.m[FLAGS + 11]).toBe(0);
  });

  it('Вкус свободы: открываются 3 случайные запертые камеры', () => {
    const s = blank();
    runEvent(s, new Rng(3), P, 0, EVENT.freedom);
    expect(inmates(s)).toBe(3);
  });

  it('Узурпация: случайный узник растёт на 1/2/3/4, следующая ступень — за случайной дверью', () => {
    const s = blank();
    put(s, 3, WOLF, 1);
    put(s, 5, RAT, 0);
    runEvent(s, YES, P, 5, EVENT.usurp1);
    expect([tier(s, 3), tier(s, 5)]).toEqual([2, 0]); // не узник события, а случайный
    expect(s.m[EVT + 1]).toBe(EVENT.usurp2 + 1);
    runEvent(s, YES, P, 5, EVENT.usurp2);
    expect(tier(s, 3)).toBe(4);
    runEvent(s, YES, P, 3, EVENT.usurp4);
    let n = 0;
    for (let c = 1; c < 16; c++) if (s.m[EVT + c] !== 0) n++;
    expect(n).toBe(2); // ступени II и III от I и II; IV новой не ставит
  });

  it('Заклятый враг: открывается камера с едой текущего узника его редкости', () => {
    const s = blank();
    put(s, 3, WOLF, 2);
    runEvent(s, YES, P, 3, EVENT.rival);
    expect([beast(s, 1), tier(s, 1)]).toEqual([RAT, 2]);
    expect(canEat(s, 3, 1)).toBe(true);
  });

  it('Делим удачу: +1 за каждого другого узника с тем же кодовым именем', () => {
    const s = blank();
    put(s, 3, WOLF, 0);
    put(s, 5, WOLF, 2);
    put(s, 7, WOLF, 1);
    put(s, 9, RAT, 0);
    runEvent(s, YES, P, 3, EVENT.luck);
    expect(tier(s, 3)).toBe(2);
  });

  it('Этапирование сообщников: копия узника в случайной неоткрытой камере', () => {
    const s = blank();
    put(s, 3, LION, 2);
    runEvent(s, YES, P, 3, EVENT.escort);
    expect([beast(s, 1), tier(s, 1)]).toEqual([LION, 2]);
    expect(locked(s, 1)).toBe(false);
  });

  it('Добавка: до 3 случайных узников +1', () => {
    const s = blank();
    put(s, 3, LION, 0);
    put(s, 5, WOLF, 0);
    runEvent(s, YES, P, 3, EVENT.extra);
    expect([tier(s, 3), tier(s, 5)]).toEqual([1, 1]);
    const t = blank();
    for (let c = 2; c <= 6; c++) put(t, c, RAT, 0);
    runEvent(t, YES, P, 2, EVENT.extra);
    let up = 0;
    for (let c = 2; c <= 6; c++) up += tier(t, c);
    expect(up).toBe(3);
  });

  it('Закулисные махинации: дефицитное кодовое имя считает и самого узника', () => {
    const s = blank();
    put(s, 3, RAT, 1);
    put(s, 5, MAMMOTH, 0);
    put(s, 6, LION, 0);
    put(s, 7, WOLF, 0);
    runEvent(s, YES, P, 3, EVENT.behind);
    // все звери по одному (крыса — сам узник): выбор из всех четырёх, YES берёт первого
    expect([beast(s, 3), tier(s, 3)]).toEqual([MAMMOTH, 4]);
  });

  it('Крысиная тропа: переход в любую камеру, кроме допросной, без шагов', () => {
    const s = blank();
    put(s, 2, LION, 1);
    s.m[EVT + 2] = EVENT.ratway + 1;
    doorTo(s, 0, 2);
    act(s, { type: 'patrol', cell: 2 });
    act(s, { type: 'event', accept: true });
    expect(s.m[PHASE]).toBe(P_RATWAY);
    const moves = legal(s);
    expect(moves).toHaveLength(14);
    expect(moves).not.toContainEqual({ type: 'patrol', cell: 0 });
    expect(moves).not.toContainEqual({ type: 'patrol', cell: 2 });
    act(s, { type: 'patrol', cell: 11 }, YES);
    expect(s.m[WARDEN]).toBe(11);
    expect(locked(s, 11)).toBe(false);
    expect(s.m[STAT_STEPS]).toBe(2);
    expect(s.m[PHASE]).toBe(P_MANAGE);
  });

  it('Поиск «сокровищ»: Обычные и Магические разведаны, остальные — «не ниже Редкой»', () => {
    const s = blank();
    runEvent(s, new Rng(8), P, 0, EVENT.treasure);
    for (let c = 1; c < 16; c++) {
      const t = s.m[PRE_TIER + c]!;
      const f = s.m[FLAGS + c]!;
      expect(t).toBeGreaterThanOrEqual(0);
      if (t <= 1) expect(f & F_VIS_TIER).toBeTruthy();
      else expect(f & F_VIS_RARE).toBeTruthy();
    }
  });

  it('принятое событие засчитывается для «Подводных течений»', () => {
    const s = blank({ objective: OBJECTIVE.currents });
    for (let i = 0; i < 2; i++) {
      put(s, 3, WOLF, 0);
      s.m[WARDEN] = 3;
      s.m[EVT + 3] = EVENT.chain + 1;
      eventDecision(s, NO, P, true);
    }
    expect(s.m[OBJ_DONE]).toBe(1);
  });
});

describe('цели', () => {
  it('Загнанный зверь-царь: узник достиг Величайшей → выбор орудия', () => {
    const s = blank({ objective: OBJECTIVE.apex });
    put(s, 2, RAT, 3);
    raise(s, NO, P, 2, 1);
    expect(s.m[OBJ_DONE]).toBe(1);
    settle(s, NO, P);
    expect(s.m[PHASE]).toBe(P_PICK);
    expect(s.m[OFFER_KIND]).toBe(OFFER_TOOL);
  });

  it('За дверью камеры: 10 открытых камер', () => {
    const s = blank({ objective: OBJECTIVE.doors });
    for (let c = 1; c <= 9; c++) openCell(s, YES, P, c);
    expect(s.m[OBJ_PROGRESS]).toBe(9);
    openCell(s, YES, P, 10);
    expect(s.m[OBJ_DONE]).toBe(1);
  });

  it('Прогулка по тюрьме: 18 клеток', () => {
    const s = blank({ objective: OBJECTIVE.walk });
    for (let i = 0; i < 3; i++) {
      doorTo(s, s.m[WARDEN]!, (s.m[WARDEN]! + 6) & 15);
      act(s, { type: 'patrol', cell: s.m[DOORS]! });
    }
    expect(s.m[OBJ_DONE]).toBe(1);
  });

  it('без повтора целей после выполнения цели нет', () => {
    const p = { ...P, objectiveRepeat: false };
    const s = blank({ objective: OBJECTIVE.apex, params: p });
    put(s, 2, RAT, 3);
    raise(s, NO, p, 2, 1);
    expect(s.m[OBJECTIVE_ID]).toBe(-1);
  });
});

describe('конец забега', () => {
  it('после последнего дня забег окончен', () => {
    const s = blank();
    s.m[NEXT] = P_MORNING;
    settle(s, NO, P);
    let guard = 0;
    while (s.m[PHASE] !== 8 && guard++ < 1000) {
      const moves = legal(s);
      const end = moves.find((a) => a.type === 'end');
      act(s, end ?? moves[0]!);
    }
    expect(s.m[PHASE]).toBe(8);
    expect(s.m[DAY]).toBe(20);
    expect(legal(s)).toEqual([]);
  });

  it('код хода туда-обратно', () => {
    const all = [
      { type: 'patrol', cell: 7 }, { type: 'devour', to: 3 }, { type: 'chain', to: 15 }, { type: 'stopchain' },
      { type: 'swap' }, { type: 'end' }, { type: 'hunt', to: 4 }, { type: 'office', choice: 'bestow' },
      { type: 'office', choice: 'instigate' }, { type: 'event', accept: true }, { type: 'event', accept: false },
      { type: 'choose', id: 'trap' }, { type: 'choose', id: 'forged' }, { type: 'choose', id: 'brand' },
      { type: 'reroll' },
    ] as const;
    for (const a of all) expect(decode(encode(a))).toEqual(a);
  });

  it('нелегальный ход — ошибка', () => {
    const s = blank();
    settle(s, NO, P);
    expect(() => act(s, { type: 'swap' })).toThrow();
    expect(() => act(s, { type: 'patrol', cell: 9 })).toThrow();
  });
});
