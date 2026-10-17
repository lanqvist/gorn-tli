/**
 * Звуки Горна — «Подпись»: один фирменный звук дорогой находки
 * и все ступени, выведенные из него.
 *
 * Ориентир по характеру — оповещение о дорогой валюте в ARPG. Замер
 * такого оповещения (только анализ, ни отсчёта записи здесь нет) показал:
 *
 *  - до удара (~0.5 с) почти вся энергия ниже 250 Гц — глубокий широкий
 *    «вздох»: низ, свой в каждом канале, и низкие тона под ним;
 *  - одновременно звенят высокие обертоны будущего тона — 9-й, 11-й
 *    и 13-й: верх ноты слышен раньше самой ноты;
 *  - после удара — почти чистый синус с тремоло ~16 Гц (отсюда «живое»
 *    мерцание), слабые 2-я и 5.5-я гармоники, в центре стерео; тон держится
 *    около полусекунды, проседает и долго тает;
 *  - под хвостом звучат низкие тона, в самом конце — тихий космос.
 *
 * Всё здесь синтезировано заново из синусов и отфильтрованного шума:
 * ни сэмпла, ни свёртки с записью. Совпадает форма — огибающая, баланс
 * полос, строй обертонов, — а не сами звуки.
 *
 * Ступени — один тембр, разный вес: подбор — короткий тон, ценный — тон
 * с коротким вздохом, свист — подпись в миниатюре, джекпот — полная подпись,
 * стрик и рекорд — подпись с квинтой и октавой. У частых ступеней несколько
 * вариантов (ступени лада), их перебирают по кругу.
 */
import {
  SR,
  StereoMix,
  biquad,
  curve,
  hall,
  masterStereo,
  measureStereo,
  mul,
  noise,
  osc,
  rng,
  samples,
  seedOf,
  type Signal,
  type Stereo,
} from './dsp.js';
import baseline from './baseline.json';

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
 * Лесенка громкости (максимум RMS в окне 50 мс, дБFS): чем весомее
 * событие, тем громче, итог карты — спокойнее джекпота. Каждая ступень
 * не громче прежнего звука той же ступени (src/sfx/baseline.json) ни по
 * пику, ни по громкости, ни по полной энергии — это проверяют тесты.
 */
export const LOUDNESS: Record<Tier, number> = {
  pickup: -26,
  pickupBig: -23.5,
  whistle: -21.5,
  jackpot: -19.5,
  jackpotHot: -19.5,
  runEnd: -21,
  runLoss: -23.5,
  record: -18.5,
};

type Random = () => number;

interface Profile {
  /** Основной тон, Гц. */
  root: number;
  /** Частота тремоло тона, Гц. */
  tremolo: number;
  /** Глубина тремоло, 0..1. */
  depth: number;
  /** Доля 2-й гармоники. */
  second: number;
  /** Громкость высоких обертонов-предвестников. */
  tinkle: number;
  /** Глубина низа: громкость вздоха и низких тонов. */
  low: number;
  /** Доля космоса в хвосте. */
  space: number;
}

/** Профиль подписи: до второй октавы, мерцание 16 Гц. */
const SIGNATURE: Profile = {
  root: 523.25,
  tremolo: 16,
  depth: 0.28,
  second: 0.05,
  tinkle: 1,
  low: 1,
  space: 0.5,
};

// ── кирпичики ───────────────────────────────────────────────────

const smooth = (x: number): number => (x >= 1 ? 1 : x <= 0 ? 0 : (1 - Math.cos(Math.PI * x)) / 2);

interface ToneShape {
  /** Нарастание, с. */
  swell: number;
  /** Сколько тон держится на полной громкости, с. */
  hold: number;
  /** Насколько проседает после удержания, дБ. */
  drop: number;
  /** Хвост до −60 дБ после проседания, с. */
  tail: number;
  /** Кривая высоты (множитель). */
  bend?: (t: number) => number;
}

/**
 * Тон подписи: почти чистый синус с тремоло, слабыми 2-й, 4-й и 5.5-й
 * гармониками, строго в центре: мерцание даёт тремоло, а тон остаётся
 * собранным, как у эталона (разведённые расстроенные копии со временем
 * уходят в противофазу и «расползаются»).
 */
