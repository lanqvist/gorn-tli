import { beforeEach, describe, expect, it } from 'vitest';

import type { Frame, Geometry } from '../../src/core/prison/recognize/types.js';
import { clearSolveCache } from '../../src/core/prison/solver/solve.js';
import type { ScreenView } from '../../src/core/prison/view.js';
import { OwnAdvisor } from '../../src/main/prison/ownAdvisor.js';
import type { PrisonShotMessage, PrisonWorkerReply } from '../../src/main/prison/protocol.js';
import { C, MANAGE_ALL, board, pick } from './view-helpers.js';

const GEO: Geometry = { width: 1920, height: 1080, s: 1, tx: 0, ty: 0, score: 1 };
const FRAME: Frame = { width: 1920, height: 1080, data: new Uint8ClampedArray(4) };

/** Поток подсказок с подменённым распознаванием: следующий кадр «видит» screen. */
function setup() {
  const replies: PrisonWorkerReply[] = [];
  let screen: ScreenView = { screen: 'other' };
  const own = new OwnAdvisor((m) => replies.push(m), {
    sleep: () => Promise.resolve(),
    quickMs: 2000,
    read: () => ({ view: screen, geo: GEO }),
  });
  own.init(null, null);
  let id = 0;
  const shot = async (view: ScreenView | null, over: Partial<PrisonShotMessage> = {}) => {
    if (view) screen = view;
    replies.length = 0;
    const msg: PrisonShotMessage = {
      type: 'shot', id: ++id, kind: 'board', fresh: false, after: '', treasureView: false, rerolled: false,
      treasureClosed: false, asTreasure: false, width: 1920, height: 1080, buffer: new ArrayBuffer(0), format: 'rgba',
      budgetMs: 2000, savePath: null, ...over,
    };
    await own.handle(msg, view ? FRAME : null);
    return replies.filter((r) => r.type === 'hint' || r.type === 'clear' || r.type === 'settled');
  };
  return { own, replies, shot };
}

const text = (rs: PrisonWorkerReply[]) => rs.filter((r) => r.type === 'hint').map((r) => (r.type === 'hint' ? r.text : ''));

beforeEach(() => clearSolveCache());

