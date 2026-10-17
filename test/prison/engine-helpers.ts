/** Общие заготовки для тестов движка тюрьмы. */

import { DEFAULT_PARAMS, START_EVENT, TOOL, type Params, type StartEventId, type ToolId } from '../../src/core/prison/model.js';
import { settle } from '../../src/core/prison/engine/actions.js';
import { Rng } from '../../src/core/prison/engine/rng.js';
import { newRun } from '../../src/core/prison/engine/rules.js';
import {
  BEAST, LOCK, NEXT, PRE_BEAST, PRE_TIER, P_MANAGE, P_PATROL, State, TIER, WARDEN,
} from '../../src/core/prison/engine/state.js';

/** Параметры тестов: без случайных событий за дверями. */
/** Изолированные сценарии: без открытых в начале камер и без меток событий. */
export const P: Params = { ...DEFAULT_PARAMS, doorEvent: 0, relockEvent: 0, startOpen: 0, eventMin: 0 };

/** ГСЧ, который всегда возвращает одно и то же число из [0, 1). */
export class Fixed extends Rng {
  constructor(private readonly v: number) {
    super(1);
  }
  override next(): number {
    return Math.floor(this.v * 4294967296) >>> 0;
  }
}

/** ГСЧ по списку чисел из [0, 1); после конца списка повторяет последнее. */
export class Seq extends Rng {
  private i = 0;
  constructor(private readonly vs: number[]) {
    super(1);
  }
  override next(): number {
    const v = this.vs[Math.min(this.i++, this.vs.length - 1)]!;
    return Math.floor(v * 4294967296) >>> 0;
  }
}

/** Всегда «да» по шансам и первый вариант при выборе. */
export const YES = new Fixed(0);
/** Всегда «нет» по шансам и последний вариант при выборе. */
export const NO = new Fixed(0.9999999);

/** Пустой забег: все двери заперты, надзиратель в допросной, ход — выбор двери. */
export function blank(opts: { tools?: ToolId[]; start?: StartEventId; objective?: number; params?: Params } = {}): State {
  const s = new State();
  let tools = 0;
  for (const t of opts.tools ?? []) tools |= 1 << TOOL[t];
  newRun(s, new Rng(7), opts.params ?? P, {
    start: START_EVENT[opts.start ?? 'none'],
    objective: opts.objective ?? -1,
    tools,
    startPick: false,
  });
  s.m[NEXT] = P_PATROL;
  return s;
}

/** Посадить узника (камера открывается). */
export function put(s: State, c: number, beast: number, tier: number): void {
  s.m[LOCK + c] = 0;
  s.m[BEAST + c] = beast;
  s.m[TIER + c] = tier;
}

/** Закрепить узника за запертой дверью. */
export function hide(s: State, c: number, beast: number, tier: number): void {
  s.m[PRE_TIER + c] = tier;
  s.m[PRE_BEAST + c] = beast;
}

/** Поставить надзирателя в камеру и открыть ряд решений. */
export function manageAt(s: State, c: number, r: Rng = NO, p: Params = P): void {
  s.m[WARDEN] = c;
  s.m[NEXT] = P_MANAGE;
  settle(s, r, p);
}

export function tier(s: State, c: number): number {
  return s.m[TIER + c]!;
}

export function beast(s: State, c: number): number {
  return s.m[BEAST + c]!;
}

export function locked(s: State, c: number): boolean {
  return s.m[LOCK + c] === 1;
}

/** Сколько открытых камер с узниками. */
export function inmates(s: State): number {
  let n = 0;
  for (let c = 1; c < 16; c++) if (s.m[TIER + c]! >= 0) n++;
  return n;
}
