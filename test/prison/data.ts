/**
 * Данные для проверки распознавания тюрьмы: ~/Documents/gorn-prison-data
 * (или GORN_PRISON_DATA). Папки нет — тесты пропускаются.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { decodePng } from '../../src/core/prison/recognize/png.js';
import type { Frame } from '../../src/core/prison/recognize/types.js';
import type { BoardView } from '../../src/core/prison/view.js';

export const DATA = process.env.GORN_PRISON_DATA ?? join(homedir(), 'Documents', 'gorn-prison-data');
export const HAVE_DATA = existsSync(join(DATA, 'labels'));

export function labels<T>(name: string): Record<string, T> {
  const path = join(DATA, 'labels', name);
  if (!existsSync(path)) return {};
  const { _about: _, ...rest } = JSON.parse(readFileSync(path, 'utf8')) as Record<string, T>;
  return rest;
}

/** Кадр по пути внутри images/ папки данных или по полному пути. */
export function frame(rel: string): Frame {
  return decodePng(readFileSync(isAbsolute(rel) ? rel : join(DATA, 'images', rel)));
}

/** Ручная разметка доски (формат boards-ru*.json, камеры 1–16). */
export interface BoardLabel {
  inmates: Record<string, string>;
  locked: number[];
  nests: number[];
  events: number[];
  jaws: number[];
  warden: number;
  phase: 'patrol' | 'manage';
  doors: number[];
  days: number;
  tools: string[];
  chromatic: number;
}

/** Счёт по полям: поле → [верно, всего]; ошибки — для сообщения теста. */
export class Score {
  fields = new Map<string, [number, number]>();
  errors: string[] = [];

  add(field: string, ok: boolean, where: string, detail: () => string): void {
    const f = this.fields.get(field) ?? [0, 0];
    f[1]++;
    if (ok) f[0]++;
    else this.errors.push(`${where} ${field}: ${detail()}`);
    this.fields.set(field, f);
  }

  table(): string {
    return [...this.fields].map(([k, [ok, n]]) => `${k.padEnd(10)} ${ok}/${n} ${((100 * ok) / n).toFixed(1)}%`).join('\n');
  }

  worst(): number {
    let w = 1;
    for (const [ok, n] of this.fields.values()) w = Math.min(w, ok / n);
    return w;
  }
}

const show = (v: unknown): string => JSON.stringify(v);

/**
 * Сравнить распознанную доску с разметкой. Разметка:
 * - «!» отмечены только на запертых камерах — сравниваем на запертых;
 * - допросная среди дверей записана последней (1) после номерных;
 * - «casket» в старой разметке — то же орудие, что revenge.
 */
export function compareBoard(score: Score, where: string, b: BoardView, l: BoardLabel): void {
  for (let n = 2; n <= 16; n++) {
    const c = b.cells[n - 1]!;
    const exp = l.inmates[n] ? `inmate ${l.inmates[n]}` : l.locked.includes(n) ? 'locked' : 'empty';
    const got = c.kind === 'inmate' ? `inmate ${c.beast}/${c.tier}` : c.kind;
    score.add('cell', exp === got, `${where} №${n}`, () => `${exp} → ${got}`);
    if (l.locked.includes(n)) {
      score.add('event', !!c.event === l.events.includes(n), `${where} №${n}`, () => `ждали ${l.events.includes(n)}`);
      score.add('nest', !!c.nest === l.nests.includes(n), `${where} №${n}`, () => `ждали ${l.nests.includes(n)}`);
    }
    score.add('jaws', !!c.jaws === l.jaws.includes(n), `${where} №${n}`, () => `ждали ${l.jaws.includes(n)}`);
  }
  score.add('warden', b.warden === l.warden - 1, where, () => `${l.warden} → ${b.warden === null ? null : b.warden + 1}`);
  const phase =
    l.phase === 'patrol' ? 'patrol' : l.warden === 1 ? 'office' : 'manage';
  const gotPhase =
    b.decision === null ? (b.doors.length ? 'patrol' : 'none') : b.decision.kind;
  score.add('phase', phase === gotPhase, where, () => `${phase} → ${gotPhase}`);
  const doors = [...b.doors.filter((d) => d !== 0).map((d) => d + 1), ...b.doors.filter((d) => d === 0).map(() => 1)];
  score.add('doors', show(doors) === show(l.doors), where, () => `${show(l.doors)} → ${show(doors)}`);
  score.add('days', b.daysLeft === l.days, where, () => `${l.days} → ${b.daysLeft}`);
  const tools = l.tools.map((t) => (t === 'casket' ? 'revenge' : t));
  score.add('tools', show(b.tools) === show(tools), where, () => `${show(tools)} → ${show(b.tools)}`);
  score.add('chromatic', b.chromatic === l.chromatic, where, () => `${l.chromatic} → ${b.chromatic}`);
}
