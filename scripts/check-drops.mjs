/**
 * Сколько конкретных предметов засчитано в добычу по всему логу.
 *
 *   npx tsx scripts/check-drops.mjs <лог> <id> [<id>...]
 */
import { readFileSync } from 'node:fs';
import { analyzeLogFile } from '../src/core/pipeline.ts';

const [logPath, ...ids] = process.argv.slice(2);
const items = new Map(
  JSON.parse(readFileSync('data/items.json', 'utf8')).map((i) => [i.id, i.name]),
);

const result = await analyzeLogFile(logPath);

const totals = new Map();
for (const run of result.runs) {
  for (const d of run.drops) totals.set(d.configBaseId, (totals.get(d.configBaseId) ?? 0) + d.qty);
}

console.log('=== засчитано в добычу ===');
for (const raw of ids) {
  const id = Number(raw);
  console.log(
    String(id).padEnd(8),
    (items.get(id) ?? '?').padEnd(34),
    `добыто: ${totals.get(id) ?? 0}`,
  );
}
console.log('\nперебазирований слотов:', result.diagnostics.slotRebases);
console.log('всего видов в добыче:', totals.size);
