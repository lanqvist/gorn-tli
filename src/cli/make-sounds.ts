/**
 * Генератор звуков: рендерит все ступени и варианты из src/sfx/kit.ts
 * в WAV и кладёт в src/renderer/assets/sfx — оттуда их встраивает сборка.
 *
 *   npm run sounds
 *
 * Звуки — наши собственные: каждый собран из синусов, шума и фильтров,
 * без сэмплов из игр и библиотек и без чьих-либо записей на входе.
 * Файлы лежат в репозитории (стерео, 16 бит, 24 кГц), так что сборке
 * генератор не нужен; запускать его — только после правки рецептов.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { measureStereo, toWavStereo } from '../sfx/dsp.js';
import { TIERS, VARIANTS, assetName, renderSound } from '../sfx/kit.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../renderer/assets/sfx');
mkdirSync(outDir, { recursive: true });
// Старые варианты убираем: рецепт мог сократить их число.
for (const file of readdirSync(outDir)) {
  if (file.endsWith('.wav')) rmSync(join(outDir, file));
}

let totalBytes = 0;
for (const tier of TIERS) {
  for (let v = 0; v < VARIANTS[tier]; v++) {
    const sig = renderSound(tier, v);
    const wav = toWavStereo(sig);
    writeFileSync(join(outDir, assetName(tier, v)), wav);
    totalBytes += wav.length;
    const m = measureStereo(sig);
    console.log(
      `${assetName(tier, v).padEnd(18)} ${m.durationSec.toFixed(2)} с  пик ${m.peakDb.toFixed(1)} дБ  громкость ${m.rmsDb.toFixed(1)} дБ  энергия ${m.energyDb.toFixed(1)} дБ`,
    );
  }
}
console.log(`итого ${(totalBytes / 1024).toFixed(0)} КБ → ${outDir}`);
