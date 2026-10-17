/**
 * Инструменты и рецепты звуков Горна — «Пепельный фонк».
 *
 * Электроника поверх материала самой игры: мемфисский ковбелл 808
 * во фригийском ре, 808-бас со слайдами и перегрузом, вокальные чопы,
 * кассетная пыль и тейп-стоп, а сверху — пламя и кристаллы Пламенного
 * Элементия. Плюс свист, как в фильтрах добычи PoE: дорогой предмет
 * узнаётся не глядя на экран.
 *
 * Ступени — у каждой свой звук-предмет, а не тот же звук погромче.
 * У частых ступеней несколько вариантов: их перебирают по кругу,
 * чтобы ухо не замыливалось.
 */
import {
  Mix,
  ad,
  biquad,
  crush,
  curve,
  drive,
  duck,
  echo,
  master,
  mul,
  noise,
  osc,
  reverb,
  rng,
  scale,
  seedOf,
  tapeStop,
  type Signal,
} from './dsp.js';

export type Tier =
  | 'pickup'
  | 'pickupBig'
  | 'whistle'
  | 'jackpot'
  | 'jackpotHot'
  | 'runEnd'
  | 'runLoss'
  | 'record';

export const TIERS: readonly Tier[] = [
  'pickup',
  'pickupBig',
  'whistle',
  'jackpot',
  'jackpotHot',
  'runEnd',
  'runLoss',
  'record',
];

/** Сколько вариантов у ступени: частым — несколько, редким — один-два. */
export const VARIANTS: Record<Tier, number> = {
  pickup: 3,
  pickupBig: 2,
  whistle: 2,
  jackpot: 2,
  jackpotHot: 1,
  runEnd: 2,
  runLoss: 1,
  record: 1,
};

/**
 * Громкость ступеней (максимум RMS в окне 50 мс, дБFS) — по замеру
 * прежних звуков на полной громкости, с запасом вниз: новые не громче.
 */
const LOUDNESS: Record<Tier, number> = {
  pickup: -22,
  pickupBig: -17,
  whistle: -16,
  jackpot: -13.5,
  jackpotHot: -13.5,
  runEnd: -12.5,
  runLoss: -18,
  record: -12.5,
};
const CEILING_DB = -4.5;

/** Ноты, Гц. Фригийский ре (ре–ми♭–фа–соль–ля–си♭–до) — тёмный лад фонка. */
const N = {
  D1: 36.71,
  A1: 55,
  D2: 73.42,
  F2: 87.31,
  D4: 293.66,
  F4: 349.23,
  A4: 440,
  C5: 523.25,
  D5: 587.33,
  Eb5: 622.25,
  F5: 698.46,
  A5: 880,
} as const;

type Random = () => number;

// ── инструменты ─────────────────────────────────────────────────

/**
 * Ковбелл 808: два меандра в соотношении 1 : 1.44 через полосовой фильтр,
 * двухступенчатый спад. Нота — частота нижнего меандра; родная у 808 —
 * 587 Гц, ровно ре второй октавы.
 */
function cowbell(f: number, dur = 0.32): Signal {
  const a = osc('square', f, dur);
  const b = osc('square', f * 1.44, dur);
  for (let i = 0; i < a.length; i++) a[i] = (a[i]! + b[i]!) * 0.5;
  let s = biquad(a, 'bandpass', f * 2.1, 1.1);
  s = biquad(s, 'lowpass', 3600, 0.6);
  const env = ad(dur, 0.002, dur * 0.9);
  const snap = ad(dur, 0.001, 0.04);
  for (let i = 0; i < env.length; i++) env[i] = env[i]! * 0.6 + snap[i]! * 0.5;
  return drive(mul(s, env), 1.6);
}

/**
 * 808-бас: синус со слайдом по точкам [время, частота], щелчок атаки
 * и перегруз — от тёплого (1) до рычащего фонкового (4+).
 */
