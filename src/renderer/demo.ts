import type { Snapshot } from '../main/engine.js';

/**
 * Демонстрационный срез для разработки интерфейса в браузере,
 * где нет main-процесса. В сборку не попадает: подключается только
 * под `import.meta.env.DEV` и при отсутствии window.gorn.
 *
 * Числа взяты из реальных замеров по логам, а не выдуманы,
 * чтобы вёрстка проверялась на правдоподобных величинах.
 */
const now = Date.now();

/**
 * В приложении иконки приходят по схеме gorn-icon:// из локального кэша,
 * но в браузере её нет — для демо берём исходные адреса, чтобы вёрстку
 * с иконками можно было проверять.
 */
const CDN = 'https://cdn.tlidb.com/UI/Textures/Common/Icon';

const drop = (
  configBaseId: number,
  name: string,
  qty: number,
  unitFe: number | null,
  icon: string | null = null,
) => ({
  configBaseId,
  name,
  icon,
  qty,
  unitFe,
  totalFe: unitFe === null ? null : unitFe * qty,
});

export const demoSnapshot: Snapshot = {
  status: 'running',
  hint: null,
  seasonId: 1501,
  current: {
    areaId: 5348,
    name: 'MaNeiLaYuLin',
    startedAt: now - 96_000,
    durationMs: null,
    feGained: 3,
    valueFe: 55.3,
    costFe: 34,
    netFe: 21.3,
    perHour: 799,
    drops: [
      drop(10022, 'Soldier Compass', 1, 34, `${CDN}/Compass/128/UI_Compass_MonsterNormal_1_1_Icon_128.webp`),
      drop(200028, 'Precious Ember', 2, 6.4, `${CDN}/Ash/128/UI_Ash_20StonelowYOUZHI_Icon_128.webp`),
      drop(5028, 'Netherrealm resonance', 1, 3.1, `${CDN}/Item/128/UI_Item_Echo_01_Icon_128.webp`),
      drop(100300, 'Flame Elementium', 3, 1, `${CDN}/Item/128/UI_Item_chuhuoyuanzhiV3_Icon_128.webp`),
      drop(100200, 'Flame Sand', 20, 0.12, `${CDN}/Item/128/UI_Item_chuhuolingshaV3_Icon_128.webp`),
      drop(261010, 'Неизвестный предмет', 1, null),
    ],
  },
  recent: [
    {
      areaId: 5348,
      name: 'MaNeiLaYuLin',
      startedAt: now - 400_000,
      durationMs: 84_000,
      feGained: 12,
      valueFe: 51,
      costFe: 34,
      netFe: 17,
      perHour: 729,
      drops: [],
    },
    {
      areaId: 5351,
      name: 'KuangReYuLin',
      startedAt: now - 700_000,
      durationMs: 47_000,
      feGained: 0,
      valueFe: 38,
      costFe: 34,
      netFe: 4,
      perHour: 306,
      drops: [],
    },
    {
      areaId: 5348,
      name: 'MaNeiLaYuLin',
      startedAt: now - 1_100_000,
      durationMs: 96_000,
      feGained: 44,
      valueFe: 121,
      costFe: 30,
      netFe: 91,
      perHour: 3_412,
      drops: [],
    },
  ],
  rate: {
    median: 702,
    mean: 913,
    p25: 388,
    p75: 1_104,
    sampleSize: 23,
    confidence: 'emerging',
    topShare: 0.34,
  },
  feRate: {
    median: 415,
    mean: 602,
    p25: 0,
    p75: 780,
    sampleSize: 23,
    confidence: 'emerging',
    topShare: 0.41,
  },
  totals: {
    runs: 23,
    inMapMs: 41 * 60_000,
    feGained: 508,
    valueFe: 1_180,
    costFe: 690,
    realizedFe: 508,
    realizationRatio: 0.71,
  },
  diagnostics: {
    unknownProtos: [],
    pricedItems: 58,
    unpricedDrops: 3,
  },
};
