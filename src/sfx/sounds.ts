/**
 * Звуки Горна — «Кузня»: три звука, и только на то, что стоит услышать.
 *
 *  - «возвышение» — предмет дороже первого порога (по умолчанию 5 ФЕ):
 *    рык саба, звенящая вспышка, металлическое тело — партитура звука
 *    сферы возвышения, тембр кузни;
 *  - «дивайн» — предмет дороже второго порога (по умолчанию 20 ФЕ)
 *    и золотая находка: вздох мехов, удар, в центре загорается тон,
 *    просадка, тёмный хвост — партитура звука дивайна;
 *  - «рекорд» — «Пламя»: рык саба, вспышка пламени, низкое тяжёлое тело.
 *
 * Подбор и итог карты молчат: звук — только событие, а не фон.
 *
 * От эталонов взято исполнение (фазы, баланс полос, ширина), а не тембр:
 * всё синтезировано с нуля (src/sfx/hybrid.ts) и прошло премиум-цепочку
 * (src/sfx/premium.ts): компрессия, лента, гладкий воздух. Громкость —
 * по слуху, а не по мощности: в этих звуках много баса, который мощность
 * добавляет, а громкости почти нет.
 */
import { masterStereo, measureStereo, rng, seedOf, withRate, type Stereo } from './dsp.js';
import { filterStereo } from './fx.js';
import { flame, forgeDivine, forgeExalted } from './hybrid.js';
import { bigPolish } from './premium.js';

export type Sound = 'exalted' | 'divine' | 'record';

export const SOUNDS: readonly Sound[] = ['exalted', 'divine', 'record'];

/** Вариантов у частого «возвышения» два — повторы не одинаковы; редким хватает одного. */
export const VARIANTS: Record<Sound, number> = { exalted: 2, divine: 1, record: 1 };

/** Частота ассетов: воздуху и вспышкам нужен верх до ~16 кГц. */
export const ASSET_RATE = 48000;

/**
 * Слышимая громкость, дБ — как у прежних звуков той же роли («Подпись»):
 * возвышение — как свист, дивайн — как золотая находка, рекорд — как рекорд.
 * Так лестница сохраняет выверенные пропорции.
 */
export const HEARD: Record<Sound, number> = { exalted: -23.3, divine: -21.4, record: -20.1 };

/** Потолок пиков: запас до клиппинга, когда звуки накладываются на шине. */
export const CEILING_DB = -3;

/**
 * Слышимая громкость: максимум мощности в окне 50 мс после среза ниже
 * ~250 Гц (2-й порядок, Q 0.5) — грубая A-кривая: на 100 Гц −17 дБ,
 * на 200 Гц −8, на 500 Гц −2, как у слуха на тихих UI-звуках.
 */
export const heardDb = (st: Stereo): number => measureStereo(filterStereo(st, 'highpass', 250, 0.5)).rmsDb;

function recipe(sound: Sound, r: () => number): Stereo {
  switch (sound) {
    case 'exalted':
      return forgeExalted(r);
    case 'divine':
      return forgeDivine(r);
    case 'record':
      return flame(r, 'record');
  }
}

/** Готовый ассет: рецепт со своим сидом, премиум-цепочка, громкость по слуху, пики под потолок. */
export function renderSound(sound: Sound, variant: number): Stereo {
  return withRate(ASSET_RATE, () => {
    const st = bigPolish(recipe(sound, rng(seedOf(`forge:${sound}:${variant}`))));
    const target = measureStereo(st).rmsDb + HEARD[sound] - heardDb(st);
    return masterStereo(st, target, CEILING_DB, 16000);
  });
}

/** Замеры ассета на его частоте: пик, громкость, слышимая громкость, длина. */
export function measureSound(st: Stereo): { peakDb: number; rmsDb: number; heardDb: number; durationSec: number } {
  return withRate(ASSET_RATE, () => ({ ...measureStereo(st), heardDb: heardDb(st) }));
}

/** Имя файла ассета: так его находит генератор и src/renderer/overlay/sound.ts. */
export const assetName = (sound: Sound, variant: number): string => `${sound}-${variant + 1}.wav`;
