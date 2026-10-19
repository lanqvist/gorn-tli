/**
 * Премиум-звуки Горна.
 *
 * Прошлые подборы звучали «дёшево»: битовое урезание (ассоциация
 * с 8-битными игрушками), статичные идеальные генераторы, срезанный
 * на 4–5 кГц верх («как из телефона»), голые шумовые щелчки без
 * материала и ни компрессии, ни насыщения, ни воздуха. Здесь наоборот:
 *  - аналоговые генераторы с дрейфом и случайной фазой, лестничный
 *    фильтр с мягким резонансом;
 *  - удары — возбуждение через резонаторы материала (пластик, металл,
 *    кожа), транзиент раздвинут микро-Haas, тон в центре;
 *  - мастер-цепочка: компрессия склеивает слои, лента даёт тёплые
 *    гармоники, эксайтер — гладкий воздух, короткая пластина.
 *
 * Мягкие версии подбора: резкость премиума давал пик атаки — на
 * 11.5–15.8 дБ выше средней громкости (у прежнего мягкого подбора
 * приложения 6.7 дБ). У мягких удар материала тише и темнее,
 * фильтр щипка стартует ниже, атака сглажена, пики прижаты.
 *
 * Премиум-лестница — все ступени на той же цепочке: подбор, ценный
 * подбор, свист (тот же пресет «Подписи» с объёмом), джекпот и стрик
 * («Пламя» поменьше), рекорд «Пламя», итог карты и минус.
 */
import { SR, StereoMix, biquad, noise, osc, type Signal, type Stereo } from './dsp.js';
import {
  air,
  analog,
  compress,
  filterStereo,
  glow,
  haas,
  hz,
  impulse,
  ladder,
  resonate,
  smooth,
  tape,
  type Res,
} from './fx.js';
import { flame, softBass, type Tap } from './hybrid.js';
import { rawSound, renderSound, type Tier } from './kit.js';
import { Scene, finish, type Concept, type Proto, type Space } from './scene.js';

type Random = () => number;

function shape(sig: Signal, env: (t: number) => number): Signal {
  for (let i = 0; i < sig.length; i++) sig[i] = sig[i]! * env(i / SR);
  return sig;
}

const jit = (r: Random, x: number, amt = 0.04) => x * (1 + (r() - 0.5) * 2 * amt);

// ── материалы ───────────────────────────────────────────────────

const PLASTIC = (r: Random): Res[] => [
  [jit(r, 380), 8, 1],
  [jit(r, 1150), 10, 0.6],
  [jit(r, 2400), 12, 0.4],
  [jit(r, 5200), 14, 0.2],
];
const LEATHER = (r: Random): Res[] => [
  [jit(r, 150), 4, 1],
  [jit(r, 320), 5, 0.6],
  [jit(r, 640), 6, 0.35],
];
const MAGNET = (r: Random, k: number): Res[] => [
  [jit(r, 110 * k), 5, 1],
  [jit(r, 230 * k), 6, 0.7],
  [jit(r, 410 * k), 7, 0.5],
  [jit(r, 760 * k), 8, 0.3],
];
/** Металлическая пластина: моды 1 : 1.61 : 2.67 : 3.89 : 5.3; qk < 1 — глуше и короче. */
const PLATE = (f: number, qk = 1): Res[] =>
  ([[1, 60, 1], [1.61, 70, 0.7], [2.67, 80, 0.5], [3.89, 90, 0.35], [5.3, 90, 0.25]] as const).map(
    ([ratio, q, g]) => [f * ratio, q * qk, g] as const,
  );

// ── голоса ──────────────────────────────────────────────────────

/** Аналоговый щипок: две дрейфующие пилы через лестничный фильтр, который хлопает вниз. */
function pluckSynth(f: number, len: number, r: Random, o: { res?: number; from?: number; tau?: number; decay?: number } = {}): Signal {
  const from = o.from ?? 3800;
  const tau = o.tau ?? 0.045;
  const s = ladder(analog(f, len, r), (t) => 380 + from * Math.exp(-t / tau), o.res ?? 0.35, 1.4);
  // decay — доля длины, за которую тело тает в e раз: длиннее — мягче, не «ударно».
  return shape(s, (t) => smooth(t / 0.003) * Math.exp(-t / (len * (o.decay ?? 0.3))));
}