function bass808(
  glide: ReadonlyArray<readonly [number, number]>,
  dur: number,
  drv: number,
  decay = dur,
): Signal {
  const s = osc('sine', curve(glide), dur);
  mul(s, ad(dur, 0.004, decay, 0.05));
  const click = mul(osc('sine', (glide[0]?.[1] ?? 55) * 4, 0.02), ad(0.02, 0.001, 0.015));
  for (let i = 0; i < click.length; i++) s[i] = s[i]! + click[i]! * 0.4;
  return drive(s, drv);
}

/** Бочка: синус, падающий 160 → f0 за 60 мс. */
function kick(f0 = 52, dur = 0.35): Signal {
  const s = osc(
    'sine',
    curve([
      [0, 160],
      [0.06, f0],
      [dur, f0 * 0.9],
    ]),
    dur,
  );
  return drive(mul(s, ad(dur, 0.002, dur * 0.85)), 1.4);
}

/** Хлопок: три быстрые вспышки шума и короткий хвост. */
function clap(random: Random): Signal {
  const m = new Mix(0.25);
  for (const [at, g] of [
    [0, 0.7],
    [0.011, 0.8],
    [0.023, 1],
  ] as const) {
    m.add(mul(biquad(noise(0.02, random), 'bandpass', 1300, 1.2), ad(0.02, 0.0005, 0.012)), at, g);
  }
  m.add(mul(biquad(noise(0.22, random), 'bandpass', 1200, 0.9), ad(0.22, 0.002, 0.16)), 0.023, 0.7);
  return m.data;
}

/** Хэт — тихий и тёмный: шум выше 5 кГц, коротко. */
function hat(random: Random, dur = 0.05): Signal {
  return mul(biquad(noise(dur, random), 'highpass', 5200, 0.7), ad(dur, 0.0005, dur * 0.8));
}

/** Форманты гласных. */
const VOWELS = {
  a: [
    [730, 1],
    [1090, 0.5],
    [2440, 0.16],
  ],
  e: [
    [530, 1],
    [1840, 0.45],
    [2480, 0.15],
  ],
} as const;

/**
 * Вокальный чоп: пила с вибрато через три форманты гласной; к концу
 * высота проседает — как питчнутый вниз сэмпл в фонке.
 */
function vocal(f: number, vowel: keyof typeof VOWELS, dur: number, drop = 0.85): Signal {
  const src = osc(
    'saw',
    (t) => f * (1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * t)) * (t > dur * 0.6 ? drop : 1),
    dur,
  );
  const m = new Mix(dur);
  for (const [freq, g] of VOWELS[vowel]) m.add(biquad(src, 'bandpass', freq, 6), 0, g * 2.5);
  return drive(mul(m.data, ad(dur, 0.012, dur * 0.8, dur * 0.25)), 1.8);
}

/**
 * Свист губами: чистый синус по кривой высоты, вибрато вступает
 * не сразу, а под ним — придыхание: шум, отфильтрованный узкой полосой
 * вокруг той же ноты. Без придыхания свист звучит как тест-сигнал.
 */
function whistle(
  random: Random,
  pitch: ReadonlyArray<readonly [number, number]>,
  dur: number,
): Signal {
  const base = curve(pitch);
  const f = (t: number) =>
    base(t) * (1 + Math.min(1, Math.max(0, (t - 0.08) / 0.1)) * 0.012 * Math.sin(2 * Math.PI * 6 * t));
  const tone = osc('sine', f, dur);
  const breath = biquad(noise(dur, random), 'bandpass', f, 9);
  const m = new Mix(dur).add(tone, 0, 0.8).add(breath, 0, 0.9);
  return mul(m.data, (t: number) => Math.min(1, t / 0.03) * Math.min(1, (dur - t) / 0.06));
}

/** Кристалл Элементия: FM-тон со стеклянным модулятором 3.5 и гаснущим индексом. */
function crystal(f: number, decay: number, index = 2): Signal {
  const dur = decay + 0.02;
  const mod = osc('sine', f * 3.5, dur);
  const idx = ad(dur, 0.001, decay * 0.35);
  for (let i = 0; i < mod.length; i++) mod[i] = mod[i]! * index * (0.05 + idx[i]!) * 2;
  const car = osc('sine', f, dur, mod);
  const twin = osc('sine', f * 1.0035, dur, mod);
  for (let i = 0; i < car.length; i++) car[i] = car[i]! + twin[i]! * 0.45;
  return mul(car, ad(dur, 0.004, decay));
}

