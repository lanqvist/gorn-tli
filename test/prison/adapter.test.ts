import { describe, expect, it } from 'vitest';

import { EVENT, LION, MAMMOTH, OBJECTIVE, START_EVENT, TOOL, WOLF } from '../../src/core/prison/model.js';
import { PrisonAdapter, blankMemory, loadMemory } from '../../src/core/prison/adapter.js';
import { codeBuffer, decode, encode, legalCodes } from '../../src/core/prison/engine/actions.js';
import {
  BEAST, CHAIN_EATER, DAY, DAY_LIMIT, DOORS, DOORS_N, EVT, FLAGS, F_VIS_TIER, LOCK, NEST, NEXT, OBJECTIVE_ID, OFFER, OFFER_GIFT,
  OFFER_KIND, OFFER_N, PHASE, PICK_GIFTS, PRE_TIER, P_CHAIN, P_DAYEND, P_MANAGE, P_PATROL, P_PICK, REROLLS, START, STORAGE,
  TIER, TOOLS, WARDEN, type State,
} from '../../src/core/prison/engine/state.js';
import { C, MANAGE_ALL, board, pick } from './view-helpers.js';

function legal(s: State) {
  const buf = codeBuffer();
  const n = legalCodes(s, buf);
  return Array.from(buf.subarray(0, n));
}

function ok(a: PrisonAdapter) {
  const pos = a.position();
  if (!pos.ok) throw new Error(pos.problem);
  return pos;
}

describe('адаптер: память забега', () => {
  it('испорченное сохранение — чистый забег; память переживает JSON', () => {
    expect(loadMemory(null)).toEqual(blankMemory());
    expect(loadMemory({ v: 2 })).toEqual(blankMemory());
    const a = new PrisonAdapter();
    a.board(board({ inmates: { 3: 'wolf2' }, warden: 3, daysLeft: 15, doors: [5, 7], tools: ['keys'], chromatic: 2, objective: 'jungle' }));
    const b = new PrisonAdapter(JSON.parse(JSON.stringify(a.mem)));
    expect(b.mem).toEqual(a.mem);
  });

  it('доска: день по «осталось дней», орудия копятся, хранилище, цель с панели', () => {
    const a = new PrisonAdapter();
    a.board(board({ warden: 4, daysLeft: 14, doors: [6, 8], tools: ['keys'], chromatic: 3, objective: 'beastking' }));
    a.board(board({ warden: 4, daysLeft: 14, doors: [6, 8], tools: ['coin'], chromatic: 3 }));
    // «Осталось 14» из 20 — день номер 6 с единицы, с нуля 5.
    expect(a.mem.day).toBe(5);
    expect(a.mem.tools).toEqual(['keys', 'coin']);
    const s = ok(a).state;
    expect(s.m[PHASE]).toBe(P_PATROL);
    expect(s.m[DAY]).toBe(5);
    expect(s.m[STORAGE]).toBe(3);
    expect(s.m[OBJECTIVE_ID]).toBe(OBJECTIVE.apex);
    expect(s.m[TOOLS]).toBe((1 << TOOL.keys) | (1 << TOOL.coin));
    expect(s.m[WARDEN]).toBe(C(4));
    expect([s.m[DOORS_N], s.m[DOORS], s.m[DOORS + 1]]).toEqual([2, C(6), C(8)]);
  });

  it('больше 20 дней осталось — «Железный закон», 30 дней', () => {
    const a = new PrisonAdapter();
    a.board(board({ daysLeft: 27, doors: [3] }));
    expect(a.mem.dayLimit).toBe(30);
    expect(a.mem.start).toBe('ironlaw');
    const s = ok(a).state;
    expect(s.m[DAY_LIMIT]).toBe(30);
    expect(s.m[DAY]).toBe(2);
    expect(s.m[START]).toBe(START_EVENT.ironlaw);
  });

  it('камеры: узники, «!», показанная редкость — закреплена и видна', () => {
    const a = new PrisonAdapter();
    a.board(board({ inmates: { 2: 'lion3' }, events: [5, 2], shown: { 9: 2 }, doors: [2] }));
    const s = ok(a).state;
    expect([s.m[BEAST + C(2)], s.m[TIER + C(2)], s.m[LOCK + C(2)]]).toEqual([LION, 3, 0]);
    expect(s.m[EVT + C(5)]).toBeGreaterThan(0);
    expect(s.m[EVT + C(2)]).toBeGreaterThan(0);
    expect(s.m[LOCK + C(5)]).toBe(1);
    expect(s.m[PRE_TIER + C(9)]).toBe(2);
    expect(s.m[FLAGS + C(9)]! & F_VIS_TIER).toBeTruthy();
    expect(s.m[TIER + C(9)]).toBe(-1);
    void EVENT;
  });

  it('ряд решений: ход, которого нет на экране, не советуется', () => {
    const a = new PrisonAdapter();
    a.board(board({ inmates: { 4: 'mammoth1', 6: 'lion1' }, warden: 4, decision: { kind: 'manage', consume: true, replace: false, end: true }, kinds: ['consume', 'end'] }));
    const pos = ok(a);
    expect(pos.state.m[PHASE]).toBe(P_MANAGE);
    const moves = legal(pos.state).filter(pos.allowed).map(decode);
    expect(moves).toContainEqual({ type: 'devour', to: C(6) });
    expect(moves).toContainEqual({ type: 'end' });
    expect(moves).not.toContainEqual({ type: 'swap' });
  });
});

