/**
 * Эталоны распознавания. Собираются `scripts/prison-templates.mjs` из своих
 * размеченных кадров и лежат в `templates/*.json`; здесь — только чтение
 * и раскладка в типизированные массивы (один раз на процесс).
 */
import boardJson from './templates/board.json';
import cellsJson from './templates/cells.json';
import digitsJson from './templates/digits.json';
import screensJson from './templates/screens.json';
import type { DigitSet } from './text.js';

export function decodeU8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeU8(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/**
 * Вектор признаков в JSON: «масштаб;base64» — значения int8, делённые на
 * 127 и умноженные на масштаб (наибольший модуль). Вчетверо короче чисел.
 */
export function pack(v: ArrayLike<number>): string {
  let max = 0;
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]!));
  const bytes = new Uint8Array(v.length);
  for (let i = 0; i < v.length; i++) bytes[i] = (max > 0 ? Math.round((v[i]! / max) * 127) : 0) & 255;
  return `${max.toPrecision(6)};${encodeU8(bytes)}`;
}

export function unpack(s: string): Float32Array {
  const [scale, data] = s.split(';') as [string, string];
  const k = Number(scale) / 127;
  const bytes = decodeU8(data);
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = ((bytes[i]! << 24) >> 24) * k;
  return out;
}

export interface BoardTemplateJson {
  grad: { x0: number; y0: number; cell: number; w: number; h: number; data: string };
  numbers: string[];
}

export interface BoardTemplate {
  grad: BoardTemplateJson['grad'];
  numbers: Float32Array[];
}

let board: BoardTemplate | null = null;

export function boardTemplate(): BoardTemplate {
  if (!board) {
    const j = boardJson as unknown as BoardTemplateJson;
    board = { grad: j.grad, numbers: j.numbers.map((v) => unpack(v)) };
  }
  return board;
}


export interface CellsTemplate {
  lock: Float32Array;
  jaw: Float32Array;
  /** Прототипы портретов: класс (зверь, unknown — «?», locked — пустая запертая камера). */
  beasts: { label: string; v: Float32Array }[];
}

let cells: CellsTemplate | null = null;

export function cellsTemplate(): CellsTemplate {
  if (!cells) {
    const j = cellsJson as unknown as { lock: string; jaw: string; beasts: { label: string; v: string }[] };
    cells = {
      lock: unpack(j.lock),
      jaw: unpack(j.jaw),
      beasts: j.beasts.map((b) => ({ label: b.label, v: unpack(b.v) })),
    };
  }
  return cells;
}


let digits: DigitSet | null = null;

export function digitsTemplate(): DigitSet {
  if (!digits) {
    const j = digitsJson as unknown as { protos: { d: number; v: string }[]; aspect: number[] };
    digits = { protos: j.protos.map((p) => ({ d: p.d, v: unpack(p.v) })), aspect: j.aspect };
  }
  return digits;
}

export interface Proto {
  label: string;
  v: Float32Array;
}

export interface ScreensTemplate {
  headers: Proto[];
  cards: Proto[];
  tools: Proto[];
  chromatic: Proto[];
  objectives: Proto[];
  pickArt: Proto[];
  pickTitles: Proto[];
  pickHeaders: Proto[];
  reroll: Float32Array[];
  chromaticHeader: Float32Array[];
  gifts: Proto[];
  /** Метка «Добыча» на портрете (null — эталона нет). */
  prey: Float32Array | null;
}

let screens: ScreensTemplate | null = null;

export function screensTemplate(): ScreensTemplate {
  if (!screens) {
    type P = { label: string; v: string }[];
    const j = screensJson as unknown as Record<string, P> & { reroll: string[]; chromaticHeader: string[]; prey?: string };
    const list = (k: string): Proto[] => (j[k] ?? []).map((p) => ({ label: p.label, v: unpack(p.v) }));
    screens = {
      headers: list('headers'),
      cards: list('cards'),
      tools: list('tools'),
      chromatic: list('chromatic'),
      objectives: list('objectives'),
      pickArt: list('pickArt'),
      pickTitles: list('pickTitles'),
      pickHeaders: list('pickHeaders'),
      reroll: (j.reroll ?? []).map((v) => unpack(v)),
      chromaticHeader: (j.chromaticHeader ?? []).map((v) => unpack(v)),
      prey: j.prey ? unpack(j.prey) : null,
      gifts: list('gifts'),
    };
  }
  return screens;
}

/** Лучший прототип для вектора: класс и сходство. */
export function nearest(v: Float32Array, protos: Proto[]): { label: string; score: number } {
  let label = '';
  let score = -2;
  for (const p of protos) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i]! * p.v[i]!;
    if (s > score) {
      score = s;
      label = p.label;
    }
  }
  return { label, score };
}

/** Лучшее сходство с прототипами каждого класса. */
export function scoresByLabel(v: Float32Array, protos: Proto[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of protos) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i]! * p.v[i]!;
    if (s > (out.get(p.label) ?? -2)) out.set(p.label, s);
  }
  return out;
}
