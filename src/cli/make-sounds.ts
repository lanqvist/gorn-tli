/**
 * Генератор звуков: рендерит звуки «Кузни» из src/sfx/sounds.ts в WAV
 * и кладёт в src/renderer/assets/sfx — оттуда их встраивает сборка.
 *
 *   npm run sounds
 *
 * Звуки — наши собственные: каждый собран из синусов, шума и фильтров,
 * без сэмплов из игр и библиотек и без чьих-либо записей на входе.
 * Файлы лежат в репозитории (стерео, 16 бит, 48 кГц), так что сборке
 * генератор не нужен; запускать его — только после правки рецептов.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toWavStereo } from '../sfx/dsp.js';
import { ASSET_RATE, SOUNDS, VARIANTS, assetName, measureSound, renderSound } from '../sfx/sounds.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../renderer/assets/sfx');
mkdirSync(outDir, { recursive: true });
// Старые файлы убираем: набор звуков мог смениться целиком.
for (const file of readdirSync(outDir)) {
  if (file.endsWith('.wav')) rmSync(join(outDir, file));
}

let totalBytes = 0;
for (const sound of SOUNDS) {
  for (let v = 0; v < VARIANTS[sound]; v++) {
    const sig = renderSound(sound, v);
    const wav = toWavStereo(sig, ASSET_RATE);
    writeFileSync(join(outDir, assetName(sound, v)), wav);
    totalBytes += wav.length;
    const m = measureSound(sig);
    console.log(
      `${assetName(sound, v).padEnd(14)} ${m.durationSec.toFixed(2)} с  пик ${m.peakDb.toFixed(1)} дБ  громкость ${m.rmsDb.toFixed(1)} дБ  на слух ${m.heardDb.toFixed(1)} дБ`,
    );
  }
}
console.log(`итого ${(totalBytes / 1024).toFixed(0)} КБ → ${outDir}`);