function tone(p: Profile, f: number, s: ToneShape): Stereo {
  const dur = s.swell + s.hold + 0.12 + s.tail;
  const dropGain = Math.pow(10, -s.drop / 20);
  const env = (t: number): number => {
    if (t < s.swell) return smooth(t / s.swell);
    const u = t - s.swell - s.hold;
    if (u < 0) return 1;
    if (u < 0.12) return 1 + (dropGain - 1) * smooth(u / 0.12);
    return dropGain * Math.exp((-6.9 * (u - 0.12)) / s.tail);
  };
  const trem = (t: number): number => 1 - p.depth * 0.5 * (1 - Math.cos(2 * Math.PI * p.tremolo * t));
  const bend = s.bend ?? (() => 1);
  const mix = new StereoMix(dur);
  for (const [ratio, share] of [
    [1, 1],
    [2, p.second],
    [4, 0.02],
    [5.47, 0.03],
  ] as const) {
    const sig = osc('sine', (t) => f * ratio * bend(t), dur);
    mul(sig, (t: number) => env(t) * trem(t) * (ratio > 2 ? Math.exp(-t / 0.5) : 1));
    mix.add(sig, 0, share * 0.7);
  }
  return mix.data;
}

/**
 * Предвестники: 9-й, 11-й и 13-й обертоны тона, чуть ниже точных кратных,
 * как у реального тела. Мягко вступают, звенят и тают к удару.
 */
function tinkle(p: Profile, f: number, dur: number, level: number): Stereo {
  const mix = new StereoMix(dur);
  [
    [8.9, 1, -0.5],
    [10.9, 0.8, 0.5],
    [13, 0.55, 0],
  ].forEach(([ratio, share, pan], k) => {
    const sig = osc('sine', (t) => f * ratio! * (1 + 0.002 * Math.sin(2 * Math.PI * (5 + k) * t)), dur);
    mul(sig, (t: number) => Math.min(1, t / 0.03) * Math.exp((-3.5 * t) / dur));
    mix.add(sig, 0, share! * 0.12 * level * p.tinkle, pan);
  });
  return mix.data;
}

/** Облако зерна: сумма коротких ханн-всплесков — живая шершавость низа. */
function grainCloud(dur: number, r: Random, rate: number): Signal {
  const out = new Float32Array(samples(dur));
  const count = Math.floor(dur * rate);
  for (let g = 0; g < count; g++) {
    const len = samples(0.03 + r() * 0.05);
    const at = Math.floor(r() * Math.max(1, out.length - len));
    const amp = 0.5 + r() * 0.5;
    for (let i = 0; i < len; i++) out[at + i] = out[at + i]! + amp * Math.sin((Math.PI * i) / len) ** 2;
  }
  return out;
}

/**
 * Вздох: низ ниже 220 Гц, свой шум в каждом канале — широкий, как у эталона,
 * — и низкие тона под ним: две и три октавы ниже тона и большая терция
 * между ними. После точки удара вздох быстро уходит.
 */
function breath(p: Profile, f: number, dur: number, r: Random, level: number): Stereo {
  const total = dur + 0.5;
  const mix = new StereoMix(total);
  const shape = (t: number): number =>
    Math.min(1, t / 0.04) * (t < dur ? 1 : Math.exp(-(t - dur) / 0.18));
  for (const side of [-1, 1] as const) {
    let low = biquad(noise(total, r), 'lowpass', 220, 0.7);
    low = biquad(low, 'lowpass', 220, 0.7);
    mul(low, grainCloud(total, r, 22));
    mix.add(mul(low, shape), 0, 3.2 * level * p.low, side);
    // Немного шершавой середины — у эталона до удара она есть, но тихо.
    const mid = biquad(noise(total, r), 'bandpass', 480, 0.7);
    mul(mid, grainCloud(total, r, 30));
    mix.add(mul(mid, shape), 0, 0.28 * level, side * 0.8);
  }
  for (const [ratio, share] of [
    [0.25, 0.1],
    [0.125, 0.07],
    [0.3125, 0.06],
  ] as const) {
    const sig = osc('sine', f * ratio, total);
    mix.add(mul(sig, shape), 0, share * level * p.low);
  }
  return mix.data;
}

/** Низкие тона под хвостом: тихий аккорд, который тает вместе с тоном. */
function underTones(p: Profile, f: number, dur: number, level: number): Stereo {
  const mix = new StereoMix(dur);
  for (const [ratio, share, pan] of [
    [0.25, 0.3, 0],
    [0.3125, 0.2, -0.3],
    [0.1875, 0.16, 0.3],
  ] as const) {
    const sig = osc('sine', f * ratio, dur);
    mul(sig, (t: number) => smooth(t / 0.15) * Math.exp((-6.9 * t) / (dur * 0.6)));
    mix.add(sig, 0, share * level * p.low, pan);
  }
  return mix.data;
}