/** Удар материала: всплеск через резонаторы, раздвинутый микро-Haas; dark — срез верха удара. */
function knock(r: Random, bank: Res[], len = 0.002, side: 1 | -1 = 1, ms = 0.4, dark = 0): Stereo {
  const st = haas(resonate(impulse(r, len), bank, 0.25), ms, side);
  return dark > 0 ? filterStereo(filterStereo(st, 'lowpass', dark, 0.7), 'lowpass', dark, 0.7) : st;
}

/** Огонёк: полоса шума взлетает и опадает; peak — верхняя точка полосы. */
function flicker(r: Random, len = 0.14, peak = 1200): Stereo {
  const mix = new StereoMix(len);
  const band = (t: number) => 300 * Math.pow(peak / 300, Math.sin((Math.PI * Math.min(len, t)) / len));
  for (const side of [-1, 1] as const) {
    const n = biquad(noise(len, r), 'bandpass', band, 1);
    shape(n, (t) => smooth(t / 0.012) * Math.exp(-t / 0.04));
    mix.add(n, 0, 1, side * 0.6);
  }
  return mix.data;
}

/** FM-«зип» магнитного замка: гладкий, без урезания разрядности. */
function zip(f: number, len: number, index = 4, cut = 7000): Signal {
  const mod = osc('sine', f * 3.01, len);
  shape(mod, (t) => index * Math.exp(-t / 0.015));
  const car = osc('sine', f, len, mod);
  shape(car, (t) => smooth(t / 0.002) * Math.exp(-t / (len * 0.3)));
  return biquad(car, 'lowpass', cut, 0.7);
}

// ── мастер-цепочки ──────────────────────────────────────────────

const PREMIUM_SPACE: Space = {
  er: 0.18,
  erSize: 0.7,
  room: { size: 0.5, decay: 0.55, damp: 9000, predelay: 0.008, mod: 0.3, wet: 0.14 },
  width: 1.4,
};

type Polish = { drive?: number | undefined; air?: number | undefined };

/** Подбор, резкая версия: склейка, тёплая лента, гладкий воздух. */
const polish = (st: Stereo, o: Polish = {}): Stereo => air(tape(compress(st, 10, 3), o.drive ?? 1.3), o.air ?? 0.25);

/**
 * Мягкая цепочка: атака сглажена за 15 мс, пики прижаты быстрым
 * компрессором, лента деликатнее, верх выше 9 кГц убран, воздуха —
 * капля и только выше 4 кГц.
 */
function softPolish(st: Stereo, o: Polish = {}): Stereo {
  const soft = { l: shape(st.l, (t) => smooth(t / 0.015)), r: shape(st.r, (t) => smooth(t / 0.015)) };
  const glued = tape(compress(soft, 9, 6, 0.0008, 0.08), o.drive ?? 1.15);
  const dark = filterStereo(glued, 'lowpass', 9000, 0.7);
  return air(dark, o.air ?? 0.06, 4000);
}

/** Крупные ступени: мягкая склейка без сглаживания атаки — у них атака и есть событие. */
export const bigPolish = (st: Stereo): Stereo => air(tape(compress(st, 8, 2, 0.005, 0.12), 1.15), 0.1, 4000);

// ── подборы ─────────────────────────────────────────────────────

interface PremiumTap extends Tap {
  drive?: number;
  air?: number;
}

