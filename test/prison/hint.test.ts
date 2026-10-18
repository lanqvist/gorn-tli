import { describe, expect, it } from 'vitest';

import { hint, itemName } from '../../src/core/prison/hint.js';
import { C, MANAGE_ALL, board, cellAt, pick } from './view-helpers.js';

describe('метки подсказки', () => {
  it('обход: стрелка от надзирателя к камере, кольцо, рамка на карточке двери', () => {
    const b = board({ warden: 4, doors: [6, 8, 9] });
    const h = hint({ type: 'patrol', cell: C(8) }, { board: b, warden: C(4) });
    expect(h.text).toBe('Иди в №8');
    const from = cellAt(C(4));
    const to = cellAt(C(8));
    expect(h.marks).toEqual([
      { kind: 'arrow', from: [from.x, from.y], to: [to.x, to.y] },
      { kind: 'ring', at: [to.x, to.y], r: to.r },
      { kind: 'box', box: b.at.doorCards[1] },
    ]);
  });

  it('допросная и «Крысиная тропа»', () => {
    const b = board({ warden: 14, doors: [1] });
    expect(hint({ type: 'patrol', cell: 0 }, { board: b, warden: C(14) }).text).toBe('Иди в допросную');
    expect(hint({ type: 'patrol', cell: C(5) }, { board: b, warden: C(14), ratway: true }).text).toBe('Выбери №5');
  });

  it('пожирание: рамка на «Пожирании» по виду карточки, стрелка к еде', () => {
    const b = board({ warden: 4, decision: { kind: 'manage', consume: true, replace: false, end: true }, kinds: ['consume', 'end'] });
    const h = hint({ type: 'devour', to: C(6) }, { board: b, warden: C(4) });
    expect(h.text).toBe('Пожирание: съесть №6');
    expect(h.marks[0]).toEqual({ kind: 'box', box: b.at.decisionCards[0] });
    expect(h.marks.map((m) => m.kind)).toEqual(['box', 'arrow', 'ring']);
    const end = hint({ type: 'end' }, { board: b, warden: C(4) });
    expect(end.marks).toEqual([{ kind: 'box', box: b.at.decisionCards[1] }]);
  });

  it('без видов карточек — порядок игры (Пожирание, Замена, Завершить)', () => {
    const b = board({ warden: 4, decision: MANAGE_ALL, kinds: ['consume', 'replace', 'end'] });
    delete b.at.decisionKinds;
    const h = hint({ type: 'swap' }, { board: b, warden: C(4) });
    expect(h.text).toBe('Заменить');
    const w = cellAt(C(4));
    expect(h.marks).toEqual([{ kind: 'box', box: b.at.decisionCards[1] }, { kind: 'ring', at: [w.x, w.y], r: w.r }]);
  });

  it('ряд из одной карточки «Завершить» — рамка на ней', () => {
    const b = board({ warden: 16, decision: { kind: 'manage', consume: false, replace: false, end: true }, kinds: ['end'] });
    expect(hint({ type: 'end' }, { board: b, warden: C(16) })).toEqual({ text: 'Завершить день', marks: [{ kind: 'box', box: b.at.decisionCards[0] }] });
  });

  it('допросная: Наградить и Подстрекнуть', () => {
    const b = board({ warden: 1, decision: { kind: 'office' }, kinds: ['instigate', 'bestow'] });
    expect(hint({ type: 'office', choice: 'bestow' }, { board: b, warden: 0 })).toEqual({ text: 'Наградить', marks: [{ kind: 'box', box: b.at.decisionCards[1] }] });
    expect(hint({ type: 'office', choice: 'instigate' }, { board: b, warden: 0 }).marks[0]).toEqual({ kind: 'box', box: b.at.decisionCards[0] });
  });

  it('цепочка: съесть, «Отменить» — рамка на кнопке', () => {
    const b = board({ warden: 4, daysLeft: null, chain: [9] });
    const h = hint({ type: 'chain', to: C(9) }, { board: b, warden: C(4) });
    expect(h.text).toBe('Цепочка: съесть №9');
    expect(h.marks.map((m) => m.kind)).toEqual(['arrow', 'ring']);
    expect(hint({ type: 'stopchain' }, { board: b, warden: C(4) })).toEqual({ text: 'Остановить цепочку (Отменить)', marks: [{ kind: 'box', box: b.at.cancel }] });
  });

  it('до первого укуса Замена и конец дня — через «Отменить»', () => {
    const b = board({ warden: 4, daysLeft: null, chain: [9] });
    expect(hint({ type: 'swap' }, { board: b, warden: C(4), cancelFirst: true })).toEqual({ text: 'Отменить, затем «Заменить»', marks: [{ kind: 'box', box: b.at.cancel }] });
    expect(hint({ type: 'end' }, { board: b, warden: C(4), cancelFirst: true }).text).toBe('Отменить, затем «Завершить день»');
  });

  it('выбор орудия: рамка на карте; «Обновить»; подарок — по месту в окне', () => {
    const p = pick(['saw', 'crown', null]);
    expect(hint({ type: 'choose', id: 'crown' }, { pick: p, warden: null })).toEqual({ text: 'Взять: Железная корона короля тюрьмы', marks: [{ kind: 'box', box: p.boxes[1] }] });
    expect(hint({ type: 'reroll' }, { pick: p, reroll: [680, 935, 900, 985], warden: null })).toEqual({ text: 'Обновить выбор', marks: [{ kind: 'box', box: [680, 935, 900, 985] }] });
    const gifts: [number, number, number, number][] = [[0, 0, 1, 1], [2, 2, 3, 3], [4, 4, 5, 5], [6, 6, 7, 7]];
    expect(hint({ type: 'choose', id: 'wine' }, { gifts, warden: null })).toEqual({ text: 'Взять: Багряное вино', marks: [{ kind: 'box', box: [4, 4, 5, 5] }] });
    expect(itemName('skewer')).toBe('Шампур крысиных голов');
  });

  it('причина — если подпись остаётся короткой', () => {
    const b = board({ warden: 4, doors: [6] });
    expect(hint({ type: 'patrol', cell: C(6) }, { board: b, warden: C(4), reason: 'новый узник' }).text).toBe('Иди в №6 · новый узник');
    expect(hint({ type: 'patrol', cell: C(6) }, { board: b, warden: C(4), reason: 'x'.repeat(60) }).text).toBe('Иди в №6');
  });

  it('без распознанной доски — только текст', () => {
    expect(hint({ type: 'devour', to: 3 }, { warden: 1 })).toEqual({ text: 'Пожирание: съесть №4', marks: [] });
  });
});