/** Удар: мягкое тело с падающей высотой и короткий приглушённый выдох. */
function impact(r: Random, level: number): Signal {
  const dur = 0.3;
  const body = osc(
    'sine',
    curve([
      [0, 140],
      [0.1, 60],
    ]),
    dur,
  );
  mul(body, (t: number) => Math.min(1, t / 0.006) * Math.exp(-t / 0.07));
  const puff = biquad(noise(0.04, r), 'bandpass', 700, 0.9);
  mul(puff, (t: number) => Math.sin((Math.PI * t) / 0.04) ** 2);
  for (let i = 0; i < puff.length; i++) body[i] = body[i]! + puff[i]! * 0.25;
  for (let i = 0; i < body.length; i++) body[i] = body[i]! * 0.55 * level;
  return body;
}

/** Космос: тихий тёмный хвост зала, гаснущий к −60 дБ к концу буфера. */
function cosmos(p: Profile, dry: Stereo, amount: number, tail: number): Stereo {
  const n = Math.min(dry.l.length, dry.r.length);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (dry.l[i]! + dry.r[i]!) * 0.5;
  const wet = hall(mono, 0.88, 0.7, tail);
  const end = n / SR;
  const fade = (t: number): number => (t < end ? 1 : Math.exp((-6.9 * (t - end)) / tail));
  mul(wet.l, fade);
  mul(wet.r, fade);
  const out = new StereoMix(wet.l.length / SR);
  out.addStereo(wet, 0, amount * p.space * 0.35);
  return out.data;
}

// ── сборка ──────────────────────────────────────────────────────

interface Phrase {
  /** Вздох и предвестники до удара, с. 0 — сразу тон. */
  pre: number;
  /** Ноты: множитель основного тона, отступ от удара, громкость. */
  notes: ReadonlyArray<readonly [ratio: number, at: number, level: number]>;
  shape: ToneShape;
  impact: number;
  breath: number;
  tinkle: number;
  under: number;
  space: number;
  spaceTail: number;
}

function phrase(p: Profile, ph: Phrase, r: Random, root = p.root): Stereo {
  const hit = ph.pre;
  const dry = new StereoMix(hit + ph.shape.swell + ph.shape.hold + ph.shape.tail + 0.3);
  if (ph.breath > 0 && hit > 0) dry.addStereo(breath(p, root, hit, r, ph.breath));
  if (ph.tinkle > 0) dry.addStereo(tinkle(p, root, Math.max(0.2, hit + 0.15), ph.tinkle));
  if (ph.impact > 0) dry.add(impact(r, ph.impact), hit);
  for (const [ratio, at, level] of ph.notes) dry.addStereo(tone(p, root * ratio, ph.shape), hit + at, level);
  if (ph.under > 0) {
    dry.addStereo(underTones(p, root, ph.shape.hold + ph.shape.tail, ph.under), hit + ph.shape.swell + 0.2);
  }
  const body = dry.data;
  if (ph.space <= 0) return body;
  const out = new StereoMix(body.l.length / SR + ph.spaceTail);
  out.addStereo(body).addStereo(cosmos(p, body, ph.space, ph.spaceTail));
  return out.data;
}

/** Ступени лада вокруг основного тона: сам тон, большая секунда вверх, малая терция вниз. */
const STEPS = [1, 1.1225, 0.8409] as const;

