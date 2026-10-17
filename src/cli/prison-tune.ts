/**
 * Настройка весов мгновенной стратегии тюрьмы самоигрой.
 *
 *   npx tsx src/cli/prison-tune.ts             — покоординатный поиск, пишет policy/weights.json
 *   npx tsx src/cli/prison-tune.ts --report    — сила стратегий по сценариям (таблица markdown)
 *
 * Ключи: --runs N (забегов на оценку, 6000), --passes N (проходов, 4),
 * --from hand (начать с ручных весов, а не с weights.json).
 *
 * Все кандидаты играют одни и те же забеги (общие кости): разница двух
 * наборов весов меряется по парам забегов, её ошибка в разы меньше, чем у
 * каждого среднего по отдельности. Принимается шаг, который лучше на 2 SE.
 */
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

import { DEFAULT_PARAMS, START_EVENT_IDS, type StartEventId, type ToolId } from '../core/prison/model.js';
import { codeBuffer, randomPlayout, startRun, type RunOptions } from '../core/prison/engine/actions.js';
import { Rng } from '../core/prison/engine/rng.js';
import { State } from '../core/prison/engine/state.js';
import { greedyPlayout } from '../core/prison/policy/greedy.js';
import { policyPlayout } from '../core/prison/policy/instant.js';
import {
  DEFAULT_WEIGHTS, HAND, W_GIFT, W_SIZE, W_TOOL, W_VAL0, fromJson, toJson, weightName,
} from '../core/prison/policy/weights.js';

// ── сценарии ────────────────────────────────────────────────────────────────

interface Scenario {
  /** 'mix' — стартовые события по кругу. */
  start: StartEventId | 'mix';
  tools?: ToolId[];
  startPick?: boolean;
  noObjective?: boolean;
}

type Kind = 'random' | 'greedy' | 'policy';

interface Task {
  id: number;
  kind: Kind;
  weights: number[];
  scenario: Scenario;
  seed: number;
  from: number;
  count: number;
}

function runOptions(sc: Scenario, i: number): RunOptions {
  const o: RunOptions = {
    start: sc.start === 'mix' ? START_EVENT_IDS[i % START_EVENT_IDS.length]! : sc.start,
    startPick: sc.startPick ?? true,
  };
  if (sc.tools) o.tools = sc.tools;
  if (sc.noObjective) o.objective = null;
  return o;
}

/** Сыграть забеги [from, from + count): счёт каждого. */
function play(t: Task): Int8Array {
  const p = DEFAULT_PARAMS;
  const w = Float64Array.from(t.weights);
  const s = new State();
  const buf = codeBuffer();
  const r = new Rng(1);
  const out = new Int8Array(t.count);
  for (let k = 0; k < t.count; k++) {
    const i = t.from + k;
    r.seed(Math.imul(t.seed ^ i, 0x9e3779b1) ^ i);
    startRun(s, r, p, runOptions(t.scenario, i));
    out[k] =
      t.kind === 'random' ? randomPlayout(s, r, p, buf) : t.kind === 'greedy' ? greedyPlayout(s, r, p) : policyPlayout(s, r, p, w);
  }
  return out;
}

// ── пул потоков ─────────────────────────────────────────────────────────────

function pool(size: number) {
  const workers = Array.from({ length: size }, () => new Worker(fileURLToPath(import.meta.url)));
  let nextId = 1;
  const waiting = new Map<number, (s: Int8Array) => void>();
  for (const w of workers) w.on('message', (m: { id: number; scores: Int8Array }) => waiting.get(m.id)?.(m.scores));
  let rr = 0;
  const run = (t: Omit<Task, 'id'>) =>
    new Promise<Int8Array>((resolve) => {
      const id = nextId++;
      waiting.set(id, (s) => {
        waiting.delete(id);
        resolve(s);
      });
      workers[rr++ % workers.length]!.postMessage({ ...t, id });
    });
  return {
    /** Счёт n забегов; одинаковые seed и сценарий — одинаковые забеги. */
    async scores(kind: Kind, w: Float64Array, sc: Scenario, seed: number, n: number): Promise<Float64Array> {
      const chunk = Math.ceil(n / (workers.length * 2));
      const jobs: Promise<Int8Array>[] = [];
      for (let from = 0; from < n; from += chunk) {
        jobs.push(run({ kind, weights: Array.from(w), scenario: sc, seed, from, count: Math.min(chunk, n - from) }));
      }
      const parts = await Promise.all(jobs);
      const out = new Float64Array(n);
      let o = 0;
      for (const part of parts) for (const x of part) out[o++] = x;
      return out;
    },
    close: () => Promise.all(workers.map((w) => w.terminate())),
  };
}

const mean = (a: Float64Array) => a.reduce((x, y) => x + y, 0) / a.length;

