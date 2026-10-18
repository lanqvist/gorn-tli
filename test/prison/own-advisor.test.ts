import { beforeEach, describe, expect, it } from 'vitest';

import type { Frame, Geometry } from '../../src/core/prison/recognize/types.js';
import { clearSolveCache } from '../../src/core/prison/solver/solve.js';
import type { ScreenView } from '../../src/core/prison/view.js';
import { PrisonTriggers, type PrisonShot } from '../../src/core/prisonTriggers.js';
import { PrisonAdapter } from '../../src/core/prison/adapter.js';
import { START_EVENT } from '../../src/core/prison/model.js';
import { PICK_GIFTS, START } from '../../src/core/prison/engine/state.js';
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
    // Под vitest решатель в разы медленнее: в тестах — дорешать до остановки.
    quickMs: 600_000,
    stop: { minRounds: 32, pruneFrom: 16, maxRounds: 120 },
    read: () => ({ view: screen, geo: GEO }),
  });
  own.init(null, null);
  let id = 0;
  const shot = async (view: ScreenView | null, over: Partial<PrisonShotMessage> = {}) => {
    if (view) screen = view;
    replies.length = 0;
    const msg: PrisonShotMessage = {
      type: 'shot', id: ++id, kind: 'board', fresh: false, after: '', treasureView: false, rerolled: false,
      treasureClosed: false, asTreasure: false, theme: null, day: null, width: 1920, height: 1080, buffer: new ArrayBuffer(0), format: 'rgba',
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

    rs = await shot({ screen: 'board', board: board({ warden: 1, daysLeft: 20, doors: [3, 5, 6], tools: ['crown'], objective: 'jungle' }) });
    expect(rs).toHaveLength(1);
    expect(text(rs)[0]).toMatch(/^Иди в №[356]/);

    // Цель «Закон джунглей» — Пожирание заметно лучше (на 3000 раундах 7,10 против 6,91 у «Завершить»):
    // без неё ходы почти равны, и на 120 раундах теста совет решали кости.
    rs = await shot({ screen: 'board', board: board({ inmates: { 5: 'mammoth4', 9: 'lion4' }, warden: 5, decision: MANAGE_ALL, kinds: ['consume', 'replace', 'end'], tools: ['crown'], objective: 'jungle' }) });
    expect(text(rs)).toEqual(['Пожирание: съесть №9']);
    const h = rs[0]!;
    expect(h.type === 'hint' && h.marks.map((m) => m.kind)).toEqual(['box', 'arrow', 'ring']);
  });

  it('ряд решений → выбор цели того же Пожирания: показанная цель не прыгает', async () => {
    const { shot } = setup();
    // Две равные цели: львы той же редкости в №8 и №11; с «Законом джунглей» Пожирание
    // заметно лучше конца дня (3,49 против 3,29 на 3000 раундах).
    const inmates = { 5: 'mammoth3', 8: 'lion3', 11: 'lion3' };
    const rs1 = await shot({ screen: 'board', board: board({ inmates, warden: 5, decision: MANAGE_ALL, kinds: ['consume', 'replace', 'end'], objective: 'jungle' }) });
    const first = text(rs1).at(-1)!;
    expect(first).toMatch(/^Пожирание: съесть №(8|11)$/);
    const target = first.match(/№(\d+)/)![1];
    // Следующий кадр — экран выбора цели (до первого укуса): та же позиция, тот же ход.
    for (let i = 0; i < 3; i++) {
      const rs2 = await shot({ screen: 'board', board: board({ inmates, warden: 5, daysLeft: null, chain: [8, 11], objective: 'jungle' }) });
      expect(text(rs2).at(-1)).toBe(`Пожирание: съесть №${target}`);
    }
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
    // Орудия без выбора — со второго кадра подряд.
    await shot({ screen: 'board', board: board({ warden: 2, daysLeft: 12, doors: [4], tools: ['keys', 'coin'], chromatic: 2 }) });
    await shot({ screen: 'board', board: board({ warden: 2, daysLeft: 12, doors: [4], tools: ['keys', 'coin'], chromatic: 2 }) });
    const state = [...replies].reverse().find((r) => r.type === 'state');
    expect(state && state.type === 'state').toBe(true);
    const again = new OwnAdvisor(() => undefined);
    again.init(state!.type === 'state' ? JSON.parse(JSON.stringify(state!.model)) : null, GEO);
    expect(again.memory).toMatchObject({ tools: ['keys', 'coin'], storage: 2, day: 7, warden: C(2) });
  });
});