/** Пять подборов; soft — мягкая версия: удар тише и темнее, фильтр стартует ниже. */
function premiumTaps(soft: boolean): PremiumTap[] {
  const sb = soft ? { body: 0.6, attack: 0.015 } : {};
  const k = soft ? 0.55 : 1; // громкость удара материала
  const dark = soft ? 2200 : 0; // срез верха удара
  const ex = soft ? 2 : 1; // длина возбуждения — мягче «щелчок»
  const pl = soft ? { from: 1700, tau: 0.06, res: 0.25, decay: 0.5 } : {};
  const plRes = (res: number) => (soft ? { from: 1700, tau: 0.06, res: 0.3, decay: 0.5 } : { res });
  return [
    {
      id: 'shutter',
      label: 'Затвор',
      steps: [60, 62, 58, 63],
      make: (m, r) => {
        // Механика старой камеры — три сухих щелчка с телом пластика — и аналоговый щипок поверх.
        const t1 = 0.009 + r() * 0.005;
        const t2 = t1 + 0.011 + r() * 0.006;
        const sc = new Scene();
        ([[0, 1, 1], [t1, 0.55, -1], [t2, 0.35, 1]] as const).forEach(([at, g, side]) =>
          sc.add(knock(r, PLASTIC(r), 0.002 * ex, side, 0.4, dark), at, g * 0.6 * k, 0.4),
        );
        return sc.addMono(pluckSynth(hz(m), 0.22, r, pl), 0.006, 0.7, 0, 0.5).addMono(softBass(hz(m - 24), 0.22, sb), 0.006, 0.28);
      },
    },
    {
      id: 'chrome',
      label: 'Хром',
      steps: [67, 70, 65, 72],
      air: soft ? 0.08 : 0.3,
      make: (m, r) =>
        new Scene()
          .add(knock(r, PLATE(hz(m), soft ? 0.5 : 1), 0.003 * ex, 1, 0.3, soft ? 3000 : 0), 0, soft ? 0.45 : 0.9, 0.6)
          .addMono(glow(hz(m - 12), { swell: 0.005, hold: 0.01, decay: 0.16, depth: 0 }), 0, soft ? 0.55 : 0.4, 0, 0.5)
          .addMono(softBass(hz(m - 24), 0.22, sb), 0, 0.25),
    },
    {
      id: 'pulse',
      label: 'Импульс',
      steps: [60, 63, 58, 65],
      make: (m, r) =>
        new Scene()
          .add(knock(r, [[jit(r, soft ? 1500 : 2600), 6, 1]], 0.0015 * ex, r() < 0.5 ? 1 : -1, 0.4, dark), 0, 0.25 * k, 0.3)
          .addMono(pluckSynth(hz(m), 0.24, r, plRes(0.5)), 0, 0.75, -0.2, 0.5)
          .addMono(pluckSynth(hz(m + 7), 0.2, r, plRes(0.5)), 0.004, 0.45, 0.2, 0.5)
          .addMono(softBass(hz(m - 24), 0.24, sb), 0, 0.3),
    },
    {
      id: 'magnet',
      label: 'Магнит',
      steps: [67, 70, 65, 72],
      make: (m, r) => {
        const kk = 1 + (m - 67) * 0.02;
        return new Scene()
          .add(knock(r, MAGNET(r, kk), 0.005 * ex, 1, 0.3, dark), 0, soft ? 0.45 : 0.9, 0.3)
          .add(haas(zip(hz(m), 0.08, soft ? 2.2 : 4, soft ? 3500 : 7000), 0.5, r() < 0.5 ? 1 : -1), 0.01, soft ? 0.32 : 0.4, 0.5)
          .addMono(softBass(hz(m - 24), 0.22, sb), 0, 0.28);
      },
    },
    {
      id: 'ember',
      label: 'Огонёк Hi-Fi',
      steps: [60, 63, 58, 65],
      drive: soft ? 1.3 : 1.6,
      make: (m, r) =>
        new Scene()
          .add(flicker(r, 0.14, soft ? 800 : 1200), 0, soft ? 0.32 : 0.4, 0.4)
          .add(knock(r, LEATHER(r), 0.004 * ex, 1, 0.3, dark), 0, 0.6 * k, 0.3)
          .addMono(pluckSynth(hz(m), 0.24, r, { from: soft ? 1600 : 2500, tau: 0.08, decay: soft ? 0.5 : 0.3 }), 0.015, 0.7, -0.15, 0.6)
          .addMono(pluckSynth(hz(m + 7), 0.22, r, { from: soft ? 1600 : 2500, tau: 0.08, decay: soft ? 0.5 : 0.3 }), 0.02, 0.45, 0.15, 0.6)
          .addMono(softBass(hz(m - 24), 0.24, sb), 0.015, 0.33),
    },
  ];
}