/** Среднее и SE разницы по парам забегов. */
function paired(a: Float64Array, b: Float64Array): { diff: number; se: number } {
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    s += d;
    s2 += d * d;
  }
  const n = a.length;
  const diff = s / n;
  return { diff, se: Math.sqrt(Math.max(0, s2 / n - diff * diff) / n) };
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
}

// ── настройка ───────────────────────────────────────────────────────────────

/** Шаг по весу i: множитель для ценностей узников, сдвиг для прочих. */
function step(i: number, w: Float64Array, scale: number): number {
  if (i < W_GIFT) return Math.max(0.01, Math.abs(w[i]!) * 0.3) * scale;
  if (i >= W_TOOL) return 0.2 * scale;
  const base = [0.1, 0.02, 0.03, 0.02, 0.03, 0.02, 0.1, 0.03, 0.1, 0.005][i - W_GIFT]!;
  return base * scale;
}

async function tune(): Promise<void> {
  const runs = Number(arg('--runs', '6000'));
  const passes = Number(arg('--passes', '4'));
  const P = pool(Math.max(1, cpus().length - 1));
  const sc: Scenario = { start: 'mix' };
  const seed = 0x51ed;
  let w = arg('--from', '') === 'hand' ? fromJson(HAND) : Float64Array.from(DEFAULT_WEIGHTS);
  let base = await P.scores('policy', w, sc, seed, runs);
  console.log(`старт: ${mean(base).toFixed(3)} призм. (${runs} забегов)`);
  let scale = 1;
  for (let pass = 0; pass < passes; pass++) {
    let accepted = 0;
    for (let i = W_VAL0; i < W_SIZE; i++) {
      for (const dir of [1, -1]) {
        const cand = Float64Array.from(w);
        cand[i] = w[i]! + dir * step(i, w, scale);
        const sc2 = await P.scores('policy', cand, sc, seed, runs);
        const { diff, se } = paired(sc2, base);
        if (diff > 2 * se && diff > 0) {
          w = cand;
          base = sc2;
          accepted++;
          console.log(`  ${weightName(i)} → ${w[i]!.toFixed(4)}: +${diff.toFixed(3)} (SE ${se.toFixed(3)}), ${mean(base).toFixed(3)}`);
          break;
        }
      }
    }
    console.log(`проход ${pass + 1}: принято ${accepted}, ${mean(base).toFixed(3)} призм.`);
    writeFileSync(new URL('../core/prison/policy/weights.json', import.meta.url), `${JSON.stringify(toJson(w), null, 2)}\n`);
    scale *= 0.6;
    if (accepted === 0 && pass > 0) break;
  }
  await P.close();
}

// ── отчёт ───────────────────────────────────────────────────────────────────

async function report(): Promise<void> {
  const runs = Number(arg('--runs', '20000'));
  const P = pool(Math.max(1, cpus().length - 1));
  const seed = 0xbeef; // не те забеги, на которых настраивали
  const hand = fromJson(HAND);
  const cases: [string, Scenario][] = [
    ['все стартовые события поровну, выбор орудий', { start: 'mix' }],
    ['без орудий (без выбора и без целей)', { start: 'none', startPick: false, noObjective: true }],
    ['двери: связка, поддельный ключ, короткая цепь', { start: 'none', startPick: false, tools: ['keys', 'forged', 'shortchain'] }],
    ['пожирание: плеть, ошейник, пила, корона', { start: 'none', startPick: false, tools: ['whip', 'collar', 'saw', 'crown'] }],
    ['замена: петля, столб, пест, секира', { start: 'none', startPick: false, tools: ['rope', 'stake', 'pestle', 'axe'] }],
    ['утро: монета, удушающая цепь, капкан', { start: 'none', startPick: false, tools: ['coin', 'ravenous', 'trap'] }],
    ...START_EVENT_IDS.map((id): [string, Scenario] => [`старт: ${id}`, { start: id }]),
  ];
  console.log(`| Сценарий | Случайные | Жадная | Ручные веса | Настроенные |`);
  console.log(`|---|---|---|---|---|`);
  for (const [name, sc] of cases) {
    const r = mean(await P.scores('random', hand, sc, seed, runs));
    const g = mean(await P.scores('greedy', hand, sc, seed, runs));
    const h = mean(await P.scores('policy', hand, sc, seed, runs));
    const t = mean(await P.scores('policy', DEFAULT_WEIGHTS, sc, seed, runs));
    console.log(`| ${name} | ${r.toFixed(2)} | ${g.toFixed(2)} | ${h.toFixed(2)} | ${t.toFixed(2)} |`);
  }
  await P.close();
}

async function main(): Promise<void> {
  if (process.argv.includes('--report')) await report();
  else await tune();
}

// Точка входа в конце: константы выше должны быть уже объявлены.
if (!isMainThread) {
  parentPort!.on('message', (t: Task) => parentPort!.postMessage({ id: t.id, scores: play(t) }));
} else {
  await main();
}