describe('свой путь: флаги кадров от PrisonTriggers, как в живом потоке', () => {
  it('«Изобилие»: просмотр доски из окна, затем подарки подряд — каждый раз сразу совет с рамкой', async () => {
    const { shot } = setup();
    const L = (t: string, body: string) => `[2026.10.17-21.48.${t}:000][ 1]TLLua: Display: [Game] ${body}`;
    // Ручной таймер: отложенные кадры триггеров выполняются по run().
    const jobs: (() => void)[] = [];
    const shots: PrisonShot[] = [];
    const triggers = new PrisonTriggers((s) => shots.push(s), { set: (fn) => jobs.push(fn), clear: () => undefined });
    const feed = (...lines: string[]) => {
      triggers.feed(lines);
      const run = jobs.splice(0);
      for (const j of run) j();
    };
    const boardBefore = board({ inmates: { 5: 'wolf4', 9: 'rat4', 11: 'lion2' }, warden: 5, decision: MANAGE_ALL, kinds: ['consume', 'replace', 'end'] });
    const boardAfter = board({ inmates: { 11: 'lion2' }, warden: 5, chromatic: 1 });
    const send = async (s: PrisonShot, view: ScreenView | null) => shot(s.kind === 'treasure' ? null : view, { kind: s.kind, after: s.after, treasureView: s.treasureView, treasureClosed: s.treasureClosed, fresh: s.fresh });

    await shot({ screen: 'board', board: boardBefore });
    // Пожирание → окно подарков: доски за ним ещё не видели — просьба показать.
    feed(L('00', 'UIButton@ normal-click Btn_S16Board_ActionCell'), L('01', 'Eating_red_screen S16'), L('02', 'S16BoardColoredPop Run'));
    expect(shots.at(-1)).toMatchObject({ kind: 'treasure', after: 'consume' });
    expect(text(await send(shots.at(-1)!, null))[0]).toMatch(/Посмотреть состояние тюрьмы/);
    // «Посмотреть состояние тюрьмы»: окно закрыто без подарка — просмотр доски.
    feed(L('05', 'S16BoardColoredPop Destory'));
    expect(shots.at(-1)).toMatchObject({ kind: 'board', treasureView: true, treasureClosed: true });
    let rs = await send(shots.at(-1)!, { screen: 'board', board: boardAfter });
    expect(text(rs)[0]).toMatch(/^Взять: /);
    // Три окна подряд, между ними доска после взятого подарка.
    for (let i = 0; i < 3; i++) {
      const t = String(10 + i * 10);
      feed(L(t, 'S16BoardColoredPop Run'));
      expect(shots.at(-1)).toMatchObject({ kind: 'treasure' });
      rs = await send(shots.at(-1)!, null);
      expect(text(rs)[0], `окно ${i + 1}`).toMatch(/^Взять: /);
      expect(rs[0]!.type === 'hint' && rs[0]!.marks.map((m) => m.kind)).toEqual(['box']);
      feed(L(String(10 + i * 10 + 3), 'UIButton@ normal-click Btn_S16Board_ColoredPop_Confirm'), L(String(10 + i * 10 + 4), 'S16BoardColoredPop Destory'));
      expect(shots.at(-1)).toMatchObject({ kind: 'board', treasureView: false, treasureClosed: true });
      expect(await send(shots.at(-1)!, { screen: 'board', board: boardAfter })).toEqual([{ type: 'clear', id: expect.any(Number) }]);
    }
  });
});

describe('свой путь: тема забега', () => {
  it('строки лога → кадр темы → тема в памяти → START в позиции', async () => {
    const { shot, own } = setup();
    const L = (t: string, body: string) => `[2026.10.18-09.22.${t}:000][ 1]TLLua: Display: [Game] ${body}`;
    const jobs: (() => void)[] = [];
    const shots: PrisonShot[] = [];
    const triggers = new PrisonTriggers((s) => shots.push(s), { set: (fn) => jobs.push(fn), clear: () => undefined });
    triggers.feed([
      L('18', 'S16BoardThemePop Run'),
      `[2026.10.18-09.22.18:010][ 1]LogDataTable: Warning: UDataTable::FindRow : 'Play_VO_Story_S16_Special_01_Lilim' requested row`,
    ]);
    for (const j of jobs.splice(0)) j();
    const s = shots.at(-1)!;
    expect(s).toMatchObject({ kind: 'theme', theme: 1 });
    expect(await shot(null, { kind: s.kind, theme: s.theme })).toEqual([{ type: 'clear', id: 1 }]);
    expect(own.memory).toMatchObject({ start: 'tyranny' });
    // Выбор орудий нового забега тему не сбрасывает; доска — тоже.
    await shot({ screen: 'pick', pick: pick(['crown', 'saw', 'hook']) }, { kind: 'instruments', fresh: true });
    await shot({ screen: 'board', board: board({ warden: 1, daysLeft: 19, doors: [3, 5, 6], tools: ['crown'] }) });
    expect(own.memory).toMatchObject({ start: 'tyranny' });
    const a = new PrisonAdapter(own.memory);
    const pos = a.position();
    expect(pos.ok && pos.state.m[START]).toBe(START_EVENT.tyranny);
    // Следующий забег без окна темы — темы нет.
    await shot({ screen: 'pick', pick: pick(['crown', 'saw', 'hook']) }, { kind: 'instruments', fresh: true });
    expect(own.memory).toMatchObject({ start: 'none' });
  });

  it('неизвестный номер озвучки — тему не выдумываем', async () => {
    const { shot, own } = setup();
    await shot(null, { kind: 'theme', theme: 7 });
    expect(own.memory).toMatchObject({ start: 'none' });
    await shot(null, { kind: 'theme', theme: null });
    expect(own.memory).toMatchObject({ start: 'none' });
  });

  it('«Расточительность» — три подарка, «Железный закон» — 30 дней', async () => {
    const a = new PrisonAdapter();
    a.theme(2);
    a.treasure('consume');
    a.treasure('view');
    const pos = a.position();
    expect(pos.ok && pos.state.m[PICK_GIFTS]).toBe(3);
    const b = new PrisonAdapter();
    b.theme(3);
    expect(b.mem.dayLimit).toBe(30);
  });
});

