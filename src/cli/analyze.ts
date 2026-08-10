/**
 * Разбор существующего UE_game.log из командной строки.
 *
 * Это проверочный инструмент этапа 1: он доказывает, что данные извлекаются
 * корректно, до того как поверх них строится интерфейс.
 *
 *   npm run analyze -- "<путь к UE_game.log>"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { analyzeLogFile } from '../core/pipeline.js';
import {
  confidenceLabel,
  formatDateTime,
  formatDuration,
  formatNumber,
} from '../core/format.js';
import { pluralize, RUN } from '../core/plural.js';
import { perHour, summarize } from '../core/stats.js';
import { FE_ID, type ConfigBaseId, type Run } from '../core/types.js';

interface ItemInfo {
  name: string;
  type: string;
}

function loadItems(): Map<ConfigBaseId, ItemInfo> {
  const out = new Map<ConfigBaseId, ItemInfo>();
  try {
    const raw = readFileSync(resolve('data/items.json'), 'utf8');
    for (const it of JSON.parse(raw) as Array<{
      id: string | number;
      name: string;
      type: string;
    }>) {
      out.set(Number(it.id), { name: it.name, type: it.type });
    }
  } catch {
    // Справочник необязателен: без него показываем сырые id.
  }
  return out;
}

function feGained(run: Run): number {
  let fe = 0;
  for (const d of run.drops) if (d.configBaseId === FE_ID) fe += d.qty;
  return fe;
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error('Укажите путь к UE_game.log');
    process.exit(1);
  }

  const items = loadItems();
  const started = Date.now();
  const result = await analyzeLogFile(path);
  const elapsed = Date.now() - started;

  const farming = result.runs.filter((r) => !r.isHub && r.durationMs !== null);
  const inMapMs = farming.reduce((a, r) => a + (r.durationMs ?? 0), 0);
  const totalFe = farming.reduce((a, r) => a + feGained(r), 0);

  console.log('═══ ЛОГ ═══');
  console.log(`  файл             ${path}`);
  console.log(`  строк            ${formatNumber(result.diagnostics.linesTotal)}`);
  console.log(`  распознано       ${formatNumber(result.diagnostics.linesMatched)}`);
  console.log(`  сезон            ${result.seasonId ?? 'не определён'}`);
  if (result.firstTs && result.lastTs) {
    console.log(
      `  период           ${formatDateTime(result.firstTs)} — ${formatDateTime(result.lastTs)}`,
    );
  }
  console.log(`  разобрано за     ${formatDuration(elapsed)}`);

  console.log('\n═══ ЗАБЕГИ ═══');
  console.log(`  всего зон        ${result.runs.length}`);
  console.log(`  из них фарм      ${farming.length}`);
  console.log(`  времени на картах ${formatDuration(inMapMs)}`);
  console.log(`  получено ФЕ      ${formatNumber(totalFe)}`);

  if (farming.length > 0) {
    const rates = farming
      .filter((r) => (r.durationMs ?? 0) > 5000)
      .map((r) => perHour(feGained(r), r.durationMs ?? 0));
    const s = summarize(rates);
    console.log('\n═══ ФЕ В ЧАС ═══');
    console.log(`  медиана          ${formatNumber(s.median)} ФЕ/час`);
    console.log(`  среднее          ${formatNumber(s.mean)} ФЕ/час`);
    console.log(`  разброс P25–P75  ${formatNumber(s.p25)} — ${formatNumber(s.p75)}`);
    console.log(
      `  выборка          ${pluralize(s.sampleSize, RUN)} (${confidenceLabel(s.confidence)})`,
    );
    if (s.topShare > 0.3) {
      console.log(
        `  ⚠ один забег дал ${Math.round(s.topShare * 100)}% всего дохода — цифра держится на нём`,
      );
    }

    console.log('\n═══ ПОСЛЕДНИЕ ЗАБЕГИ ═══');
    for (const r of farming.slice(-12)) {
      const fe = feGained(r);
      const name = (r.asset ?? `зона ${r.areaId}`).padEnd(26);
      console.log(
        `  ${formatDateTime(r.startedAt)}  ${name} ` +
          `${formatDuration(r.durationMs ?? 0).padStart(9)}  ` +
          `${formatNumber(fe).padStart(6)} ФЕ  предметов: ${r.drops.length}`,
      );
    }
  }

  const totals = new Map<ConfigBaseId, number>();
  for (const r of result.runs) {
    for (const d of r.drops) {
      totals.set(d.configBaseId, (totals.get(d.configBaseId) ?? 0) + d.qty);
    }
  }
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  if (top.length > 0) {
    console.log('\n═══ ЧТО НАПАДАЛО ═══');
    for (const [id, qty] of top) {
      const info = items.get(id);
      const label = info ? `${info.name} [${info.type}]` : `id ${id}`;
      console.log(`  ${formatNumber(qty).padStart(7)} × ${label}`);
    }
  }

  if (result.prices.length > 0) {
    console.log('\n═══ ПРОБИВКИ ЦЕН НА БИРЖЕ ═══');
    for (const p of result.prices.slice(0, 10)) {
      const info = items.get(p.configBaseId);
      const sorted = [...p.unitPrices].sort((a, b) => a - b);
      const p10 = sorted[Math.floor(sorted.length * 0.1)] ?? sorted[0]!;
      console.log(
        `  ${(info?.name ?? `id ${p.configBaseId}`).padEnd(30)} ` +
          `лотов: ${String(p.unitPrices.length).padStart(3)}  ` +
          `референс (P10): ${formatNumber(p10, 2)} ФЕ`,
      );
    }
  }

  console.log('\n═══ САМОДИАГНОСТИКА ═══');
  console.log(`  перебазирований слотов  ${result.diagnostics.slotRebases}`);
  if (result.diagnostics.unknownProtos.size > 0) {
    console.log('  неизвестные протоколы:');
    for (const [proto, n] of result.diagnostics.unknownProtos) {
      console.log(`    ${proto} × ${n}`);
    }
  } else {
    console.log('  неизвестных протоколов нет');
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