/** Пламя: шум с «вдохом» фильтра и дрожью громкости — материал TLI. */
function flame(random: Random, dur: number, path: readonly [number, number, number]): Signal {
  const [a, b, c] = path;
  const s = biquad(
    noise(dur, random),
    'bandpass',
    curve([
      [0, a],
      [dur * 0.35, b],
      [dur, c],
    ]),
    1.2,
  );
  const rate = 10 + random() * 4;
  return mul(
    s,
    (t: number) => Math.sin((Math.PI * t) / dur) * (1 + 0.35 * Math.sin(2 * Math.PI * rate * t)),
  );
}

/** Кассетная пыль: редкие щелчки и шипение — подложка фонка. */
function dust(random: Random, dur: number): Signal {
  const s = scale(biquad(noise(dur, random), 'bandpass', 2400, 0.6), 0.05);
  for (let i = 0; i < 10; i++) {
    const at = Math.floor(random() * s.length);
    s[at] = (s[at] ?? 0) + (random() - 0.5) * 0.9;
  }
  return s;
}

// ── рецепты ─────────────────────────────────────────────────────

/** 140 BPM, шестнадцатая. */
const PH = 60 / 140 / 4;

function recipe(tier: Tier, v: number, r: Random): Signal {
  const m = new Mix(1);
  switch (tier) {
    case 'pickup': {
      // Одна нота ковбелла; варианты — разные ноты лада.
      const note = [N.D5, N.C5, N.A4][v % 3]!;
      m.add(cowbell(note, 0.26), 0, 0.9).add(dust(r, 0.25), 0, 0.6);
      break;
    }
    case 'pickupBig': {
      const [a, b] = v % 2 === 0 ? [N.A4, N.D5] : [N.C5, N.Eb5];
      m.add(cowbell(a, 0.2)).add(cowbell(b, 0.3), PH);
      m.add(
        bass808(
          [
            [0, N.D2 * 1.5],
            [0.05, N.D2],
          ],
          0.35,
          3,
          0.25,
        ),
        0,
        0.7,
      );
      break;
    }
    case 'whistle': {
      // «Фьюить!» вверх или «фьюить-фьюю» — и 808 под ним, чтобы свист
      // был из той же семьи, а не чужим сигналом.
      if (v % 2 === 0) {
        m.add(
          whistle(
            r,
            [
              [0, 1150],
              [0.1, 1950],
              [0.26, 2050],
            ],
            0.28,
          ),
        );
      } else {
        m.add(
          whistle(
            r,
            [
              [0, 950],
              [0.16, 1950],
            ],
            0.18,
          ),
        );
        m.add(
          whistle(
            r,
            [
              [0, 1900],
              [0.12, 1700],
              [0.36, 900],
            ],
            0.38,
          ),
          0.24,
        );
      }
      m.add(
        bass808(
          [
            [0, N.D2 * 1.5],
            [0.05, N.D2],
          ],
          0.3,
          2.5,
          0.22,
        ),
        0,
        0.45,
      );
      return reverb(m.data, 0.35, 0.5, 0.14, 0.15);
    }
    case 'jackpot':
    case 'jackpotHot': {
      // Чоп «а» + фраза ковбелла ре–ми♭–ре–ля над рычащим 808 со слайдом вниз.
      const phrase = v % 2 === 0 ? [N.D5, N.Eb5, N.D5, N.A4] : [N.D5, N.F5, N.Eb5, N.D5];
      m.add(vocal(N.D4, 'a', 0.38), 0, 0.55);
      m.add(
        bass808(
          [
            [0, N.D2],
            [0.25, N.D2],
            [0.45, N.A1],
          ],
          0.65,
          4.5,
          0.5,
        ),
        0,
        0.85,
      );
      m.add(kick(48, 0.3), 0, 0.7);
      phrase.forEach((f, i) => m.add(cowbell(f, i === 3 ? 0.3 : 0.22), i * PH * 2, 0.8));
      m.add(clap(r), PH * 4, 0.6);
      m.add(flame(r, 0.6, [250, 1100, 220]), 0, 0.25);
      if (tier === 'jackpotHot') {
        // Стрик: «эй!» и пробег ковбелла на октаву вверх.
        m.add(vocal(N.A4, 'e', 0.18, 0.9), PH * 6, 0.45);
        [N.A4, N.C5, N.D5, N.Eb5, N.F5, N.A5].forEach((f, i) =>
          m.add(cowbell(f, 0.16), PH * 6 + i * PH * 0.5, 0.55),
        );
        m.add(crystal(N.D5, 0.4, 2.4), PH * 9, 0.35);
      }
      const data = echo(m.data, PH * 2, 0.15, 0.2, 0.1);
      return reverb(data, 0.35, 0.5, 0.15, 0.2);
    }
    case 'runEnd': {
      const [a, b] = v % 2 === 0 ? [N.D5, N.A4] : [N.Eb5, N.D5];
      m.add(kick(50, 0.3), 0, 0.7);
      m.add(
        bass808(
          [
            [0, N.D2],
            [0.15, N.D2],
            [0.5, N.D1],
          ],
          0.7,
          3.5,
          0.6,
        ),
        0,
        0.85,
      );
      m.add(cowbell(a, 0.22), 0, 0.8).add(cowbell(b, 0.4), PH * 2, 0.8);
      m.add(clap(r), PH * 4, 0.55);
      m.add(dust(r, 0.8), 0, 0.5);
      break;
    }
    case 'runLoss': {
      // Фраза вниз, и лента останавливается — «вууу».
      const phrase = new Mix(0.6);
      [N.D5, N.C5, N.A4].forEach((f, i) => phrase.add(cowbell(f, 0.25), i * PH * 2, 0.8));
      phrase.add(bass808([[0, N.D2]], 0.6, 2.5, 0.5), 0, 0.6);
      const stopped = tapeStop(phrase.data, PH * 3, 0.55);
      m.add(biquad(stopped, 'lowpass', 1800, 0.7)).add(dust(r, 0.9), 0, 0.6);
      break;
    }
    case 'record': {
      // Полтакта мемфисского грува: чоп, ковбелл, 808 со слайдом, точка кристаллами.
      const bells = [N.D5, N.D5, N.Eb5, N.D5, N.C5, N.D5, N.A4, N.D5];
      m.add(kick(48, 0.35), 0, 0.75).add(kick(48, 0.3), PH * 6, 0.6);
      m.add(
        bass808(
          [
            [0, N.D2],
            [PH * 5, N.D2],
            [PH * 6, N.F2],
            [PH * 8, N.A1],
          ],
          0.8,
          4,
          0.6,
        ),
        0,
        0.8,
      );
      bells.forEach((f, i) => m.add(cowbell(f, 0.2), i * PH, 0.7));
      for (let i = 0; i < 4; i++) m.add(hat(r), i * PH * 2 + PH, 0.25);
      m.add(clap(r), PH * 4, 0.6);
      m.add(vocal(N.D4, 'a', 0.3), 0, 0.5);
      [N.D4, N.F4, N.A4, N.D5].forEach((f, i) =>
        m.add(crystal(f, 0.4, 2.2), PH * 8 + i * 0.04, 0.32),
      );
      const data = duck(m.data, [0, PH * 6], 0.35, 0.08);
      return reverb(echo(data, PH * 3, 0.2, 0.18, 0.15), 0.35, 0.5, 0.13, 0.2);
    }
  }
  // Лёгкая кассетная пыль на всё: разрядность 12 бит, без потери высоты.
  return reverb(crush(m.data, 1, 12), 0.3, 0.55, 0.12, 0.15);
}

/**
 * Готовый ассет: рецепт со своим сидом, затем мастер — громкость ступени
 * по замеру и потолок пиков.
 */
export function renderSound(tier: Tier, variant: number): Signal {
  const raw = recipe(tier, variant, rng(seedOf(`phonk:${tier}:${variant}`)));
  return master(raw, LOUDNESS[tier], CEILING_DB);
}

/** Имя файла ассета: так его находит генератор и src/renderer/overlay/sound.ts. */
export const assetName = (tier: Tier, variant: number): string => `${tier}-${variant + 1}.wav`;
