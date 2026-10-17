/**
 * Выбор событий и орудий по таблицам клиента (client-tables.ts).
 *
 * Веса проверяются детерминированно: ГСЧ, который возвращает середины
 * равных отрезков, проходит по сетке из суммы весов, и каждый вариант
 * должен выпасть ровно столько раз, каков его вес.
 */
import { describe, expect, it } from 'vitest';

import { EVENT, EVENT_IDS, LION, OBJECTIVE, TOOL, TOOL_IDS, WOLF, type EventId, type ToolId } from '../../src/core/prison/model.js';
import { eventWeight, makeOffer, office, raise, runEvent, setObjective, toolWeight } from '../../src/core/prison/engine/rules.js';
import { EVT, OFFER, OFFER_N, PICK_TOOLS, TOOLS, USURP, type State } from '../../src/core/prison/engine/state.js';
import { Fixed, P, blank, put } from './engine-helpers.js';

const own = (s: State, ...tools: ToolId[]) => {
  for (const t of tools) s.m[TOOLS] = s.m[TOOLS]! | (1 << TOOL[t]);
};

/** Доска, где событие можно поставить только в камеру 5. */
function onlyCell5(opened: boolean, ...tools: ToolId[]): State {
  const s = blank();
  own(s, ...tools);
  for (let c = 1; c < 16; c++) if (c !== 5) s.m[EVT + c] = EVENT.raven + 1;
  if (opened) put(s, 5, WOLF, 0);
  return s;
}

/** Сколько раз выпало каждое событие при «Подстрекнуть» на сетке из total точек. */
function instigateGrid(opened: boolean, total: number, ...tools: ToolId[]): Partial<Record<EventId, number>> {
  const out: Partial<Record<EventId, number>> = {};
  for (let k = 0; k < total; k++) {
    const s = onlyCell5(opened, ...tools);
    office(s, new Fixed((k + 0.5) / total), P, true);
    const id = EVENT_IDS[s.m[EVT + 5]! - 1]!;
    out[id] = (out[id] ?? 0) + 1;
  }
  return out;
}

describe('события: веса и ограничения клиента (event 201–255)', () => {
  it('запертая камера: только any и unopened, доли — базовые веса', () => {
    expect(instigateGrid(false, 190)).toEqual({
      chain: 20, behind: 40, convict: 40, raven: 10, freedom: 40, ratway: 20, treasure: 10, usurp1: 10,
    });
  });

  it('открытая камера: только any и opened', () => {
    expect(instigateGrid(true, 220)).toEqual({
      chain: 20, execution: 20, appetite: 30, raven: 10, ratway: 20, treasure: 10, rival: 30, luck: 20,
      escort: 20, extra: 30, usurp1: 10,
    });
  });

  it('202 «Вкус свободы» не выпадает при орудии 101 (ExcludeRelic)', () => {
    const grid = instigateGrid(false, 150, 'muzzle');
    expect(grid.freedom).toBeUndefined();
    expect(Object.values(grid).reduce((a, b) => a + b, 0)).toBe(150);
    const s = onlyCell5(false, 'muzzle');
    expect(eventWeight(s, P, EVENT.freedom, 5)).toBe(0);
  });

  it('Узурпация: в пуле одна текущая ступень; нулевой базовый вес II–IV не обрывает цепочку', () => {
    const s = onlyCell5(false);
    const w = (ev: number) => eventWeight(s, P, ev, 5);
    expect([w(EVENT.usurp1), w(EVENT.usurp2), w(EVENT.usurp3), w(EVENT.usurp4)]).toEqual([10, 0, 0, 0]);
    put(s, 7, LION, 0);
    runEvent(s, new Fixed(0), P, 7, EVENT.usurp1);
    expect(s.m[USURP]).toBe(EVENT.usurp2);
    expect([w(EVENT.usurp1), w(EVENT.usurp2)]).toEqual([0, P.usurpNextWeight]);
    runEvent(s, new Fixed(0), P, 7, EVENT.usurp2);
    runEvent(s, new Fixed(0), P, 7, EVENT.usurp3);
    expect(w(EVENT.usurp4)).toBe(P.usurpNextWeight);
    runEvent(s, new Fixed(0), P, 7, EVENT.usurp4);
    expect(s.m[USURP]).toBe(-1);
    expect([w(EVENT.usurp1), w(EVENT.usurp2), w(EVENT.usurp3), w(EVENT.usurp4)]).toEqual([0, 0, 0, 0]);
  });
});

