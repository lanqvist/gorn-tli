/**
 * Проверка привязки вложений к картам на реальном логе.
 *
 *   node scripts/check-costs.mjs <путь к UE_game.log>
 */
import { readFileSync } from 'node:fs';
import { analyzeLogFile } from '../src/core/pipeline.ts';

const items = new Map(
  JSON.parse(readFileSync('data/items.json', 'utf8')).map((i) => [i.id, i.name]),
);
const name = (id) => items.get(id) ?? `id ${id}`;

const result = await analyzeLogFile(process.argv[2]);

console.log('зон всего:', result.runs.length);
for (const run of result.runs) {
  const kind = run.isHub ? 'ГОРОД' : 'КАРТА';
  const secs = Math.round((run.durationMs ?? 0) / 1000);
  console.log(`\n${kind}  area=${run.areaId}  ${run.asset ?? '—'}  ${secs}с`);
  if (run.costs.length > 0) {
    for (const c of run.costs) console.log(`   вложено: ${c.qty} × ${name(c.configBaseId)}`);
  } else {
    console.log('   вложений нет');
  }
  const top = [...run.drops]
    .reduce((map, d) => map.set(d.configBaseId, (map.get(d.configBaseId) ?? 0) + d.qty), new Map());
  const list = [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [id, qty] of list) console.log(`   добыто: ${qty} × ${name(id)}`);
}

console.log('\n=== ЦЕНЫ ИЗ ЭТОГО ЛОГА ===');
for (const p of result.prices) {
  const sorted = [...p.unitPrices].sort((a, b) => a - b);
  console.log(
    `${name(p.configBaseId).padEnd(32)} лотов ${String(p.unitPrices.length).padStart(3)}  минимум ${sorted[0]}`,
  );
}