describe('адаптер: выбор орудий', () => {
  it('выбор в начале забега: чистая доска, карты и «Обновить»', () => {
    const a = new PrisonAdapter();
    a.board(board({ inmates: { 3: 'wolf4' }, doors: [3], chromatic: 4, tools: ['keys'] }));
    a.pick(pick(['crown', 'saw', null]), true, false);
    expect(a.mem.tools).toEqual([]);
    expect(a.mem.storage).toBe(0);
    const s = ok(a).state;
    expect(s.m[PHASE]).toBe(P_PICK);
    expect([s.m[OFFER_N], s.m[OFFER], s.m[OFFER + 1]]).toEqual([2, TOOL.crown, TOOL.saw]);
    expect(s.m[REROLLS]).toBe(1);
    expect(legal(s).map(decode)).toContainEqual({ type: 'reroll' });
  });

  it('после «Обновить» обновлений нет; награда за цель не сбрасывает забег', () => {
    const a = new PrisonAdapter();
    a.board(board({ inmates: { 3: 'wolf4' }, doors: [3], tools: ['keys'] }));
    a.pick(pick(['crown', 'saw', 'keys'], true, true), false, true);
    expect(a.mem.tools).toEqual(['keys']);
    expect(a.mem.offer).toEqual(['crown', 'saw']);
    const s = ok(a).state;
    expect(s.m[REROLLS]).toBe(0);
    expect(s.m[TIER + C(3)]).toBe(4);
  });
});

describe('адаптер: цепочка', () => {
  /** Ряд решений у мамонта №4, лев №6 той же редкости. */
  function manageThenChain(): PrisonAdapter {
    const a = new PrisonAdapter();
    a.board(board({ inmates: { 4: 'mammoth1', 6: 'lion1', 9: 'lion2' }, warden: 4, decision: MANAGE_ALL, kinds: ['consume', 'replace', 'end'] }));
    return a;
  }

  it('экран выбора цели до первого укуса — ещё выбор Пожирания: «Отменить» не завершает день', () => {
    const a = manageThenChain();
    a.board(board({ inmates: { 4: 'mammoth1', 6: 'lion1', 9: 'lion2' }, warden: 4, daysLeft: null, chain: [6] }));
    expect(a.mem.step).toBe('chain');
    expect(a.mem.firstBite).toBe(true);
    const pos = ok(a);
    expect(pos.state.m[PHASE]).toBe(P_MANAGE);
    const moves = legal(pos.state).filter(pos.allowed).map(decode);
    expect(moves).toContainEqual({ type: 'devour', to: C(6) });
    expect(moves).toContainEqual({ type: 'swap' });
  });

  it('после укуса: съеденный заперт, едок вырос — цепочка', () => {
    const a = manageThenChain();
    // Мамонт съел льва №6, стал Редким волком и может съесть... крысу; подсвечена №12.
    a.board(board({ inmates: { 4: 'wolf2', 9: 'lion2', 12: 'rat2' }, warden: 4, daysLeft: null, chain: [12] }));
    expect(a.mem.firstBite).toBe(false);
    expect(a.mem.cells[C(6)]!.k).toBe('locked');
    const s = ok(a).state;
    expect(s.m[PHASE]).toBe(P_CHAIN);
    expect(s.m[CHAIN_EATER]).toBe(C(4));
    expect(legal(s).map(decode)).toEqual([{ type: 'chain', to: C(12) }, { type: 'stopchain' }]);
  });

  it('портрет едока прочитан не тем зверем — берётся тот, кто ест подсвеченных', () => {
    const a = manageThenChain();
    // Экран прочитал льва, но подсвечен лев №6 (лев льва не ест) — едок мамонт.
    a.board(board({ inmates: { 4: 'lion1', 6: 'lion1', 9: 'lion2' }, warden: 4, daysLeft: null, chain: [6] }));
    expect(a.mem.cells[C(4)]!.b).toBe(MAMMOTH);
    expect(ok(a).state.m[BEAST + C(4)]).toBe(MAMMOTH);
  });

  it('модель не объясняет подсвеченные цели — совет по самой редкой из них', () => {
    const a = new PrisonAdapter();
    // Цели другой редкости, чем едок: правило меняет орудие, которого модель не знает.
    a.board(board({ inmates: { 4: 'wolf1', 7: 'mammoth0', 9: 'lion3' }, warden: 4, daysLeft: null, chain: [7, 9] }));
    const pos = a.position();
    expect(pos.ok).toBe(false);
    if (!pos.ok) expect(pos.fallback).toEqual({ type: 'chain', to: C(9) });
  });
});

