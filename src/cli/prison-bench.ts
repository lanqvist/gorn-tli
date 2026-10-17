/**
 * Замер движка тюрьмы: сколько стоит доиграть забег случайными ходами.
 *
 *   npx tsx src/cli/prison-bench.ts
 *
 * Внутри vitest цифры в разы хуже: его преобразование модулей превращает
 * каждое импортированное имя в чтение свойства, а горячий цикл весь из них.
 */
import { DEFAULT_PARAMS, TOOL_IDS, type ToolId } from '../core/prison/model.js';
import { codeBuffer, randomPlayout, startRun } from '../core/prison/engine/actions.js';
import { Rng } from '../core/prison/engine/rng.js';
import { State, copy } from '../core/prison/engine/state.js';

const CASES: [string, ToolId[]][] = [
  ['без орудий', []],
  ['6 орудий', ['keys', 'coin', 'trap', 'claws', 'ravenous', 'scales']],
  ['все 31 орудие', [...TOOL_IDS]],
];
const N = 20000;

const p = DEFAULT_PARAMS;
const buf = codeBuffer();
const s = new State();
for (const [label, tools] of CASES) {
  const r = new Rng(1);
  const start = new State();
  startRun(start, r, p, { tools });
  let total = 0;
  for (let i = 0; i < 5000; i++) {
    copy(start, s);
    total += randomPlayout(s, r, p, buf);
  }
  const times: number[] = [];
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      copy(start, s);
      total += randomPlayout(s, r, p, buf);
    }
    times.push(((performance.now() - t0) * 1000) / N);
  }
  times.sort((a, b) => a - b);
  const mean = total / (5000 + 5 * N);
  console.log(`${label}: ${times[2]!.toFixed(1)} мкс на забег (медиана из 5), ${mean.toFixed(2)} призм. в среднем`);
}
