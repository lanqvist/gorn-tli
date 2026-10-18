/**
 * Свой путь подсказок на сохранённых кадрах тюрьмы против прежнего.
 *
 *   npx tsx src/cli/prison-replay.ts [папка] [--budget 1000] [--diffs файл.md]
 *
 * Папка — день кадров Горна («Изображения/Горн — тюрьма/<дата>»: PNG и JSON
 * с видом кадра, строками лога и прежними подсказками). Кадры идут по
 * порядку через OwnAdvisor (распознавание → память забега → решатель →
 * метки), как в потоке подсказок. Отчёт: совпадение хода с прежней
 * подсказкой по видам экранов, время на кадр, расхождения с путями кадров.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { read } from '../core/prison/recognize/index.js';
import { decodePng } from '../core/prison/recognize/png.js';
import type { Frame, Geometry } from '../core/prison/recognize/types.js';
import { hint } from '../core/prison/hint.js';
import { OwnAdvisor } from '../main/prison/ownAdvisor.js';
import type { PrisonShotMessage, PrisonWorkerReply } from '../main/prison/protocol.js';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const dir = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : join(homedir(), 'Pictures', 'Горн — тюрьма', '2026-10-17');
const budget = Number(arg('--budget') ?? 1000);
const diffsOut = arg('--diffs');

interface Saved {
  kind: PrisonShotMessage['kind'];
  fresh?: boolean;
  after?: '' | 'swap' | 'consume';
  treasureView?: boolean;
  rerolled?: boolean;
  treasureClosed?: boolean;
  asTreasure?: boolean;
  theme?: number | null;
  hints?: { type: string; phase?: string; text?: string }[];
}

/** Ход из текста подсказки — общий ключ для прежнего и своего пути. */
export function moveKey(text: string | undefined): string {
  if (!text) return '';
  const t = text.split(' · ')[0]!.trim();
  const cell = (s: string) => (s === 'допросную' ? '0' : s.replace('№', ''));
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^Иди в (допросную|№\d+)/))) return `обход ${cell(m[1]!)}`;
  if ((m = t.match(/^Выбери (№\d+)/))) return `тропа ${cell(m[1]!)}`;
  if ((m = t.match(/^Пожирание: съесть (№\d+)/))) return `съесть ${cell(m[1]!)}`;
  // На экране выбора цели прежний путь писал «Пожирание» и до первого укуса, и после.
  if ((m = t.match(/^Цепочка: съесть (№\d+)/))) return `съесть ${cell(m[1]!)}`;
  if ((m = t.match(/^Метка добычи: (№\d+)/))) return `метка ${cell(m[1]!)}`;
  if (/^Остановить цепочку/.test(t) || /^Отменить/.test(t)) return 'отменить';
  if (/^Заменить/.test(t)) return 'заменить';
  if (/^Завершить день/.test(t)) return 'конец дня';
  if (/^Наградить/.test(t)) return 'наградить';
  if (/^Подстрекнуть/.test(t)) return 'подстрекнуть';
  if (/^Обновить/.test(t)) return 'обновить';
  if (/нажми «Посмотреть состояние тюрьмы»/.test(t)) return 'показать доску';
  if ((m = t.match(/^Взять: (.+)$/))) return `взять ${m[1]!.split(' ').slice(0, 2).join(' ').toLowerCase()}`;
  return t;
}

/** Последняя показанная подсказка (окончательная, иначе мгновенная). */
function lastHint(replies: { type: string; phase?: string; text?: string }[]): string {
  let text = '';
  for (const r of replies) {
    if (r.type === 'hint') text = r.text ?? '';
    else if (r.type === 'clear' && !text) text = '';
  }
  return text;
}

const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
if (!files.length) {
  console.error(`нет кадров в ${dir}`);
  process.exit(1);
}

let replies: PrisonWorkerReply[] = [];
const advisor = new OwnAdvisor((m) => replies.push(m), { sleep: () => Promise.resolve() });
advisor.init(null, null);