describe('свой путь подсказок', () => {
  it('выбор орудий → доска с дверями → ряд решений: проверенный совет одним показом', async () => {
    const { shot, replies } = setup();
    let rs = await shot({ screen: 'pick', pick: pick(['crown', 'saw', 'hook']) }, { kind: 'instruments', fresh: true });
    expect(rs).toHaveLength(1);
    expect(rs[0]!.type === 'hint' && rs[0]!.phase).toBe('final');
    expect(text(rs)[0]).toMatch(/^(Взять: |Обновить выбор)/);
    expect(replies.some((r) => r.type === 'near')).toBe(true);

    rs = await shot({ screen: 'board', board: board({ warden: 1, daysLeft: 20, doors: [3, 5, 6], tools: ['crown'] }) });
    expect(rs).toHaveLength(1);
    expect(text(rs)[0]).toMatch(/^Иди в №[356]/);

    rs = await shot({ screen: 'board', board: board({ inmates: { 5: 'mammoth4', 9: 'lion4' }, warden: 5, decision: MANAGE_ALL, kinds: ['consume', 'replace', 'end'], tools: ['crown'] }) });
    expect(text(rs)).toEqual(['Пожирание: съесть №9']);
    const h = rs[0]!;
    expect(h.type === 'hint' && h.marks.map((m) => m.kind)).toEqual(['box', 'arrow', 'ring']);
  });

  it('переходная доска без карточек — не совет', async () => {
    const { shot } = setup();
    const rs = await shot({ screen: 'board', board: board({ warden: 3 }) });
    expect(rs).toEqual([{ type: 'clear', id: 1 }]);
  });

  it('сокровищница: без доски за окном — просьба показать доску; с просмотром — совет по подарку', async () => {
    const { shot, own } = setup();
    await shot({ screen: 'board', board: board({ inmates: { 5: 'wolf4', 9: 'rat4' }, warden: 5, decision: MANAGE_ALL, kinds: ['consume', 'replace', 'end'] }) });
    let rs = await shot(null, { kind: 'treasure', after: 'consume' });
    expect(text(rs)[0]).toMatch(/Посмотреть состояние тюрьмы/);
    // Просмотр доски из сокровищницы: совет текстом (карточек подарков не видно).
    // (триггеры ставят ему и treasureClosed: окно закрыто кнопкой просмотра).
    rs = await shot({ screen: 'board', board: board({ inmates: { 9: 'rat4' }, warden: 5, chromatic: 1 }) }, { treasureView: true, treasureClosed: true });
    expect(text(rs)[0]).toMatch(/^Взять: /);
    expect(rs[0]!.type === 'hint' && rs[0]!.marks).toEqual([]);
    // Вернулся в окно: совет с рамкой на месте подарка.
    rs = await shot(null, { kind: 'treasure', after: '' });
    expect(text(rs)[0]).toMatch(/^Взять: /);
    expect(rs[0]!.type === 'hint' && rs[0]!.marks.map((m) => m.kind)).toEqual(['box']);
    void own;
  });

  it('доска после подарка — запомнить; следующее окно «Изобилия» — сразу совет с рамкой', async () => {
    const { shot } = setup();
    await shot({ screen: 'board', board: board({ inmates: { 5: 'wolf4', 9: 'rat4', 11: 'lion2' }, warden: 5, decision: MANAGE_ALL, kinds: ['consume', 'replace', 'end'] }) });
    let rs = await shot({ screen: 'board', board: board({ inmates: { 9: 'rat4', 11: 'lion2' }, warden: 5, chromatic: 1 }) }, { treasureClosed: true });
    expect(rs).toEqual([{ type: 'clear', id: 2 }]);
    rs = await shot(null, { kind: 'treasure', after: '' });
    expect(text(rs)[0]).toMatch(/^Взять: /);
    const h = rs[0]!;
    expect(h.type === 'hint' && h.marks).toHaveLength(1);
    expect(h.type === 'hint' && h.marks[0]!.kind).toBe('box');
  });

  it('цепочка, которую модель не объясняет, — совет по подсвеченной цели', async () => {
    const { shot } = setup();
    const rs = await shot({ screen: 'board', board: board({ inmates: { 4: 'wolf1', 7: 'mammoth0', 9: 'lion3' }, warden: 4, daysLeft: null, chain: [7, 9] }) });
    expect(text(rs)).toEqual(['Цепочка: съесть №9']);
  });

  it('неузнанная карта не глушит совет; две неузнанные — не совет', async () => {
    const { shot } = setup();
    let rs = await shot({ screen: 'pick', pick: pick(['crown', null, 'saw']) }, { kind: 'instruments', fresh: true });
    expect(text(rs)[0]).toMatch(/одну карту не узнал|^Взять|^Обновить/);
    rs = await shot({ screen: 'pick', pick: pick(['crown', null, null]) }, { kind: 'instruments', fresh: true });
    expect(rs).toEqual([{ type: 'clear', id: 2 }]);
  });

  it('память и геометрия переживают перезапуск', async () => {
    const { shot, replies } = setup();
    await shot({ screen: 'board', board: board({ warden: 2, daysLeft: 12, doors: [4], tools: ['keys', 'coin'], chromatic: 2 }) });
    const state = [...replies].reverse().find((r) => r.type === 'state');
    expect(state && state.type === 'state').toBe(true);
    const again = new OwnAdvisor(() => undefined);
    again.init(state!.type === 'state' ? JSON.parse(JSON.stringify(state!.model)) : null, GEO);
    expect(again.memory).toMatchObject({ tools: ['keys', 'coin'], storage: 2, day: 8, warden: C(2) });
  });
});
