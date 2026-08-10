/**
 * Ретро-скан: разбирает все накопленные логи и показывает историю,
 * которая уже лежит на диске.
 *
 *   npm run scan            — найти игру автоматически
 *   npm run scan -- <путь>  — указать папку Logs вручную
 */
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import {
  confidenceLabel,
  formatDateTime,
  formatDuration,
  formatNumber,
} from '../core/format.js';
import { findLogDirectory } from '../core/locate.js';
import { pluralize, RUN } from '../core/plural.js';
import { retroScan, runCost, runValue } from '../core/retroScan.js';
import { perHour, summarize } from '../core/stats.js';
import { FE_ID, type ConfigBaseId } from '../core/types.js';
import { Storage } from '../storage/db.js';

interface ItemRow {
  id: number;
  name: string;
  type: string;
}

function loadItems(): Map<ConfigBaseId, ItemRow> {
  const out = new Map<ConfigBaseId, ItemRow>();
  try {
    for (const it of JSON.parse(readFileSync(resolve('data/items.json'), 'utf8')) as ItemRow[]) {
      out.set(Number(it.id), it);
    }
  } catch {
    /* справочник необязателен */
  }
  return out;
}

async function main(): Promise<void> {
  const dir = process.argv[2] ?? findLogDirectory();
  if (!dir) {
    console.error('Не нашёл папку с логами Torchlight: Infinite.');
    console.error('Укажите её вручную: npm run scan -- "<путь до Saved\\Logs>"');
    process.exit(1);
  }

  const items = loadItems();
  console.log(`Папка логов: ${dir}\n`);

  const result = await retroScan(dir, (p) => {
    console.log(`  [${p.index + 1}/${p.total}] ${basename(p.file)}`);
  });

  result.prices.registerKnownItems(items.keys());
  const priceOf = (id: ConfigBaseId) => result.prices.priceOf(id);

  const farming = result.runs.filter((r) => !r.isHub && (r.durationMs ?? 0) > 5000);
  const inMapMs = farming.reduce((a, r) => a + (r.durationMs ?? 0), 0);

  console.log('\n═══ ОХВАТ ═══');
  console.log(`  файлов           ${result.filesScanned}`);
  console.log(`  строк            ${formatNumber(result.linesScanned)}`);
  console.log(`  сезоны           ${[...result.seasonIds].join(', ') || 'не определены'}`);
  console.log(`  забегов          ${result.runs.length}, из них фарм ${farming.length}`);
  console.log(`  времени в картах ${formatDuration(inMapMs)}`);
  console.log(`  разобрано за     ${formatDuration(result.elapsedMs)}`);

  console.log('\n═══ ЦЕНЫ ═══');
  console.log(`  предметов с ценой ${result.prices.size}`);
  for (const p of result.prices.all().sort((a, b) => b.fe - a.fe).slice(0, 12)) {
    const name = items.get(p.configBaseId)?.name ?? `id ${p.configBaseId}`;
    console.log(
      `  ${name.padEnd(34)} ${formatNumber(p.fe, 2).padStart(9)} ФЕ  ` +
        `(медиана ${formatNumber(p.median, 2)}, лотов ${p.sampleSize})`,
    );
  }

  if (farming.length > 0) {
    const feRates = farming.map((r) => {
      const fe = r.drops
        .filter((d) => d.configBaseId === FE_ID)
        .reduce((a, d) => a + d.qty, 0);
      return perHour(fe, r.durationMs ?? 0);
    });
    const valueRates = farming.map((r) =>
      perHour(runValue(r, priceOf) - runCost(r, priceOf), r.durationMs ?? 0),
    );

    const feStats = summarize(feRates);
    const valueStats = summarize(valueRates);

    console.log('\n═══ ЭФФЕКТИВНОСТЬ ═══');
    console.log('  Чистый ФЕ (только сама валюта)');
    console.log(
      `    медиана ${formatNumber(feStats.median)} ФЕ/час · ` +
        `среднее ${formatNumber(feStats.mean)} · ` +
        `P25–P75 ${formatNumber(feStats.p25)}–${formatNumber(feStats.p75)}`,
    );
    console.log('  Вся добыча по бумажной оценке, за вычетом вложений');
    console.log(
      `    медиана ${formatNumber(valueStats.median)} ФЕ/час · ` +
        `среднее ${formatNumber(valueStats.mean)} · ` +
        `P25–P75 ${formatNumber(valueStats.p25)}–${formatNumber(valueStats.p75)}`,
    );
    console.log(
      `  выборка ${pluralize(feStats.sampleSize, RUN)} (${confidenceLabel(feStats.confidence)})`,
    );
    if (valueStats.topShare > 0.3) {
      console.log(
        `  ⚠ один забег дал ${Math.round(valueStats.topShare * 100)}% всей добычи`,
      );
    }
  }

  const realized = result.trade.summarize(priceOf);
  console.log('\n═══ БИРЖА ═══');
  console.log(`  выставлено лотов  ${realized.listings}`);
  console.log(`  получено выплат   ${realized.receipts}`);
  console.log(`  реально пришло    ${formatNumber(realized.realizedFe)} ФЕ`);
  console.log(`  бумажная оценка   ${formatNumber(realized.paperFe)} ФЕ`);
  if (realized.ratio !== null) {
    console.log(`  коэффициент реализации ${(realized.ratio * 100).toFixed(0)}%`);
    console.log(
      '  (сколько реально пришло от того, во что оценивался выставленный товар)',
    );
  }
  if (realized.unpricedItems.length > 0) {
    console.log(`  ⚠ без цены ${realized.unpricedItems.length} видов выставленного товара —`);
    console.log('    бумажная оценка занижена. Пробей их на бирже.');
    for (const id of realized.unpricedItems.slice(0, 8)) {
      console.log(`      ${items.get(id)?.name ?? `id ${id}`}`);
    }
  }

  if (result.runs.length > 0) {
    const first = result.runs[0]!;
    const last = result.runs[result.runs.length - 1]!;
    console.log('\n═══ ПЕРИОД ═══');
    console.log(`  ${formatDateTime(first.startedAt)} — ${formatDateTime(last.startedAt)}`);
  }

  console.log('\n═══ САМОДИАГНОСТИКА ═══');
  if (result.unknownProtos.size === 0) {
    console.log('  неизвестных протоколов нет');
  } else {
    for (const [proto, n] of result.unknownProtos) console.log(`  ${proto} × ${n}`);
  }
  for (const f of result.failed) {
    console.log(`  ⚠ не прочитан ${basename(f.path)}: ${f.reason}`);
  }

  // Логи ротируются и удаляются игрой, поэтому разобранное сохраняем к себе.
  const storage = new Storage(resolve('data/gorn.db'));
  const seasonId = [...result.seasonIds][0] ?? null;
  storage.saveRuns(result.runs, seasonId);
  storage.savePrices(result.prices.all());
  storage.saveTrade(result.trade.listings, result.trade.receipts);

  const counts = storage.counts();
  console.log('\n═══ СОХРАНЕНО ═══');
  console.log(`  база              data/gorn.db`);
  console.log(`  забегов           ${counts.runs} (фарм ${counts.farmingRuns})`);
  console.log(`  записей о дропе   ${counts.drops}`);
  console.log(`  предметов с ценой ${counts.prices}`);
  console.log(`  лотов / выплат    ${counts.listings} / ${counts.receipts}`);
  console.log(`  выручка за всё время ${formatNumber(storage.realizedFe())} ФЕ`);
  storage.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
