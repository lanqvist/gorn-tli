/**
 * Почему цена не сохраняется: прогоняем наблюдения через PriceStore
 * и смотрим, какие принимаются, а какие отбрасываются и почему.
 */
import { readFileSync } from 'node:fs';
import { analyzeLogFile } from '../src/core/pipeline.ts';
import { PriceStore } from '../src/core/priceStore.ts';

const items = JSON.parse(readFileSync('data/items.json', 'utf8'));
const byId = new Map(items.map((i) => [i.id, i.name]));

const result = await analyzeLogFile(process.argv[2]);
const store = new PriceStore();
store.registerKnownItems(items.map((i) => i.id));

console.log('наблюдений цен в логе:', result.prices.length);
for (const ev of result.prices) {
  const accepted = store.observe(ev);
  const name = byId.get(ev.configBaseId) ?? `id ${ev.configBaseId}`;
  console.log(
    `${String(ev.configBaseId).padEnd(8)} ${name.padEnd(30)} ` +
      `валюта=${ev.currency} лотов=${String(ev.unitPrices.length).padStart(3)} ` +
      (accepted ? `принято, референс ${accepted.fe}` : 'ОТБРОШЕНО'),
  );
}

console.log('\n--- итог по интересующим предметам ---');
for (const id of [100200, 200003, 200028, 200029, 200030, 5080, 400033]) {
  const price = store.priceOf(id);
  console.log(
    String(id).padEnd(8),
    (byId.get(id) ?? '?').padEnd(30),
    price === null ? 'цены нет' : `цена ${price}`,
  );
}