interface Row {
  file: string;
  screen: string;
  old: string;
  mine: string;
  oldKey: string;
  mineKey: string;
  firstMs: number;
  totalMs: number;
  readMs: number;
  /** На сколько призм. ход прежнего хуже своего по оценке своего решателя (null — не оценён). */
  gap: number | null;
}
const rows: Row[] = [];
let geo: Geometry | null = null;
let id = 0;
let prevKind = '';
/** Доска за окном подарков (просмотр или после подарка) сохранилась без PNG: совет по подаркам не воспроизвести. */
let behindLost = false;

for (const f of files) {
  const saved = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Saved;
  const png = join(dir, f.replace(/\.json$/, '.png'));
  const frame: Frame | null = existsSync(png) ? decodePng(readFileSync(png)) : null;
  // Вид экрана — для отчёта (отдельный проход распознавания, время отдельно).
  let screen: string = saved.kind;
  let readMs = 0;
  if (frame) {
    const t = performance.now();
    const r = read(frame, geo);
    readMs = performance.now() - t;
    geo = r.geo ?? geo;
    screen = r.view.screen === 'board' ? (r.view.board.chain ? 'chain' : r.view.board.decision ? r.view.board.decision.kind : r.view.board.doors.length ? 'patrol' : 'board') : r.view.screen;
  } else if (saved.kind === 'treasure') screen = behindLost ? 'без PNG' : 'treasure';
  else screen = 'без PNG';
  if (saved.kind === 'board') {
    if (frame) behindLost = false;
    else if (saved.treasureView || prevKind === 'treasure') behindLost = true;
  }
  const msg: PrisonShotMessage = {
    type: 'shot',
    id: ++id,
    kind: saved.kind,
    fresh: !!saved.fresh,
    after: saved.after ?? '',
    treasureView: !!saved.treasureView,
    rerolled: !!saved.rerolled,
    // В старых JSON флага нет: доска сразу после окна подарков — доска за ним.
    treasureClosed: saved.treasureClosed ?? (saved.kind === 'board' && prevKind === 'treasure'),
    // Флаг «доска снята, когда окно подарков уже открылось» в старых JSON не
    // записан: восстанавливаем по прежнему ответу на этот кадр.
    asTreasure: saved.asTreasure ?? (saved.kind === 'board' && moveKey(lastHint(saved.hints ?? [])) === 'показать доску'),
    theme: saved.theme ?? null,
    width: frame?.width ?? 1920,
    height: frame?.height ?? 1080,
    buffer: new ArrayBuffer(0),
    format: 'rgba',
    budgetMs: budget,
    savePath: null,
  };
  prevKind = saved.kind;
  replies = [];
  const t0 = performance.now();
  let firstMs = -1;
  const origPush = replies.push.bind(replies);
  replies.push = (...items: PrisonWorkerReply[]) => {
    for (const r of items) if (firstMs < 0 && (r.type === 'hint' || r.type === 'clear')) firstMs = performance.now() - t0;
    return origPush(...items);
  };
  await advisor.handle(msg, frame);
  const totalMs = performance.now() - t0;
  const old = lastHint(saved.hints ?? []);
  const mine = lastHint(replies as { type: string; text?: string }[]);
  const oldKey = moveKey(old);
  let gap: number | null = null;
  const opts = advisor.lastOptions;
  if (oldKey && opts.length > 1) {
    const best = Math.max(...opts.map((o) => o.mean));
    const theirs = opts.find((o) => moveKey(hint(o.action, { warden: null }).text) === oldKey);
    if (theirs) gap = best - theirs.mean;
  }
  rows.push({ file: f, screen, old, mine, oldKey, mineKey: moveKey(mine), firstMs: Math.max(0, firstMs), totalMs, readMs, gap });
}

// ── отчёт ───────────────────────────────────────────────────────────────────

