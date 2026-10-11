import type { PriceRow, Snapshot } from '../main/engine.js';

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

/** Чем открывалась карта: компас плюс маяк — типичная стратегия. */
const compassCosts = [
  drop(10022, 'Soldier Compass', 1, 34),
  drop(400000, 'Glacial Abyss Beacon (Timemark 1)', 1, null),
];

const rateOf = (median: number, p25: number, p75: number, n: number) => ({
  median,
  mean: Math.round((p25 + median + p75) / 3),
  p25,
  p75,
  sampleSize: n,
  confidence: n >= 50 ? ('solid' as const) : n >= 15 ? ('emerging' as const) : ('insufficient' as const),
  topShare: 0.2,
});

const DAY = 86_400_000;
const today = new Date(now).setHours(0, 0, 0, 0);

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
    key: 'current',
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
    costs: compassCosts,
  },
  // Забегов достаточно много, чтобы жили спарклайн (от 5) и гистограмма
  // (от 8); числа — правдоподобное распределение с одним выбросом.
  recent: [
    {
      key: 'r1',
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
      costs: compassCosts,
    },
    {
      key: 'r2',
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
      costs: compassCosts,
    },
    {
      key: 'r3',
      areaId: 5348,
      name: 'MaNeiLaYuLin',
      startedAt: now - 1_100_000,
      durationMs: 96_000,
      feGained: 44,
      valueFe: 121,
      costFe: 30,
      netFe: 91,
      perHour: 3_412,
      drops: [drop(10022, 'Soldier Compass', 1, 34), drop(100300, 'Flame Elementium', 44, 1)],
      costs: compassCosts,
    },
    ...[612, 388, 947, 254, 1_104, 486, 771, 903, 162, 655, 1_418, 530].map(
      (perHour, i) => ({
        key: `r${i + 4}`,
        areaId: 5348 + (i % 3),
        name: ['MaNeiLaYuLin', 'YiWangMiDian', 'XiDiChongGu'][i % 3]!,
        startedAt: now - 1_500_000 - i * 420_000,
        durationMs: 60_000 + (i % 4) * 25_000,
        feGained: Math.round(perHour / 40),
        valueFe: Math.round(perHour / 28),
        costFe: 34,
        netFe: Math.round(perHour / 36),
        perHour,
        drops: [drop(100300, 'Flame Elementium', Math.round(perHour / 40), 1)],
        costs: i % 2 === 0 ? compassCosts : [],
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
  maps: [
    {
      name: 'MaNeiLaYuLin',
      runs: 11,
      rate: rateOf(771, 612, 1_104, 11),
      netPerRun: 27,
      avgActiveMs: 95_000,
      totalActiveMs: 11 * 95_000,
    },
    {
      name: 'YiWangMiDian',
      runs: 6,
      rate: rateOf(903, 388, 1_418, 6),
      netPerRun: 24,
      avgActiveMs: 88_000,
      totalActiveMs: 6 * 88_000,
    },
    {
      name: 'XiDiChongGu',
      runs: 5,
      rate: rateOf(486, 162, 947, 5),
      netPerRun: 13,
      avgActiveMs: 92_000,
      totalActiveMs: 5 * 92_000,
    },
    {
      name: 'KuangReYuLin',
      runs: 1,
      rate: rateOf(306, 306, 306, 1),
      netPerRun: 4,
      avgActiveMs: 47_000,
      totalActiveMs: 47_000,
    },
  ],
  // Две недели: пара пропусков и один удачный вечер.
  days: [0, 0, 1_850, 2_400, 0, 3_100, 2_200, 900, 0, 4_300, 2_750, 3_240, 1_980, 1_180].map(
    (netFe, i) => ({
      day: today - (13 - i) * DAY,
      runs: Math.round(netFe / 24),
      netFe,
      inMapMs: Math.round((netFe / 820) * 3_600_000),
    }),
  ),
  sessions: [
    {
      startedAt: now - 3 * 3_600_000,
      endedAt: null,
      runs: 23,
      netFe: 1_180 - 690,
      inMapMs: 41 * 60_000,
    },
    {
      startedAt: now - 28 * 3_600_000,
      endedAt: now - 25 * 3_600_000,
      runs: 14,
      netFe: 3_240,
      inMapMs: 2 * 3_600_000 + 10 * 60_000,
    },
    {
      startedAt: now - 3 * DAY,
      endedAt: now - 3 * DAY + 4 * 3_600_000,
      runs: 31,
      netFe: 4_300,
      inMapMs: 3 * 3_600_000 + 25 * 60_000,
    },
  ],
  bag: {
    valueFe: 9_840,
    feCash: 6_655,
    unpriced: 4,
    top: [
      { configBaseId: 10022, name: 'Soldier Compass', icon: `${CDN}/Compass/128/UI_Compass_MonsterNormal_1_1_Icon_128.webp`, qty: 38, totalFe: 1_292 },
      { configBaseId: 200028, name: 'Precious Ember', icon: `${CDN}/Ash/128/UI_Ash_20StonelowYOUZHI_Icon_128.webp`, qty: 96, totalFe: 614 },
      { configBaseId: 5028, name: 'Netherrealm resonance', icon: `${CDN}/Item/128/UI_Item_Echo_01_Icon_128.webp`, qty: 140, totalFe: 434 },
      { configBaseId: 100200, name: 'Flame Sand', icon: `${CDN}/Item/128/UI_Item_chuhuolingshaV3_Icon_128.webp`, qty: 2_100, totalFe: 252 },
    ],
  },
  minDropFe: 0,
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

/** Строки блока «Цены» для браузерного демо: тренды из правдоподобных пробивок. */
const series = (base: number, steps: number[]) =>
  steps.map((k, i) => ({ t: now - (steps.length - 1 - i) * 2 * 86_400_000, fe: base * k }));

const priceRow = (
  configBaseId: number,
  name: string,
  fe: number | null,
  source: PriceRow['source'],
  steps: number[],
  seenQty: number,
  icon: string | null = null,
): PriceRow => {
  const points = fe === null ? [] : series(fe / steps.at(-1)!, steps);
  const ref = points.find((p) => p.t >= now - 7 * 86_400_000);
  return {
    configBaseId,
    name,
    icon,
    fe,
    source,
    ownObservedAt: source === 'own' && points.length > 0 ? points.at(-1)!.t : null,
    trend: {
      points,
      change: ref && points.length > 1 && ref !== points.at(-1) ? fe! / ref.fe - 1 : null,
    },
    seenQty,
  };
};

export const demoPrices: PriceRow[] = [
  priceRow(400033, 'Voidlands Beacon (Timemark 8)', 0, 'excluded', [], 14),
  priceRow(10022, 'Soldier Compass', 34, 'own', [1.1, 1.05, 1, 0.97, 0.95, 0.92, 0.9, 1], 38,
    `${CDN}/Compass/128/UI_Compass_MonsterNormal_1_1_Icon_128.webp`),
  priceRow(200028, 'Precious Ember', 6.4, 'own', [0.8, 0.85, 0.9, 1, 1.05, 1.1, 1.2], 96,
    `${CDN}/Ash/128/UI_Ash_20StonelowYOUZHI_Icon_128.webp`),
  priceRow(5028, 'Netherrealm resonance', 3.1, 'community', [1], 140,
    `${CDN}/Item/128/UI_Item_Echo_01_Icon_128.webp`),
  priceRow(100200, 'Flame Sand', 0.12, 'own', [1, 1], 2_100,
    `${CDN}/Item/128/UI_Item_chuhuolingshaV3_Icon_128.webp`),
  priceRow(261010, 'Неизвестный предмет', null, null, [], 1),
];
