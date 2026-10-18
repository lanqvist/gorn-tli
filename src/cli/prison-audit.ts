/**
 * Аудит забегов тюрьмы по кадрам Горна: что пошло не так и что улучшить.
 *
 *   npx tsx src/cli/prison-audit.ts [--new] [--days 2] [--budget 600] [--quiet 10] [--run ЧЧММСС]
 *
 * Берёт папки кадров за последние --days дней («Изображения/Горн — тюрьма/
 * <дата>»), делит их на забеги и каждый завершённый забег (следом начался
 * новый или кадров не было --quiet минут) прогоняет заново через свой путь
 * подсказок. Находки — в prison-audit-core.ts. Кадры забега копируются в
 * папку данных (Горн удаляет картинки подсказок через 2 часа), отчёт —
 * «gorn-prison-data/audits/<дата>/<ЧЧММСС>.md», разобранные забеги — в
 * audits/index.json. --new — только ещё не разобранные.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { findLogDirectory } from '../core/locate.js';
import { hint } from '../core/prison/hint.js';
import { read } from '../core/prison/recognize/index.js';
import { decodePng } from '../core/prison/recognize/png.js';
import type { Frame, Geometry } from '../core/prison/recognize/types.js';
import { clearSolveCache } from '../core/prison/solver/solve.js';
import { stampMs } from '../core/prisonTriggers.js';
import { OwnAdvisor } from '../main/prison/ownAdvisor.js';
import type { PrisonShotMessage, PrisonWorkerReply } from '../main/prison/protocol.js';
import { NET_RE, findings, splitRuns, summary, type FrameRec, type Finding } from './prison-audit-core.js';
import { lastHint, moveKey } from './prison-moves.js';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const SHOTS = join(homedir(), 'Pictures', 'Горн — тюрьма');
const DATA = join(homedir(), 'Documents', 'gorn-prison-data');
const OUT = join(DATA, 'audits');
const onlyNew = process.argv.includes('--new');
const days = Number(arg('--days') ?? 2);
const budget = Number(arg('--budget') ?? 600);
const quietMs = Number(arg('--quiet') ?? 10) * 60_000;
const onlyRun = arg('--run');

interface Saved {
  kind: PrisonShotMessage['kind'];
  fresh?: boolean;
  after?: PrisonShotMessage['after'];
  treasureView?: boolean;
  rerolled?: boolean;
  treasureClosed?: boolean;
  asTreasure?: boolean;
  theme?: number | null;
  day?: { cur: number; max: number } | null;
  lines?: string[];
  hints?: { type: string; phase?: string; text?: string }[];
}

type Index = Record<string, { at: string; findings: number; prisms: number; report: string }>;
const indexPath = join(OUT, 'index.json');
const index: Index = existsSync(indexPath) ? (JSON.parse(readFileSync(indexPath, 'utf8')) as Index) : {};

let logLines: string[] | null = null;
function gameLog(): string[] {
  if (logLines) return logLines;
  const dir = findLogDirectory();
  const path = dir ? join(dir, 'UE_game.log') : null;
  logLines = path && existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  return logLines;
}

/** Прогнать кадры забега через свой путь подсказок. */
async function replay(dir: string, files: string[]): Promise<{ recs: FrameRec[]; saved: Saved[] }> {
  clearSolveCache();
  let replies: PrisonWorkerReply[] = [];
  const advisor = new OwnAdvisor((m) => replies.push(m), { sleep: () => Promise.resolve() });
  advisor.init(null, null);
  let geo: Geometry | null = null;
  let id = 0;
  let logDay: { cur: number; max: number } | null = null;
  const recs: FrameRec[] = [];
  const saved: Saved[] = [];
  for (const f of files) {
    const s = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Saved;
    saved.push(s);
    // Картинку Горн удаляет через 2 часа — тогда берём копию из папки данных.
    const name = f.replace(/\.json$/, '.png');
    const png = [join(dir, name), join(DATA, 'runs', basename(dir), name)].find((p) => existsSync(p));
    const frame: Frame | null = png ? decodePng(readFileSync(png)) : null;
    let screen = s.kind === 'treasure' ? 'treasure' : 'other';
    let actionable = false;
    let pickUnknown = 0;
    if (frame) {
      const r = read(frame, geo);
      geo = r.geo ?? geo;
      const v = r.view;
      if (v.screen === 'board') {
        const b = v.board;
        screen = b.chain ? 'chain' : b.decision ? b.decision.kind : b.doors.length ? 'patrol' : 'board';
        actionable = screen !== 'board';
      } else if (v.screen === 'pick') {
        screen = 'pick';
        actionable = true;
        pickUnknown = v.pick.cards.filter((c) => c === null).length;
      } else screen = v.screen;
    }
    for (const l of s.lines ?? []) {
      const d = /check cur=(\d+) max=(\d+)/.exec(l);
      if (d && Number(d[2]) > 0) logDay = { cur: Number(d[1]), max: Number(d[2]) };
    }
    const msg: PrisonShotMessage = {
      type: 'shot', id: ++id, kind: s.kind, fresh: !!s.fresh, after: s.after ?? '', treasureView: !!s.treasureView, rerolled: !!s.rerolled,
      treasureClosed: !!s.treasureClosed, asTreasure: !!s.asTreasure, theme: s.theme ?? null, day: s.day ?? logDay,
      width: frame?.width ?? 1920, height: frame?.height ?? 1080, buffer: new ArrayBuffer(0), format: 'rgba', budgetMs: budget, savePath: null,
    };
    replies = [];
    await advisor.handle(msg, frame);
    const mine = lastHint(replies as { type: string; text?: string }[]);
    const live = lastHint(s.hints ?? []);
    const opts = advisor.lastOptions;
    // Один вариант решатель не считает (ожидание 0) — оценки нет.
    const best = opts.length > 1 ? Math.max(...opts.map((o) => o.mean)) : null;
    let liveGap: number | null = null;
    if (best !== null && live && moveKey(live) !== moveKey(mine)) {
      const theirs = opts.find((o) => moveKey(hint(o.action, { warden: null }).text) === moveKey(live));
      if (theirs) liveGap = best - theirs.mean;
    }
    const mem = advisor.memory as { day: number; dayLimit: number; storage: number; tools: string[]; assumed: { tool: string }[]; step: string; start: string };
    recs.push({
      file: f, time: f.slice(0, 6), kind: s.kind, hasPng: !!frame, logDay: s.day ?? logDay, live, screen, actionable, pickUnknown, mine, best, liveGap,
      mem: { day: mem.day, dayLimit: mem.dayLimit, storage: mem.storage, tools: [...mem.tools], assumed: mem.assumed.map((a) => a.tool), step: mem.step, start: mem.start },
    });
  }
  return { recs, saved };
}