const q = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const skipped = rows.filter((r) => r.screen === 'без PNG').length;
const all = rows;
rows.splice(0, rows.length, ...all.filter((r) => r.screen !== 'без PNG'));
const both = rows.filter((r) => r.oldKey && r.mineKey);
const same = both.filter((r) => r.oldKey === r.mineKey);
console.log(`кадров: ${rows.length + skipped} (${dir}); не переиграть: ${skipped} (нет PNG; окна подарков, у которых доска за окном без PNG)`);
console.log(`оба дали ход: ${both.length}, совпало: ${same.length} (${((100 * same.length) / Math.max(1, both.length)).toFixed(1)} %)`);
console.log(`ход только у прежнего: ${rows.filter((r) => r.oldKey && !r.mineKey).length}, только у своего: ${rows.filter((r) => !r.oldKey && r.mineKey).length}`);
const byScreen = new Map<string, { n: number; same: number; oldOnly: number; mineOnly: number }>();
for (const r of rows) {
  const s = byScreen.get(r.screen) ?? { n: 0, same: 0, oldOnly: 0, mineOnly: 0 };
  if (r.oldKey && r.mineKey) {
    s.n++;
    if (r.oldKey === r.mineKey) s.same++;
  } else if (r.oldKey) s.oldOnly++;
  else if (r.mineKey) s.mineOnly++;
  byScreen.set(r.screen, s);
}
console.log('по экранам (оба дали ход: совпало / всего; ход только у прежнего; только у своего):');
for (const [k, s] of [...byScreen].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${k}: ${s.same}/${s.n}${s.n ? ` (${((100 * s.same) / s.n).toFixed(0)} %)` : ''}; только прежний ${s.oldOnly}; только свой ${s.mineOnly}`);
}
const gaps = both.filter((r) => r.oldKey !== r.mineKey && r.gap !== null).map((r) => r.gap!);
if (gaps.length) {
  const small = gaps.filter((g) => g < 0.1).length;
  console.log(`расхождения, оценённые своим решателем: ${gaps.length}; ход прежнего хуже меньше чем на 0,1 призм.: ${small} (${((100 * small) / gaps.length).toFixed(0)} %), медиана разницы ${q(gaps, 0.5).toFixed(2)}, p90 ${q(gaps, 0.9).toFixed(2)}`);
}
const advised = rows.filter((r) => r.mineKey);
console.log(`кадры с советом: до первой подсказки медиана ${q(advised.map((r) => r.firstMs), 0.5).toFixed(0)} мс, p95 ${q(advised.map((r) => r.firstMs), 0.95).toFixed(0)} мс`);
const withPng = rows.filter((r) => r.readMs > 0);
console.log(`распознавание: медиана ${q(withPng.map((r) => r.readMs), 0.5).toFixed(1)} мс, p95 ${q(withPng.map((r) => r.readMs), 0.95).toFixed(1)} мс`);
console.log(`до первой подсказки (распознавание + совет): медиана ${q(rows.map((r) => r.firstMs), 0.5).toFixed(0)} мс, p95 ${q(rows.map((r) => r.firstMs), 0.95).toFixed(0)} мс`);
console.log(`до окончательной: медиана ${q(rows.map((r) => r.totalMs), 0.5).toFixed(0)} мс, p95 ${q(rows.map((r) => r.totalMs), 0.95).toFixed(0)} мс`);

const diffs = rows.filter((r) => r.oldKey !== r.mineKey && (r.oldKey || r.mineKey));
if (diffsOut) {
  const lines = ['# Расхождения своего пути с прежним', '', `Папка: ${dir}`, '', 'Разница — на сколько призм. к концу забега ход прежнего хуже своего по оценке своего решателя.', '', '| Кадр | Экран | Прежний | Свой | Разница |', '|---|---|---|---|---|'];
  for (const r of diffs) lines.push(`| ${join(dir, r.file.replace(/\.json$/, '.png'))} | ${r.screen} | ${r.old || '—'} | ${r.mine || '—'} | ${r.gap === null ? '' : r.gap.toFixed(2)} |`);
  writeFileSync(diffsOut, `${lines.join('\n')}\n`);
  console.log(`расхождений: ${diffs.length}, список — ${diffsOut}`);
} else {
  console.log(`расхождений: ${diffs.length} (список — ключом --diffs файл.md)`);
}