export const PREMIUM_TAPS: readonly PremiumTap[] = premiumTaps(false);
export const SOFT_TAPS: readonly PremiumTap[] = premiumTaps(true);

const tapProtos = (taps: readonly PremiumTap[], prefix: string, soft: boolean): Proto[] =>
  taps.flatMap((tap) =>
    tap.steps.map((m, v) => ({
      id: `${prefix}-${tap.id}-${v + 1}`,
      label: `${tap.label} ${v + 1}`,
      tier: 'pickup' as const,
      render: (r: Random) => {
        const st = finish(tap.make(m, r), tap.space ?? PREMIUM_SPACE);
        const o = { drive: tap.drive, air: tap.air };
        return soft ? softPolish(st, o) : polish(st, o);
      },
    })),
  );

export const PREMIUM_KIT: Concept = {
  id: 'premium-kit',
  title: 'Премиум · подбор (резкий)',
  blurb:
    'Первая премиум-версия — громкая атака: удар материала яркий, фильтр щипка стартует с ~4 кГц, пик на 11–16 дБ выше средней громкости. Оставлена для A/B с мягкой.',
  color: '#7fe3ff',
  protos: tapProtos(PREMIUM_TAPS, 'prem-tap', false),
};

export const SOFT_KIT: Concept = {
  id: 'soft-kit',
  title: 'Премиум · подбор мягкий',
  blurb:
    'Те же пять направлений, мягко: удар материала тише и темнее (верх срезан у 2.2 кГц), фильтр щипка стартует с 1.7 кГц, атака сглажена за 15 мс, тело щипка и бас тают вдвое дольше — без «тумпа», пики прижаты быстрым компрессором, воздуха — капля. Цель — пик не выше ~9 дБ над громкостью, как у прежнего мягкого подбора.',
  color: '#9ff0d0',
  protos: tapProtos(SOFT_TAPS, 'prem-soft', true),
};

// ── премиум-лестница ────────────────────────────────────────────

const WHISTLE_SPACE: Space = {
  er: 0.3,
  erSize: 1.2,
  room: { size: 1.1, decay: 1.8, damp: 6000, predelay: 0.022, mod: 0.35, wet: 0.45 },
  width: 1.5,
};

/** Ценный подбор: мягкий подбор с весом — басом ниже, глухим ударом кожи и комнатой шире. */
function bigPickup(tap: PremiumTap, r: Random): Stereo {
  const m = tap.steps[0]!;
  const sc = tap.make(m, r);
  sc.addMono(softBass(hz(m - 24), 0.3), 0, 0.35).add(knock(r, LEATHER(r), 0.006, 1, 0.3, 1500), 0, 0.4, 0.4);
  const space: Space = { ...PREMIUM_SPACE, room: { size: 0.8, decay: 0.85, damp: 8000, predelay: 0.01, mod: 0.3, wet: 0.2 } };
  return softPolish(finish(sc, space), { drive: tap.drive, air: tap.air });
}

/** Итог карты: мягкий щипок соль → до с квинтой, под ним мягкий бас — спокойное «закрыто». */
function runEnd(r: Random): Stereo {
  const pl = { from: 1500, tau: 0.08, res: 0.25 };
  const sc = new Scene()
    .addMono(pluckSynth(hz(55), 0.35, r, pl), 0, 0.6, -0.15, 0.6)
    .addMono(pluckSynth(hz(60), 0.6, r, pl), 0.16, 0.8, 0, 0.6)
    .addMono(pluckSynth(hz(67), 0.5, r, pl), 0.17, 0.35, 0.2, 0.6)
    .addMono(softBass(hz(36), 0.6), 0.16, 0.45);
  return softPolish(finish(sc, { er: 0.2, room: { size: 0.8, decay: 1.2, damp: 6000, predelay: 0.01, mod: 0.3, wet: 0.3 }, width: 1.4 }));
}