function recipe(p: Profile, tier: Tier, v: number, r: Random): Stereo {
  switch (tier) {
    case 'pickup':
      // Один короткий тон и искорка обертона; варианты — ступени лада.
      return phrase(
        p,
        {
          pre: 0,
          notes: [[1, 0, 1]],
          shape: { swell: 0.012, hold: 0.04, drop: 6, tail: 0.3 },
          impact: 0,
          breath: 0,
          tinkle: 0.4,
          under: 0,
          space: 0.4,
          spaceTail: 0.25,
        },
        r,
        p.root * STEPS[v % 3]!,
      );
    case 'pickupBig':
      return phrase(
        p,
        {
          pre: 0.12,
          notes: [[1, 0, 1]],
          shape: { swell: 0.03, hold: 0.1, drop: 6, tail: 0.5 },
          impact: 0.5,
          breath: 0.5,
          tinkle: 0.6,
          under: 0.5,
          space: 0.5,
          spaceTail: 0.35,
        },
        r,
        p.root * STEPS[v % 2]!,
      );
    case 'whistle':
      // Подпись в миниатюре: короткий вздох, удар, тон.
      return phrase(
        p,
        {
          pre: v % 2 === 0 ? 0.22 : 0.3,
          notes: [[v % 2 === 0 ? 1 : 1.5, 0, 1]],
          shape: { swell: 0.06, hold: 0.28, drop: 8, tail: 0.8 },
          impact: 0.8,
          breath: 0.8,
          tinkle: 0.85,
          under: 0.8,
          space: 0.8,
          spaceTail: 0.5,
        },
        r,
      );
    case 'jackpot':
    case 'jackpotHot': {
      const notes: Array<[number, number, number]> = [[1, 0, 1]];
      if (v % 2 === 1) notes.push([0.5, 0.02, 0.25]);
      if (tier === 'jackpotHot') notes.push([1.5, 0.22, 0.45], [2, 0.42, 0.3]);
      return phrase(
        p,
        {
          pre: 0.52,
          notes,
          shape: { swell: 0.08, hold: 0.52, drop: 10, tail: 1.2 },
          impact: 1,
          breath: 1,
          tinkle: tier === 'jackpotHot' ? 1.3 : 1,
          under: 1,
          space: 1,
          spaceTail: 0.7,
        },
        r,
      );
    }
    case 'runEnd':
      // Квинта, разрешающаяся в тон, — без вздоха: карта закрыта спокойно.
      return phrase(
        p,
        {
          pre: 0.05,
          notes: [
            [v % 2 === 0 ? 1.5 : 1.3348, 0, 0.75],
            [1, 0.22, 1],
          ],
          shape: { swell: 0.05, hold: 0.2, drop: 8, tail: 0.8 },
          impact: 0.5,
          breath: 0.4,
          tinkle: 0.4,
          under: 0.8,
          space: 0.7,
          spaceTail: 0.5,
        },
        r,
      );
    case 'runLoss':
      // Тон октавой ниже проседает и глохнет, без предвестников.
      return phrase(
        p,
        {
          pre: 0.05,
          notes: [[0.5, 0, 1]],
          shape: {
            swell: 0.04,
            hold: 0.12,
            drop: 10,
            tail: 0.5,
            bend: curve([
              [0, 1],
              [0.45, 0.94],
            ]),
          },
          impact: 0.4,
          breath: 0.4,
          tinkle: 0,
          under: 0.5,
          space: 0.3,
          spaceTail: 0.3,
        },
        r,
      );
    case 'record':
      // Полная подпись с аккордом: тон, квинта и октава вступают друг за другом.
      return phrase(
        p,
        {
          pre: 0.6,
          notes: [
            [1, 0, 1],
            [1.5, 0.12, 0.5],
            [2, 0.26, 0.35],
          ],
          shape: { swell: 0.1, hold: 0.62, drop: 9, tail: 1.4 },
          impact: 1,
          breath: 1,
          tinkle: 1.4,
          under: 1,
          space: 1.3,
          spaceTail: 0.9,
        },
        r,
      );
  }
}

const BASE = baseline.files as Record<string, { peakDb: number; rmsDb: number; energyDb: number }>;

/** Пределы ступени по прежним файлам: самый тихий из её вариантов. */
export function limitsFor(tier: Tier): { rmsDb: number; peakDb: number; energyDb: number } {
  const rows = Object.entries(BASE)
    .filter(([name]) => name.startsWith(`${tier}-`))
    .map(([, m]) => m);
  return {
    rmsDb: Math.min(...rows.map((m) => m.rmsDb)),
    peakDb: Math.min(...rows.map((m) => m.peakDb)),
    energyDb: Math.min(...rows.map((m) => m.energyDb)),
  };
}

/**
 * Готовый стерео-ассет: рецепт со своим сидом, затем мастер — громкость
 * по лесенке, пики под прежний потолок. Протяжный тон «давит» дольше
 * прежнего звука: если полная энергия всё же выше прежней, весь звук
 * опускается на разницу.
 */
export function renderSound(tier: Tier, variant: number): Stereo {
  const raw = recipe(SIGNATURE, tier, variant, rng(seedOf(`signature:${tier}:${variant}`)));
  const lim = limitsFor(tier);
  const target = Math.min(LOUDNESS[tier], lim.rmsDb - 0.5);
  const first = masterStereo(raw, target, lim.peakDb);
  const over = measureStereo(first).energyDb - (lim.energyDb - 0.1);
  return over > 0 ? masterStereo(raw, target - over, lim.peakDb) : first;
}

/** Имя файла ассета: так его находит генератор и src/renderer/overlay/sound.ts. */
export const assetName = (tier: Tier, variant: number): string => `${tier}-${variant + 1}.wav`;
