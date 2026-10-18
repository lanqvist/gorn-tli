/**
 * Состояние забега в одном Int32Array: копия — один set(), без аллокаций.
 *
 * Поля камер — по 16 подряд, обращение m[TIER + c]. Камера 0 — допросная.
 * Незапертая камера без узника — TIER = −1. За запертой дверью узник не
 * выбран, пока дверь не откроют, если его не «закрепило» орудие или
 * событие (PRE_TIER ≥ 0): тогда он уже известен движку, а что из этого
 * видит игрок — флаги VIS_*.
 */

import { CELLS } from '../model.js';

// ── поля камер (по CELLS штук) ──────────────────────────────────────────────

/** Зверь 0…3, −1 — нет узника. */
export const BEAST = 0;
/** Редкость 0…4, −1 — нет узника. */
export const TIER = BEAST + CELLS;
/** 1 — заперта. */
export const LOCK = TIER + CELLS;
/** Событие в камере: номер EVENT + 1, 0 — нет. */
export const EVT = LOCK + CELLS;
/** Гнездо «Железного ящика»: сколько утр до вылупления, 0 — нет гнезда. */
export const NEST = EVT + CELLS;
/** Флаги камеры: F_*. */
export const FLAGS = NEST + CELLS;
/** Закреплённый узник за запертой дверью: редкость, −1 — не выбран. */
export const PRE_TIER = FLAGS + CELLS;
/** Закреплённый узник: зверь. */
export const PRE_BEAST = PRE_TIER + CELLS;

/** Игрок видит редкость за дверью. */
export const F_VIS_TIER = 1;
/** Игрок видит зверя за дверью. */
export const F_VIS_BEAST = 2;
/** Игрок видит «не ниже Редкой». */
export const F_VIS_RARE = 4;
/** Метка «бивень» (Щипцы). */
export const F_TUSK = 8;
/** Царапина (Когти): волк ест сквозь дверь. */
export const F_SCRATCH = 16;

// ── скаляры ─────────────────────────────────────────────────────────────────

const S0 = PRE_BEAST + CELLS;
/** Камера надзирателя. */
export const WARDEN = S0;
/** Прошло дней (0 — первый день). */
export const DAY = S0 + 1;
export const DAY_LIMIT = S0 + 2;
/** Фаза, в которой ждём ход игрока: P_*. */
export const PHASE = S0 + 3;
/** Куда вернуться после выборов (орудие, подарок). */
export const NEXT = S0 + 4;
/** Действие дня в камере надзирателя уже сделано (1 — Пожирание, 2 — Замена, 3 — Выслеживание). */
export const USED = S0 + 5;
/** Едок в цепочке пожирания, −1 — цепочки нет. */
export const CHAIN_EATER = S0 + 6;
/** Укусов в текущем Пожирании. */
export const CHAIN_BITES = S0 + 7;
/** Орудия: бит TOOL.x. */
export const TOOLS = S0 + 8;
/** Ждут выбора: орудий (старт и цели) и подарков. */
export const PICK_TOOLS = S0 + 9;
export const PICK_GIFTS = S0 + 10;
/** Что сейчас предложено: OFFER_NONE / OFFER_TOOL / OFFER_GIFT. */
export const OFFER_KIND = S0 + 11;
export const OFFER_N = S0 + 12;
/** До 4 предложенных ид (номер орудия или подарка). */
export const OFFER = S0 + 13;
export const REROLLS = S0 + 17;
/** Призматических в хранилище. */
export const STORAGE = S0 + 18;
/** Текущая цель (OBJECTIVE.x), −1 — нет. */
export const OBJECTIVE_ID = S0 + 19;
export const OBJ_PROGRESS = S0 + 20;
/** Выполнено целей. */
export const OBJ_DONE = S0 + 21;
export const START = S0 + 22;
/** Пункты назначения утра: число и камеры. */
export const DOORS_N = S0 + 23;
export const DOORS = S0 + 24;
/** «Цепная реакция» ждёт следующего обхода. */
export const CHAIN_REACTION = S0 + 27;
/** Сколько ещё выборов в допросной за этот визит. */
export const OFFICE_LEFT = S0 + 28;
/** Метка «Добыча»: лев, добыча, сколько утр осталось (0 — метки нет). */
export const HUNT_LION = S0 + 29;
export const HUNT_PREY = S0 + 30;
export const HUNT_LEFT = S0 + 31;
/** Счётчики забега. */
export const STAT_OPENED = S0 + 32;
export const STAT_BITES = S0 + 33;
export const STAT_STEPS = S0 + 34;
export const STAT_EVENTS = S0 + 35;
export const STAT_DEVOURS = S0 + 36;
/** Ступень Узурпации в пуле событий (EVENT.usurp1…usurp4), −1 — Узурпации в пуле нет. */
export const USURP = S0 + 37;
/**
 * 1 — стартовая доска (открытые камеры, метки событий) ещё не разыграна:
 * забег начат с выбора орудия, доску покажет первое утро.
 */
export const START_PENDING = S0 + 38;

export const SIZE = S0 + 39;

// ── фазы ────────────────────────────────────────────────────────────────────

/** Выбор орудия или подарка. */
export const P_PICK = 0;
/** Не используется: «Выслеживание» — ход в ряду решений (P_MANAGE). Номер оставлен, чтобы не сдвигать фазы. */
export const P_HUNT = 1;
/** Выбор пункта назначения. */
export const P_PATROL = 2;
/** Окно события: принять или пропустить. */
export const P_EVENT = 3;
/** Допросная: Наградить или Подстрекнуть. */
export const P_OFFICE = 4;
/** «Крысиная тропа»: переход в любую камеру. */
export const P_RATWAY = 5;
/** «Примите решение»: Пожирание, Замена, Выслеживание, Завершить день. */
export const P_MANAGE = 6;
/** «Выберите узника для пожирания». */
export const P_CHAIN = 7;
/** Забег окончен. */
export const P_END = 8;
/** Служебные (только в NEXT): начать утро, завершить день. */
export const P_MORNING = 9;
export const P_DAYEND = 10;

export const PHASE_NAMES = [
  'pick', 'hunt', 'patrol', 'event', 'office', 'ratway', 'manage', 'chain', 'end', 'morning', 'dayend',
] as const;

export const OFFER_NONE = 0;
export const OFFER_TOOL = 1;
export const OFFER_GIFT = 2;

export const USED_DEVOUR = 1;
export const USED_SWAP = 2;
export const USED_HUNT = 3;

// ── состояние ───────────────────────────────────────────────────────────────

export class State {
  readonly m = new Int32Array(SIZE);
}

/** Копия одним set(). */
export function copy(from: State, to: State): void {
  to.m.set(from.m);
}

export function clone(s: State): State {
  const t = new State();
  t.m.set(s.m);
  return t;
}

export function hasTool(s: State, tool: number): boolean {
  return ((s.m[TOOLS]! >>> tool) & 1) === 1;
}

export function phase(s: State): number {
  return s.m[PHASE]!;
}

export function score(s: State): number {
  return s.m[STORAGE]!;
}

/** Расстояние по часовой стрелке от a до b. */
export function dist(a: number, b: number): number {
  return (b - a + CELLS) & (CELLS - 1);
}