describe('адаптер: сокровищница', () => {
  it('после Замены узник ушёл в хранилище; совет ждёт доску за окном', () => {
    const a = new PrisonAdapter();
    a.board(board({ inmates: { 5: 'wolf4', 7: 'rat2' }, warden: 5, chromatic: 1, decision: MANAGE_ALL, kinds: ['consume', 'replace', 'end'] }));
    a.treasure('swap');
    expect(a.mem.cells[C(5)]!.k).toBe('locked');
    expect(a.mem.storage).toBe(2);
    expect(a.position().ok).toBe(false);
    a.treasure('view');
    const s = ok(a).state;
    expect(s.m[PHASE]).toBe(P_PICK);
    expect(s.m[OFFER_KIND]).toBe(OFFER_GIFT);
    expect(s.m[OFFER_N]).toBe(4);
    expect(s.m[PICK_GIFTS]).toBe(1);
    expect(legal(s).map(decode).map((x) => (x.type === 'choose' ? x.id : x.type))).toEqual(['ring', 'horn', 'wine', 'brand']);
  });

  it('«Изобилие» — три подарка подряд', () => {
    const a = new PrisonAdapter({ ...blankMemory(), start: 'abundance' });
    a.treasure('consume');
    a.treasure('view');
    expect(ok(a).state.m[PICK_GIFTS]).toBe(3);
  });

  it('ход из позиции движка применим (коды сходятся)', () => {
    const a = new PrisonAdapter();
    a.board(board({ inmates: { 4: 'mammoth1', 6: 'lion1' }, warden: 4, decision: MANAGE_ALL, kinds: ['consume', 'replace', 'end'] }));
    const pos = ok(a);
    for (const c of legal(pos.state)) expect(encode(decode(c))).toBe(c);
    void WOLF;
  });
});

describe('адаптер: куда вернуться после выбора, сроки', () => {
  it('награда за цель после обхода — к ряду решений; подарок после Замены — к концу дня; после Пожирания — к цепочке', () => {
    const a = new PrisonAdapter();
    a.board(board({ inmates: { 4: 'mammoth1', 6: 'lion1' }, warden: 2, doors: [4] }));
    a.pick(pick(['crown', 'saw', 'hook'], false, true), false, false);
    expect(ok(a).state.m[NEXT]).toBe(P_MANAGE);

    const b = new PrisonAdapter();
    b.board(board({ inmates: { 4: 'mammoth4', 6: 'lion1' }, warden: 4, decision: MANAGE_ALL, kinds: ['consume', 'replace', 'end'] }));
    b.treasure('swap');
    b.treasure('view');
    expect(ok(b).state.m[NEXT]).toBe(P_DAYEND);

    const c = new PrisonAdapter();
    c.board(board({ inmates: { 4: 'mammoth3', 6: 'lion3' }, warden: 4, decision: MANAGE_ALL, kinds: ['consume', 'replace', 'end'] }));
    c.treasure('consume');
    c.treasure('view');
    const s = ok(c).state;
    expect(s.m[NEXT]).toBe(P_CHAIN);
    expect(s.m[CHAIN_EATER]).toBe(C(4));
  });

  it('гнездо: срок считается от дня, когда его увидели', () => {
    const a = new PrisonAdapter();
    const nest = (daysLeft: number) => {
      const b = board({ daysLeft, doors: [3] });
      b.cells[C(9)]!.nest = true;
      return b;
    };
    a.board(nest(15));
    expect(ok(a).state.m[NEST + C(9)]).toBe(2);
    a.board(nest(14));
    expect(ok(a).state.m[NEST + C(9)]).toBe(1);
  });
});