describe('орудия: веса и исключения клиента (relic 101–148)', () => {
  it('без орудий: обычные 40, особые 5; первая карта выпадает по весам', () => {
    const s = blank();
    const total = TOOL_IDS.reduce((a, _, t) => a + toolWeight(s, t), 0);
    expect(total).toBe(23 * 40 + 8 * 5);
    const first: Record<string, number> = {};
    for (let k = 0; k < total; k++) {
      const t = blank();
      t.m[PICK_TOOLS] = 1;
      makeOffer(t, new Fixed((k + 0.5) / total));
      const id = TOOL_IDS[t.m[OFFER]!]!;
      first[id] = (first[id] ?? 0) + 1;
    }
    for (const id of TOOL_IDS) expect(first[id]).toBe(toolWeight(s, TOOL[id]));
  });

  it('в выборе 3 разных орудия, имеющихся нет', () => {
    const s = blank();
    own(s, 'saw', 'whip');
    s.m[PICK_TOOLS] = 1;
    makeOffer(s, new Fixed(0.37));
    const offered = [s.m[OFFER]!, s.m[OFFER + 1]!, s.m[OFFER + 2]!];
    expect(s.m[OFFER_N]).toBe(3);
    expect(new Set(offered).size).toBe(3);
    expect(offered).not.toContain(TOOL.saw);
    expect(offered).not.toContain(TOOL.whip);
  });

  it('особые орудия: с орудием одного зверя выпадает только его пара', () => {
    const s = blank();
    own(s, 'crown');
    expect(toolWeight(s, TOOL.trap)).toBe(5);
    for (const t of ['tongs', 'maul', 'claws', 'guillotine', 'ironbox', 'skewer'] as const) expect(toolWeight(s, TOOL[t])).toBe(0);
    expect(toolWeight(s, TOOL.crown)).toBe(0); // MaxObtain 1
    expect(toolWeight(s, TOOL.saw)).toBe(40);
  });

  it('пул исчерпан: выбор не предлагается', () => {
    const s = blank();
    own(s, ...TOOL_IDS.filter((t) => t !== 'maul' && t !== 'trap' && t !== 'crown' && t !== 'claws' &&
      t !== 'guillotine' && t !== 'ironbox' && t !== 'skewer'));
    s.m[PICK_TOOLS] = 1;
    expect(makeOffer(s, new Fixed(0))).toBe(true);
    expect([s.m[OFFER_N], s.m[OFFER]]).toEqual([1, TOOL.maul]); // при Клещах осталась только пара слона
    own(s, 'maul');
    expect(makeOffer(s, new Fixed(0))).toBe(false);
    expect(s.m[PICK_TOOLS]).toBe(0);
  });
});

describe('цели (task 1–5)', () => {
  it('task 1: ProgressParam 205 — редкость Red (Величайшая), а не число узников', () => {
    const s = blank();
    setObjective(s, new Fixed(0), P, OBJECTIVE.apex);
    put(s, 3, WOLF, 3);
    put(s, 5, LION, 3);
    expect(s.m[PICK_TOOLS]).toBe(0); // двое Легендарных — не цель
    raise(s, new Fixed(0), P, 3, 1);
    expect(s.m[PICK_TOOLS]).toBe(1); // один Величайший — цель выполнена
  });
});