/** Обрывы связи в логе игры за время забега (по меткам строк кадров). */
function netEvents(saved: Saved[], files: string[]): Finding[] {
  const stamps = saved.flatMap((s) => (s.lines ?? []).map((l) => stampMs(l)).filter((x): x is number => x !== null));
  if (!stamps.length) return [];
  const lo = Math.min(...stamps) - 5_000;
  const hi = Math.max(...stamps) + 5_000;
  // Сдвиг лога (UTC) к местному времени кадров: по последнему кадру со строками.
  let offset = 0;
  for (let i = saved.length - 1; i >= 0; i--) {
    const st = (saved[i]!.lines ?? []).map((l) => stampMs(l)).filter((x): x is number => x !== null).pop();
    if (st === undefined) continue;
    const t = files[i]!;
    const local = ((Number(t.slice(0, 2)) * 60 + Number(t.slice(2, 4))) * 60 + Number(t.slice(4, 6))) * 1000;
    const utc = st % 86_400_000;
    offset = Math.round((local - utc) / 900_000) * 900_000;
    break;
  }
  const hits = gameLog().filter((l) => NET_RE.test(l)).map((l) => ({ l, at: stampMs(l) })).filter((h) => h.at !== null && h.at >= lo && h.at <= hi);
  if (!hits.length) return [];
  const t = new Date((hits[0]!.at! + offset) % 86_400_000);
  const time = `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}:${String(t.getUTCSeconds()).padStart(2, '0')}`;
  return [{ kind: 'связь', time, text: `обрыв связи с игрой (строк в логе: ${hits.length}); проверь память после переподключения` }];
}