describe('адаптер: орудия из выбора и день из лога', () => {
  it('выбор → доска с неузнанной иконкой: взято посоветованное («предположительно»), панель подтверждает', () => {
    const a = new PrisonAdapter();
    a.pick(pick(['maiden', 'forged', 'guillotine']), true, false);
    a.advised('maiden');
    const b = board({ warden: 1, doors: [3] });
    b.toolSlots = [null];
    a.board(b);
    expect(a.mem.tools).toEqual(['maiden']);
    expect(a.mem.assumed).toEqual([{ tool: 'maiden', offer: ['maiden', 'forged', 'guillotine'] }]);
    expect(ok(a).state.m[TOOLS]).toBe(1 << TOOL.maiden);
    // Панель узнала иконку — «предположительно» снято.
    const c = board({ warden: 1, doors: [3], tools: ['maiden'] });
    c.toolSlots = ['maiden'];
    a.board(c);
    expect(a.mem.tools).toEqual(['maiden']);
    expect(a.mem.assumed).toEqual([]);
  });

  it('панель узнала другое орудие из того же выбора — «предположительное» исправляется', () => {
    const a = new PrisonAdapter();
    a.pick(pick(['maiden', 'forged', 'guillotine']), true, false);
    a.advised('forged');
    const b = board({ warden: 1, doors: [3] });
    b.toolSlots = [null];
    a.board(b);
    expect(a.mem.tools).toEqual(['forged']);
    const c = board({ warden: 1, doors: [3], tools: ['guillotine'] });
    c.toolSlots = ['guillotine'];
    a.board(c);
    expect(a.mem.tools).toEqual(['guillotine']);
    expect(a.mem.assumed).toEqual([]);
  });

  it('экран цепочки (панели не видно) выбор не закрывает — ждёт доску с панелью', () => {
    const a = new PrisonAdapter();
    a.board(board({ inmates: { 4: 'mammoth1', 6: 'lion1' }, warden: 4, decision: MANAGE_ALL, kinds: ['consume', 'replace', 'end'], tools: ['coin'] }));
    a.pick(pick(['revenge', 'hook', 'scales'], true, true), false, false);
    a.advised('revenge');
    a.board(board({ inmates: { 4: 'mammoth1', 6: 'lion1' }, warden: 4, daysLeft: null, chain: [6] }));
    expect(a.mem.tools).toEqual(['coin']);
    const b = board({ warden: 4, doors: [6], tools: ['coin'] });
    b.toolSlots = ['coin', null];
    a.board(b);
    expect(a.mem.tools).toEqual(['coin', 'revenge']);
  });

  it('день по логу — главный источник: последний день при нечитаемом «осталось 0»', () => {
    const a = new PrisonAdapter();
    a.logDay({ cur: 20, max: 20 });
    a.board(board({ warden: 4, daysLeft: null, doors: [6] }));
    expect([a.mem.day, a.mem.dayLimit]).toEqual([19, 20]);
    // Экран говорит другое — верим логу.
    a.logDay({ cur: 5, max: 20 });
    a.board(board({ warden: 4, daysLeft: 3, doors: [6] }));
    expect(a.mem.day).toBe(4);
    // Без строки лога — запасной источник, экран.
    a.logDay(null);
    a.board(board({ warden: 4, daysLeft: 3, doors: [6] }));
    expect(a.mem.day).toBe(16);
    // 30 дней — «Железный закон».
    const b = new PrisonAdapter();
    b.logDay({ cur: 0, max: 30 });
    expect([b.mem.day, b.mem.dayLimit, b.mem.start]).toEqual([0, 30, 'ironlaw']);
  });
});
