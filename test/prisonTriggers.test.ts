import { describe, expect, it } from 'vitest';

import { PrisonTriggers, stampMs, type PrisonShot, type Scheduler } from '../src/core/prisonTriggers.js';

const L = (time: string, body: string) => `[2026.10.17-${time}:000][ 1]TLLua: Display: [Game] ${body}`;

/** Ручной таймер: запоминает отложенные вызовы, run() выполняет их. */
function manual(): Scheduler & { run(): number[]; pending: number } {
  let next = 1;
  const jobs = new Map<number, { fn: () => void; ms: number }>();
  return {
    set(fn, ms) {
      const id = next++;
      jobs.set(id, { fn, ms });
      return id;
    },
    clear(h) {
      jobs.delete(h as number);
    },
    get pending() {
      return jobs.size;
    },
    run() {
      const delays = [...jobs.values()].map((j) => j.ms);
      const all = [...jobs.values()];
      jobs.clear();
      for (const j of all) j.fn();
      return delays;
    },
  };
}

function setup() {
  const shots: PrisonShot[] = [];
  const timer = manual();
  const t = new PrisonTriggers((s) => shots.push(s), timer);
  return { shots, timer, t };
}

describe('триггеры тюрьмы', () => {
  it('метка времени строки', () => {
    expect(stampMs(L('19.23.01', 'x'))).toBe(Date.UTC(2026, 9, 17, 19, 23, 1, 0));
    expect(stampMs('без метки')).toBeNull();
  });

  it('строки без S16 не трогают ничего', () => {
    const { t, timer } = setup();
    t.feed([L('19.00.00', 'BagMgr@:Modfy BagItem PageId = 102 SlotId = 0 ConfigBaseId = 100300 Num = 6655')]);
    expect(timer.pending).toBe(0);
  });

  it('пачка строк — один кадр со старшим видом и самой долгой задержкой', () => {
    const { t, timer, shots } = setup();
    t.feed([L('19.00.00', 'UI_S16_Card_Up'), L('19.00.00', 'S16BoardTaskPop Run')]);
    expect(timer.pending).toBe(1);
    expect(timer.run()).toEqual([1500]);
    expect(shots).toHaveLength(1);
    expect(shots[0]!.kind).toBe('objective');
  });

  it('выбор орудий с днём 0 — новый забег', () => {
    const { t, timer, shots } = setup();
    t.feed([L('19.00.00', '[S16LastDay] check cur=0 max=20'), L('19.00.00', 'S16BoardRelicPop Run')]);
    timer.run();
    expect(shots[0]).toMatchObject({ kind: 'instruments', fresh: true });
  });

  it('баннер нового дня отменяет ждущий кадр', () => {
    const { t, timer, shots } = setup();
    t.feed([L('19.00.00', 'Btn_S16Board_ActionCell'), L('19.00.01', 'S16BoardNewDayPop Run')]);
    expect(timer.pending).toBe(0);
    timer.run();
    expect(shots).toHaveLength(0);
  });

  it('ускорение сокращает задержку, но не меньше 250 мс', () => {
    const { t, timer } = setup();
    t.feed([L('19.00.00', 'Btn_S16Board_Top_Speed')]);
    expect(t.speedUp).toBe(true);
    t.feed([L('19.00.01', 'UI_S16_Click_Eat')]);
    expect(timer.run()).toEqual([2500 * 0.45]);
    t.feed([L('19.00.02', 'S16BoardColoredPop Destory')]);
    expect(timer.run()).toEqual([270]);
  });

  it('сокровищница после замены и после пожирания', () => {
    const a = setup();
    a.t.feed([L('19.00.00', 'Btn_S16Board_ActionCell'), L('19.00.02', 'S16BoardColoredPop Run')]);
    a.timer.run();
    expect(a.shots[0]).toMatchObject({ kind: 'treasure', after: 'swap' });

    const b = setup();
    b.t.feed([L('19.00.00', 'Btn_S16Board_ActionCell'), L('19.00.01', 'Eating_red_screen'), L('19.00.03', 'S16BoardColoredPop Run')]);
    b.timer.run();
    expect(b.shots[0]).toMatchObject({ kind: 'treasure', after: 'consume' });
  });

  it('доска сразу за сокровищницей снимается отдельно; просмотр без выбора подарка', () => {
    const { t, timer, shots } = setup();
    t.feed([L('19.00.00', 'S16BoardColoredPop Run'), L('19.00.01', 'S16BoardColoredPop Destory')]);
    expect(shots.map((s) => s.kind)).toEqual(['treasure']);
    timer.run();
    expect(shots[1]).toMatchObject({ kind: 'board', treasureView: true });
  });

  it('доска после выбранного подарка — не просмотр', () => {
    const { t, timer, shots } = setup();
    t.feed([L('19.00.00', 'Btn_S16Board_ColoredPop_Confirm'), L('19.00.01', 'S16BoardColoredPop Destory')]);
    timer.run();
    expect(shots[0]).toMatchObject({ kind: 'board', treasureView: false });
  });
});