function report(day: string, start: string, recs: FrameRec[], found: Finding[], files: string[]): string {
  const s = summary(recs);
  const decided = recs.filter((r) => r.live && r.mine);
  const same = decided.filter((r) => moveKey(r.live) === moveKey(r.mine)).length;
  const hh = `${start.slice(0, 2)}:${start.slice(2, 4)}:${start.slice(4, 6)}`;
  const lines = [
    `# Забег ${day} ${hh}`,
    '',
    `- Итог: ${s.prisms} призм. в хранилище, дней ${s.days}${s.theme !== 'none' ? `, тема ${s.theme}` : ''}.`,
    `- Ожидание на первом обходе: ${s.start === null ? '—' : s.start.toFixed(2)}.`,
    `- Орудия: ${s.tools.join(', ') || '—'}.`,
    `- Живые подсказки совпали с повтором: ${same} из ${decided.length}.`,
    `- Кадров: ${files.length} (${files[0]} … ${files[files.length - 1]}).`,
    '',
    `## Находки (${found.length})`,
    '',
  ];
  if (!found.length) lines.push('Нет.');
  const byKind = new Map<string, Finding[]>();
  for (const f of found) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);
  for (const [kind, list] of byKind) {
    for (const f of list.slice(0, 8)) lines.push(`- ${f.time} · ${kind} · ${f.text}${f.count ? ` (кадров подряд: ${f.count})` : ''}`);
    if (list.length > 8) lines.push(`- … ещё ${kind}: ${list.length - 8}`);
  }
  return lines.join('\n') + '\n';
}

async function main(): Promise<void> {
  const dayDirs = existsSync(SHOTS) ? readdirSync(SHOTS).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(-days) : [];
  let done = 0;
  for (const day of dayDirs) {
    const dir = join(SHOTS, day);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    const heads = files.map((f) => {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Saved;
      return { file: f, kind: s.kind, fresh: !!s.fresh };
    });
    const runs = splitRuns(heads);
    for (let k = 0; k < runs.length; k++) {
      const run = runs[k]!;
      if (!run.start) continue;
      const runFiles = files.slice(run.from, run.to + 1);
      const start = runFiles[0]!.slice(0, 6);
      const runId = `${day}/${start}`;
      if (onlyRun && start !== onlyRun) continue;
      if (onlyNew && index[runId]) continue;
      const lastMtime = statSync(join(dir, runFiles[runFiles.length - 1]!)).mtimeMs;
      const finished = k < runs.length - 1 || Date.now() - lastMtime > quietMs;
      if (!finished) {
        console.log(`забег ${runId}: ещё идёт — разберу после`);
        continue;
      }
      const { recs, saved } = await replay(dir, runFiles);
      const found = findings(recs);
      // Картинки без описания (JSON не записан: расчёт прервал следующий кадр).
      const lo = runFiles[0]!.slice(0, 6);
      const hi = runFiles[runFiles.length - 1]!.slice(0, 6);
      const lost = readdirSync(dir).filter((p) => p.endsWith('.png') && p.slice(0, 6) >= lo && p.slice(0, 6) <= hi && !existsSync(join(dir, p.replace(/\.png$/, '.json'))));
      if (lost.length) found.push({ kind: 'кадры', time: `${lost[0]!.slice(0, 2)}:${lost[0]!.slice(2, 4)}:${lost[0]!.slice(4, 6)}`, text: `картинок без JSON: ${lost.length} (${lost.slice(0, 3).join(', ')})` });
      found.push(...netEvents(saved, runFiles));
      // Кадры — в папку данных, пока Горн их не удалил.
      const keep = join(DATA, 'runs', day);
      mkdirSync(keep, { recursive: true });
      for (const p of readdirSync(dir).filter((p) => p.slice(0, 6) >= lo && p.slice(0, 6) <= hi)) {
        if (!existsSync(join(keep, p))) copyFileSync(join(dir, p), join(keep, p));
      }
      const out = join(OUT, day);
      mkdirSync(out, { recursive: true });
      const path = join(out, `${start}.md`);
      writeFileSync(path, report(day, start, recs, found, runFiles));
      const s = summary(recs);
      index[runId] = { at: new Date().toISOString(), findings: found.length, prisms: s.prisms, report: path };
      writeFileSync(indexPath, JSON.stringify(index, null, 1));
      console.log(`забег ${runId}: ${s.prisms} призм., находок ${found.length} → ${path}`);
      done++;
    }
  }
  if (!done) console.log(onlyNew ? 'новых завершённых забегов нет' : 'забегов нет');
}

void main();
