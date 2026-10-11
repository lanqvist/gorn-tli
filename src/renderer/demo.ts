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
  priceSource: 'own' | 'community' | null = unitFe === null ? null : 'own',
) => ({
  configBaseId,
  name,
  icon,
  qty,
  unitFe,
  totalFe: unitFe === null ? null : unitFe * qty,
  priceSource,
});

export const demoSnapshot: Snapshot = {
  status: 'running',
  hint: null,
  lastActivityAt: now - 4_000,
  logDir:
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Torchlight Infinite\\UE_game\\TorchLight\\Saved\\Logs',
  seasonId: 1501,
  player: {
    playerId: '956082728577617920',
    name: 'VLPZDC',
    heroName: 'Селена',
    level: 85,
  },
  session: {
    startedAt: now - 3 * 3_600_000,
    previous: { netFe: 3240, inMapMs: 2 * 3_600_000 + 10 * 60_000, runs: 14 },
  },
  players: [
    {
      playerId: '956082728577617920',
      name: 'VLPZDC',
      heroName: 'Селена',
      level: 85,
      runs: 23,
    },
    {
      playerId: '947836609175392256',
      name: 'VLPZDC',
      heroName: 'Герой 1200',
      level: 62,
      runs: 8,
    },
  ],
  playerFilter: null,
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
  // Забегов достаточно много, чтобы жили спарклайн (от 5) и гистограмма
  // (от 8); числа — правдоподобное распределение с одним выбросом.
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
      drops: [
        drop(200028, 'Precious Ember', 1, 6.4),
        drop(5028, 'Netherrealm resonance', 1, 3.1),
      ],
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
      drops: [drop(10022, 'Soldier Compass', 1, 34)],
    },
    ...[612, 388, 947, 254, 1_104, 486, 771, 903, 162, 655, 1_418, 530].map(
      (perHour, i) => ({
        areaId: 5348 + (i % 3),
        name: ['MaNeiLaYuLin', 'YiWangMiDian', 'XiDiChongGu'][i % 3]!,
        startedAt: now - 1_500_000 - i * 420_000,
        durationMs: 60_000 + (i % 4) * 25_000,
        feGained: Math.round(perHour / 40),
        valueFe: Math.round(perHour / 28),
        costFe: 34,
        netFe: Math.round(perHour / 36),
        perHour,
        drops: [],
      }),
    ),
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
    listedPaperFe: 717,
  },
  liveRate: 786,
  norm: 702,
  jackpotAutoFe: 42,
  strategies: [
    {
      key: '10022+400000',
      title: 'Soldier Compass + Glacial Abyss Beacon (Timemark 1)',
      costItems: [
        { configBaseId: 10022, name: 'Soldier Compass', icon: null },
        { configBaseId: 400000, name: 'Glacial Abyss Beacon (Timemark 1)', icon: null },
      ],
      runs: 14,
      rate: {
        median: 918,
        mean: 1_104,
        p25: 640,
        p75: 1_310,
        sampleSize: 14,
        confidence: 'insufficient',
        topShare: 0.22,
      },
      costPerRun: 41,
      netPerRun: 23,
      totalActiveMs: 21 * 60_000,
    },
    {
      key: 'none',
      title: 'Без вложений',
      costItems: [],
      runs: 9,
      rate: {
        median: 412,
        mean: 455,
        p25: 300,
        p75: 560,
        sampleSize: 9,
        confidence: 'insufficient',
        topShare: 0.19,
      },
      costPerRun: 0,
      netPerRun: 9,
      totalActiveMs: 13 * 60_000,
    },
  ],
  missing: [
    {
      configBaseId: 400033,
      name: 'Voidlands Beacon (Timemark 8)',
      icon: null,
      qty: 14,
      runs: 14,
      isCost: true,
    },
    { configBaseId: 100200, name: 'Flame Sand', icon: null, qty: 234, runs: 12, isCost: false },
    {
      configBaseId: 200028,
      name: 'Precious Ember',
      icon: null,
      qty: 15,
      runs: 7,
      isCost: false,
    },
  ],
  diagnostics: {
    unknownProtos: [],
    pricedItems: 58,
    unpricedDrops: 3,
    communityPrices: 2154,
    communityEnabled: true,
    communityFetchedAt: now - 4 * 60_000,
    communityStale: false,
  },
};