/** Карта в минус: низкий щипок до проседает на полтона и глохнет, удар кожи, тёмный зал. */
function runLoss(r: Random): Stereo {
  const len = 0.6;
  const s = ladder(analog((t) => hz(48) * (1 - 0.06 * smooth(t / 0.35)), len, r), (t) => 300 + 1100 * Math.exp(-t / 0.08), 0.25, 1.3);
  shape(s, (t) => smooth(t / 0.004) * Math.exp(-t / (len * 0.35)));
  const sc = new Scene()
    .addMono(s, 0, 0.9, 0, 0.5)
    .add(knock(r, LEATHER(r), 0.006, 1, 0.3, 1200), 0, 0.4, 0.3)
    .addMono(softBass(hz(36), 0.5, { glide: 1.05 }), 0, 0.4);
  return softPolish(finish(sc, { er: 0.2, room: { size: 0.9, decay: 1, damp: 3500, predelay: 0.01, mod: 0.3, wet: 0.25 }, width: 1.3 }));
}

/** Стрик: джекпот «Пламени» и мягкая квинта-октава, вспыхивающая в теле. */
function jackpotHot(r: Random): Stereo {
  const base = flame(r, 'jackpot');
  const pl = { from: 1800, tau: 0.08, res: 0.25 };
  const add = new StereoMix(1)
    .add(pluckSynth(hz(67), 0.5, r, pl), 0.65, 0.12, -0.2)
    .add(pluckSynth(hz(72), 0.55, r, pl), 0.78, 0.1, 0.2).data;
  return bigPolish(new StereoMix(0.1).addStereo(base).addStereo(add).data);
}

const LADDER_TIERS: ReadonlyArray<readonly [Tier, string]> = [
  ['pickup', 'Подбор'],
  ['pickupBig', 'Ценный подбор'],
  ['whistle', 'Свист'],
  ['jackpot', 'Джекпот'],
  ['jackpotHot', 'Стрик'],
  ['record', 'Рекорд'],
  ['runEnd', 'Итог карты'],
  ['runLoss', 'Карта в минус'],
];

/** Подписи ступеней лестницы для стенда. */
export const LADDER_LABELS: ReadonlyMap<Tier, string> = new Map(LADDER_TIERS);

export const PREMIUM_LADDER: Concept = {
  id: 'premium-ladder',
  title: 'Премиум · вся лестница',
  blurb:
    'Все ступени на премиум-цепочке. Подбор и ценный подбор — выбранное мягкое направление; свист — тот же пресет «Подписи» с объёмом и полировкой; джекпот и стрик — «Пламя» поменьше; рекорд — «Пламя»; итог карты — мягкий щипок соль → до; минус — низкий щипок проседает и глохнет. A/B — против звуков, что сейчас в приложении.',
  color: '#ffb35a',
  protos: [
    ...SOFT_TAPS.map((tap) => ({
      id: `lad-big-${tap.id}`,
      label: `Ценный подбор · ${tap.label}`,
      tier: 'pickupBig' as const,
      render: (r: Random) => bigPickup(tap, r),
    })),
    ...[0, 1].map((v) => ({
      id: `lad-whistle-${v + 1}`,
      label: `Свист ${v + 1}`,
      tier: 'whistle' as const,
      render: () => bigPolish(finish(new Scene().add(rawSound('whistle', v, true), 0, 1, 1), WHISTLE_SPACE)),
    })),
    { id: 'lad-jackpot', label: 'Джекпот', tier: 'jackpot', render: (r) => bigPolish(flame(r, 'jackpot')) },
    { id: 'lad-jackpotHot', label: 'Стрик', tier: 'jackpotHot', render: jackpotHot },
    { id: 'lad-record', label: 'Рекорд', tier: 'record', render: (r) => bigPolish(flame(r, 'record')) },
    { id: 'lad-runEnd', label: 'Итог карты', tier: 'runEnd', render: runEnd },
    { id: 'lad-runLoss', label: 'Карта в минус', tier: 'runLoss', render: runLoss },
    // Нынешние звуки приложения — для A/B.
    ...LADDER_TIERS.map(([tier, label]) => ({
      id: `now-${tier}`,
      label: `Сейчас · ${label}`,
      tier,
      render: () => renderSound(tier, 0),
      mastered: true,
    })),
  ],
};
