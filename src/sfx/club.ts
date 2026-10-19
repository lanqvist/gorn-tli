/**
 * Прототипы «Клуб» — звуки Горна в стилистике хаус + космос + EDM
 * для прослушивания в src/renderer/sound-lab.html. В ассеты не идут,
 * пока не выбраны на слух.
 *
 * Опоры из ресерча:
 *
 *  - узнаваемость короткого звукового логотипа растёт с ритмической
 *    и интервальной сложностью (Silas и др., 2026: 90 логотипов,
 *    1860 слушателей) — поэтому у каждой концепции свой ритм (тресилло
 *    3-3-2 хауса, «1-.-1-1» дропа, 32-е арпеджио) и широкие интервалы
 *    (квинты, нона), а не ровная нота;
 *  - хаус узнаётся по органному стабу m9/maj9 с фильтром по огибающей
 *    и «дыханию» хвоста под сайдчейн на четверть;
 *  - космос — FM-колокол и шиммер (хвост октавой выше), облёт по сцене;
 *  - EDM — супер-пила, райзер и дроп с сабом;
 *  - объём — M/S-ширина только выше ~150 Гц, ранние отражения,
 *    модулированный зал с предзадержкой (src/sfx/fx.ts).
 *
 * Всё в тональности подписи (до): новые звуки и свист звучат как одна
 * семья. Рендер — 48 кГц: шиммеру и пиле нужен верх.
 */
import { Mix, SR, StereoMix, masterStereo, measureStereo, osc, rng, seedOf, biquad, noise, withRate, type Signal, type Stereo } from './dsp.js';
import {
  adsr,
  bell,
  chorus,
  filterStereo,
  hz,
  mono,
  orbit,
  organ,
  pingPong,
  pump,
  reflections,
  riser,
  room,
  saturate,
  shimmer,
  sub,
  supersaw,
  widen,
  type RoomOptions,
} from './fx.js';
import { CYBER_KIT } from './cyber.js';
import { PREMIUM_KIT, PREMIUM_LADDER, SOFT_KIT } from './premium.js';
import { FORGE_KIT, HYBRID } from './hybrid.js';
import { limitsFor, rawSound, renderSound, type Tier } from './kit.js';
import { Scene, finish, type Concept } from './scene.js';

/** Частота рендера прототипов. */
export const PROTO_RATE = 48000;

type Random = () => number;

// ── голоса жанров ───────────────────────────────────────────────

/** Фильтр 24 дБ/окт с огибающей: из cutFrom к cutTo за τ. */
function sweep(st: Stereo, from: number, to: number, tau: number, q = 0.9): Stereo {
  const f = (t: number) => to + (from - to) * Math.exp(-t / tau);
  return filterStereo(filterStereo(st, 'lowpass', f, q), 'lowpass', f, 0.6);
}

function envelope(st: Stereo, env: (t: number) => number): Stereo {
  return {
    l: st.l.map((x, i) => x * env(i / SR)) as Signal,
    r: st.r.map((x, i) => x * env(i / SR)) as Signal,
  };
}

/** Органный стаб хауса: аккорд, ноты чуть разведены по сцене, фильтр по огибающей. */
function houseStab(chord: readonly number[], len: number, r: Random, cut: [number, number, number] = [5600, 1300, 0.1]): Stereo {
  const mix = new StereoMix(len + 0.5);
  chord.forEach((m, k) => {
    const pan = chord.length > 1 ? -0.35 + (0.7 * k) / (chord.length - 1) : 0;
    const body = organ(hz(m), len + 0.5, r);
    // Немного пилы под органом — укус M1.
    const bite = osc('saw', hz(m) * 1.002, len + 0.5);
    for (let i = 0; i < body.length; i++) body[i] = body[i]! + bite[i]! * 0.07;
    mix.add(body, 0, 1 / Math.sqrt(chord.length), pan);
  });
  return envelope(sweep(mix.data, ...cut, 1.1), adsr(0.003, 0.2, 0, len, 0.1));
}

/** Супер-пильный стаб EDM. */
function sawStab(chord: readonly number[], len: number, r: Random, cut: [number, number, number], sustain = 0.25): Stereo {
  const mix = new StereoMix(len + 0.5);
  for (const m of chord) mix.addStereo(supersaw(hz(m), len + 0.5, r, 0.2, 0.62, 0.85), 0, 1 / Math.sqrt(chord.length));
  return envelope(sweep(mix.data, ...cut, 0.8), adsr(0.002, 0.25, sustain, len, 0.14));
}

/** Неоновый голос фильтр-хауса: меандр с пилой, резонансный фильтр. */
function neon(m: number, len: number, cut: (t: number) => number, q = 4): Signal {
  const f = hz(m);
  const a = osc('square', f, len + 0.3);
  const b = osc('saw', f * 1.004, len + 0.3);
  const s = new Float32Array(a.length);
  for (let i = 0; i < s.length; i++) s[i] = a[i]! * 0.45 + b[i]! * 0.35;
  const env = adsr(0.002, 0.12, 0.35, len, 0.07);
  const out = biquad(s, 'lowpass', cut, q);
  for (let i = 0; i < out.length; i++) out[i] = out[i]! * env(i / SR);
  return out;
}

/** Мягкая подложка-«туманность»: тёмная супер-пила с медленной атакой. */
function nebula(chord: readonly number[], dur: number, r: Random): Stereo {
  const mix = new StereoMix(dur);
  for (const m of chord) mix.addStereo(supersaw(hz(m), dur, r, 0.12, 0.5, 1), 0, 0.5);
  const st = filterStereo(mix.data, 'lowpass', 1400, 0.6);
  return envelope(st, (t) => Math.min(1, t / 0.45) ** 2 * Math.exp(-Math.max(0, t - 0.45) / (dur * 0.35)));
}

// ── аккорды (до минор / дорийский) ──────────────────────────────

const Cm9 = [48, 55, 58, 62, 63];
const Cm9hi = [60, 67, 70, 74, 75];
const Ebmaj9 = [51, 58, 62, 65, 67];
const Abmaj9 = [44, 51, 55, 58, 60];
const Bb69 = [46, 53, 57, 60, 62];

// ── «Клуб»: дип-хаус, органный стаб, тресилло, дыхание хвоста ──

const CLUB_BPM = 124;
const S124 = 60 / CLUB_BPM / 4;

function clubPickup(r: Random): Stereo {
  const sc = new Scene().add(houseStab(Cm9hi, 0.06, r, [4200, 1000, 0.06]), 0, 1, 0.8);
  return finish(sc, {
    er: 0.2,
    ping: { time: 3 * S124, fb: 0.22, wet: 0.3, lp: 4000, hp: 500, tail: 0.9 },
    room: { size: 0.7, decay: 0.9, damp: 5000, wet: 0.25 },
    width: 1.4,
  });
}

function clubJackpot(r: Random): Stereo {
  const sc = new Scene()
    .addMono(sub(0.45, 160, 50, 0.03, 0.4, r, 0.35), 0, 0.5)
    .add(houseStab(Cm9, 0.11, r), 0, 1, 0.7)
    .add(houseStab(Cm9, 0.11, r), 3 * S124, 0.9, 0.7)
    .add(houseStab(Ebmaj9, 0.34, r, [6500, 1200, 0.18]), 6 * S124, 1, 0.8);
  return finish(sc, {
    er: 0.25,
    ping: { time: 3 * S124, fb: 0.38, wet: 0.4, lp: 4500, hp: 450, tail: 1.6 },
    room: { size: 1, decay: 2, damp: 5500, predelay: 0.02, wet: 0.5 },
    width: 1.5,
    pump: { bpm: CLUB_BPM, depth: 0.55, start: 0 },
    glue: 1.2,
  });
}

function clubRecord(r: Random): Stereo {
  const T = 0.75;
  const sc = new Scene().add(riser(T, r, 400, 8000), 0, 0.5, 0.3);
  sc.addMono(sub(0.45, 160, 50, 0.03, 0.4, r, 0.35), T, 0.55);
  sc.addMono(sub(0.45, 160, 50, 0.03, 0.4, r, 0.3), T + 8 * S124, 0.42);
  const seq: ReadonlyArray<readonly [readonly number[], number, number]> = [
    [Cm9, 0, 0.11],
    [Cm9, 3, 0.11],
    [Abmaj9, 6, 0.2],
    [Bb69, 10, 0.11],
    [Cm9hi, 12, 0.6],
  ];
  for (const [chord, step, len] of seq) {
    const open = step === 12 ? ([7000, 1300, 0.3] as [number, number, number]) : undefined;
    sc.add(houseStab(chord, len, r, open), T + step * S124, 1, 0.75);
  }
  return finish(sc, {
    er: 0.25,
    ping: { time: 3 * S124, fb: 0.4, wet: 0.38, lp: 4500, hp: 450, tail: 1.8 },
    room: { size: 1.1, decay: 2.4, damp: 5500, predelay: 0.02, wet: 0.5 },
    width: 1.6,
    pump: { bpm: CLUB_BPM, depth: 0.55, start: T },
    glue: 1.25,
  });
}

// ── «Орбита»: космос, FM-колокол, квинты, шиммер, облёт ─────────

function orbitPickup(r: Random): Stereo {
  void r;
  const sc = new Scene().add(bell(hz(84), 0.9, { index: 1.1, decay: 0.55 }), 0, 1, 0.9);
  return finish(sc, {
    shimmer: { size: 1.1, decay: 1.5, damp: 7000, predelay: 0.02, wet: 0.35, amount: 0.35 },
    width: 1.5,
  });
}

function orbitJackpot(r: Random): Stereo {
  const swell = osc('sine', hz(36), 2.2);
  for (let i = 0; i < swell.length; i++) {
    const t = i / SR;
    swell[i] = swell[i]! * Math.min(1, t / 0.25) * Math.exp(-t / 0.7);
  }
  const sc = new Scene()
    .addMono(swell, 0, 0.3)
    .add(nebula([48, 55, 62], 2.4, r), 0, 0.35, 1)
    .add(bell(hz(72), 2.2, { index: 2.6, decay: 1.3 }), 0, 1, 0.8)
    .add(bell(hz(79), 2, { index: 2.3, decay: 1.2 }), 0.11, 0.8, 0.8)
    .add(bell(hz(86), 2, { index: 2, decay: 1.3 }), 0.33, 0.9, 0.9);
  return finish(sc, {
    er: 0.15,
    ping: { time: 0.27, fb: 0.35, wet: 0.22, lp: 6000, hp: 600, tail: 1.4 },
    shimmer: { size: 1.4, decay: 3.2, damp: 6500, predelay: 0.03, mod: 0.5, wet: 0.55, amount: 0.5 },
    width: 1.6,
    orbit: { rate: 0.35, depth: 0.35 },
  });
}

function orbitRecord(r: Random): Stereo {
  const T = 0.6;
  const warp = osc('sine', (t) => 110 * Math.pow(16, Math.min(1, t / T) ** 1.5), T + 0.05);
  for (let i = 0; i < warp.length; i++) warp[i] = warp[i]! * Math.pow(Math.min(1, i / warp.length), 2) * 0.5;
  const sc = new Scene()
    .add(riser(T, r, 300, 6000), 0, 0.35, 0.5)
    .addMono(warp, 0, 0.45, 0, 0.6)
    .addMono(sub(1.6, 120, 38, 0.08, 1.4, r, 0.2), T, 0.9)
    .add(nebula([48, 55, 62], 3, r), T, 0.4, 1);
  [
    [72, 0, 1, 2.6],
    [79, 0.1, 0.85, 1.4],
    [86, 0.2, 0.85, 1.4],
    [93, 0.42, 0.75, 1.6],
  ].forEach(([m, at, g, decay]) => sc.add(bell(hz(m!), 2.6, { index: 2.4, decay: decay! }), T + at!, g!, 0.85));
  return finish(sc, {
    er: 0.15,
    ping: { time: 0.27, fb: 0.38, wet: 0.2, lp: 6000, hp: 600, tail: 1.6 },
    shimmer: { size: 1.5, decay: 3.8, damp: 6500, predelay: 0.03, mod: 0.55, wet: 0.6, amount: 0.55 },
    width: 1.7,
    orbit: { rate: 0.25, depth: 0.4 },
  });
}

// ── «Фестиваль»: EDM, супер-пила, райзер, дроп с сабом ──────────

const FEST_BPM = 128;
const S128 = 60 / FEST_BPM / 4;

function festPickup(r: Random): Stereo {
  const sc = new Scene().add(sawStab([72, 79], 0.05, r, [9000, 1400, 0.06], 0), 0, 1, 0.7);
  return finish(sc, {
    ping: { time: 2 * S128, fb: 0.25, wet: 0.3, lp: 6000, hp: 500, tail: 0.8 },
    room: { size: 0.8, decay: 1, damp: 7000, wet: 0.25 },
    width: 1.3,
  });
}

/** Дроп: бочка, аккорд пилы и хук лида — аккорд и лид дышат под пампинг. */
function drop(sc: Scene, T: number, r: Random, hook: ReadonlyArray<readonly [number, number, number]>): void {
  sc.addMono(sub(0.7, 180, 44, 0.035, 0.6, r, 0.4), T, 0.6);
  const synth = new StereoMix(0.1);
  synth.addStereo(sawStab([48, 60, 63, 67, 70, 74], 0.24, r, [12000, 2400, 0.25]), 0, 0.9);
  for (const [m, step, len] of hook) synth.addStereo(sawStab([m, m - 12], len, r, [10000, 3000, 0.12], 0.4), step * S128, 0.55);
  const pumped = pump(synth.data, FEST_BPM, 0.6, 0.12);
  sc.add(pumped, T, 1, 0.6);
}

function festJackpot(r: Random): Stereo {
  const T = 0.4;
  const zip = biquad(osc('saw', (t) => 200 * Math.pow(8, Math.min(1, t / T)), T), 'lowpass', 3000, 0.7);
  for (let i = 0; i < zip.length; i++) zip[i] = zip[i]! * (i / zip.length) ** 2;
  const sc = new Scene().add(riser(T, r, 600, 9000), 0, 0.45, 0.3).addMono(zip, 0, 0.15, 0, 0.4);
  drop(sc, T, r, [
    [84, 0, 0.08],
    [84, 2, 0.08],
    [87, 3, 0.08],
    [91, 6, 0.3],
  ]);
  return finish(sc, {
    ping: { time: 3 * S128, fb: 0.35, wet: 0.3, lp: 6000, hp: 500, tail: 1.4 },
    room: { size: 1.1, decay: 1.8, damp: 7000, predelay: 0.015, wet: 0.4 },
    width: 1.5,
    pump: { bpm: FEST_BPM, depth: 0.6, start: T },
    glue: 1.4,
  });
}

function festRecord(r: Random): Stereo {
  const T = 0.9;
  const sc = new Scene().add(riser(T, r, 500, 10000), 0, 0.45, 0.3);
  // Дробь: восьмые → шестнадцатые → тридцать вторые, всё громче.
  const hits: number[] = [];
  for (let t = 0; t < T - 0.01; ) {
    hits.push(t);
    t += t < 0.4 ? S128 * 2 : t < 0.7 ? S128 : S128 / 2;
  }
  for (const t of hits) {
    const snare = biquad(noise(0.08, r), 'bandpass', 1900, 0.8);
    const tone = osc('sine', 210, 0.08);
    for (let i = 0; i < snare.length; i++) {
      const e = Math.exp(-i / (SR * 0.025));
      snare[i] = (snare[i]! * 0.8 + tone[i]! * 0.3) * e;
    }
    sc.addMono(snare, t, 0.15 + 0.45 * (t / T), 0, 0.4);
  }
  // Саб на до большой октавы держит ноту под дропом.
  sc.addMono(sub(1.3, 160, hz(36), 0.04, 1.1, r, 0), T, 0.4);
  drop(sc, T, r, [
    [84, 0, 0.08],
    [87, 2, 0.08],
    [91, 3, 0.08],
    [96, 6, 0.45],
  ]);
  return finish(sc, {
    ping: { time: 3 * S128, fb: 0.38, wet: 0.3, lp: 6000, hp: 500, tail: 1.6 },
    room: { size: 1.2, decay: 2.2, damp: 7000, predelay: 0.015, wet: 0.42 },
    width: 1.6,
    pump: { bpm: FEST_BPM, depth: 0.6, start: T },
    glue: 1.4,
  });
}

// ── «Неон»: фильтр-хаус, резонанс, 32-е арпеджио, пинг-понг ─────

const NEON_BPM = 122;
const S122 = 60 / NEON_BPM / 4;

function neonPickup(r: Random): Stereo {
  void r;
  const blip = neon(79, 0.04, (t) => 500 + 4000 * Math.exp(-t / 0.05), 4);
  const sc = new Scene().add(chorus(blip, 1.6, 0.8), 0, 1, 0.8);
  return finish(sc, {
    ping: { time: 3 * S122, fb: 0.4, wet: 0.4, lp: 3500, hp: 700, tail: 1.3 },
    room: { size: 0.7, decay: 0.8, damp: 5000, wet: 0.2 },
    width: 1.4,
  });
}

function neonJackpot(r: Random): Stereo {
  const arp = new Mix(0.1);
  const step = S122 / 2;
  [60, 63, 67, 70].forEach((m, k) => arp.add(neon(m, step * 0.9, () => 20000, 0.7), k * step, 0.8));
  arp.add(neon(86, 0.42, () => 20000, 0.7), 5 * step, 1);
  // Фильтр открывается через всю фразу — фирменный проход фильтр-хауса.
  const opened = biquad(arp.data, 'lowpass', (t) => 600 * Math.pow(12, Math.min(1, t / 0.5)), 5);
  const pad = new Mix(0.1);
  for (const m of [60, 67, 70]) pad.add(neon(m, 0.5, () => 1800, 1), 5 * step, 0.3);
  const sc = new Scene()
    .add(chorus(opened, 2, 0.5), 0, 1, 0.7)
    .add(chorus(pad.data, 2.5, 0.35), 0, 0.8, 0.6)
    .addMono(sub(0.35, 140, 52, 0.03, 0.3, r, 0.2), 5 * step, 0.55);
  return finish(sc, {
    er: 0.2,
    ping: { time: 3 * S122, fb: 0.42, wet: 0.35, lp: 4000, hp: 600, tail: 1.6 },
    room: { size: 1, decay: 1.8, damp: 5500, wet: 0.35 },
    width: 1.5,
    pump: { bpm: NEON_BPM, depth: 0.5, start: 5 * step },
    glue: 1.2,
  });
}

function neonRecord(r: Random): Stereo {
  const arp = new Mix(0.1);
  const notes = [60, 63, 67, 70, 72, 75, 79, 82];
  let t = 0;
  notes.forEach((m, k) => {
    arp.add(neon(m, 0.05, () => 20000, 0.7), t, 0.6 + 0.4 * (k / notes.length));
    t += 0.07 - k * 0.004;
  });
  const T = t + 0.04;
  const rise = biquad(arp.data, 'lowpass', (x) => 500 * Math.pow(16, Math.min(1, x / T)), 5);
  const chord = new Mix(0.1);
  for (const m of [...Cm9hi, 84]) chord.add(neon(m, 0.5, (x) => 900 + 7000 * Math.exp(-x / 0.18), 1), 0, 0.35);
  const wah = biquad(chord.data, 'lowpass', (x) => 900 + 7000 * Math.exp(-x / 0.3), 6);
  const sc = new Scene()
    .add(chorus(rise, 2, 0.5), 0, 1, 0.7)
    .add(chorus(wah, 2.5, 0.4), T, 1, 0.75)
    .addMono(sub(0.6, 160, 48, 0.035, 0.5, r, 0.3), T, 0.9)
    .addMono(sub(0.4, 160, 48, 0.035, 0.35, r, 0.25), T + 4 * S122, 0.6);
  return finish(sc, {
    er: 0.2,
    ping: { time: 3 * S122, fb: 0.45, wet: 0.35, lp: 4000, hp: 600, tail: 2 },
    room: { size: 1.1, decay: 2.2, damp: 5500, wet: 0.4 },
    width: 1.6,
    pump: { bpm: NEON_BPM, depth: 0.5, start: T },
    glue: 1.25,
  });
}

// ── свист со сценой: тот же тембр «Подписи», новое пространство ─

function whistleStage(v: number, strong: boolean): Stereo {
  const dry = rawSound('whistle', v, true);
  const sc = new Scene().add(strong ? dry : saturate(dry, 1.15), 0, 1, 1);
  if (!strong) {
    return finish(sc, {
      er: 0.3,
      erSize: 1.2,
      room: { size: 1.1, decay: 1.8, damp: 6000, predelay: 0.022, mod: 0.35, wet: 0.45 },
      width: 1.5,
    });
  }
  // Крылья: верх тона пинг-понгом по сторонам.
  const wings = pingPong(biquad(mono(dry), 'highpass', 1200, 0.7), 0.29, 0.3, { lp: 7000, hp: 1200, tail: 1.2 });
  sc.dry.addStereo(widen(wings, 1.6), 0, 0.18);
  return finish(sc, {
    er: 0.45,
    erSize: 1.4,
    shimmer: { size: 1.35, decay: 2.6, damp: 6500, predelay: 0.03, mod: 0.45, wet: 0.55, amount: 0.28 },
    width: 1.8,
  });
}

// ── каталог ─────────────────────────────────────────────────────

export const CONCEPTS: Concept[] = [
  {
    id: 'whistle',
    title: 'Свист · объём и сцена',
    blurb:
      'Тот же свист «Подписи», порог по-прежнему настраивается. «Объём» — плотнее, ранние отражения и модулированный зал. «Сцена» — шире: шиммер в хвосте и верх тона крыльями по сторонам. Низ в обоих остаётся в моно.',
    color: '#e8af62',
    protos: [
      { id: 'whistle-now-1', label: 'Сейчас · до', tier: 'whistle', render: () => renderSound('whistle', 0), mastered: true },
      { id: 'whistle-vol-1', label: 'Объём · до', tier: 'whistle', render: () => whistleStage(0, false) },
      { id: 'whistle-stage-1', label: 'Сцена · до', tier: 'whistle', render: () => whistleStage(0, true) },
      { id: 'whistle-now-2', label: 'Сейчас · соль', tier: 'whistle', render: () => renderSound('whistle', 1), mastered: true },
      { id: 'whistle-vol-2', label: 'Объём · соль', tier: 'whistle', render: () => whistleStage(1, false) },
      { id: 'whistle-stage-2', label: 'Сцена · соль', tier: 'whistle', render: () => whistleStage(1, true) },
    ],
  },
  {
    id: 'club',
    title: 'Клуб · дип-хаус',
    blurb:
      'Органный стаб m9 в духе M1, ритм тресилло 3-3-2 на 124 BPM, верхний голос идёт ми-бемоль → соль. Хвост «дышит» под сайдчейн на четверть, эхо — пунктирной восьмой.',
    color: '#d9825b',
    protos: [
      { id: 'club-pickup', label: 'Подбор', tier: 'pickup', render: clubPickup },
      { id: 'club-jackpot', label: 'Джекпот', tier: 'jackpot', render: clubJackpot },
      { id: 'club-record', label: 'Рекорд', tier: 'record', render: clubRecord },
    ],
  },
  {
    id: 'orbit',
    title: 'Орбита · космос',
    blurb:
      'FM-колокол 1:3.5 с расстроенными парами, ноты стопкой квинт до → соль → ре → ля. Шиммер поднимает хвост октавой выше, хвост медленно облетает сцену; под ним — саб-волна и тёмная туманность.',
    color: '#8fb0e0',
    protos: [
      { id: 'orbit-pickup', label: 'Подбор', tier: 'pickup', render: orbitPickup },
      { id: 'orbit-jackpot', label: 'Джекпот', tier: 'jackpot', render: orbitJackpot },
      { id: 'orbit-record', label: 'Рекорд', tier: 'record', render: orbitRecord },
    ],
  },
  {
    id: 'fest',
    title: 'Фестиваль · EDM',
    blurb:
      'Супер-пила на 7 голосов (расстройка JP-8000), райзер и дроп с сабом на 128 BPM. Аккорд и хук лида до → ми-бемоль → соль качаются под пампинг; на рекорде перед дропом — дробь, ускоряющаяся до тридцать вторых.',
    color: '#c58fe0',
    protos: [
      { id: 'fest-pickup', label: 'Подбор', tier: 'pickup', render: festPickup },
      { id: 'fest-jackpot', label: 'Джекпот', tier: 'jackpot', render: festJackpot },
      { id: 'fest-record', label: 'Рекорд', tier: 'record', render: festRecord },
    ],
  },
  {
    id: 'neon',
    title: 'Неон · фильтр-хаус',
    blurb:
      'Френч-тач: резонансный фильтр открывается через всю фразу, арпеджио тридцать вторыми, хорус и эхо пинг-понгом. Рекорд — арпеджио на две октавы и аккорд с «вау» фильтра вниз.',
    color: '#6fd0b8',
    protos: [
      { id: 'neon-pickup', label: 'Подбор', tier: 'pickup', render: neonPickup },
      { id: 'neon-jackpot', label: 'Джекпот', tier: 'jackpot', render: neonJackpot },
      { id: 'neon-record', label: 'Рекорд', tier: 'record', render: neonRecord },
    ],
  },
];

/** Все прототипы: игровой гибрид (раунд 2) и клубные концепции (раунд 1). */
export const ALL: Concept[] = [PREMIUM_LADDER, SOFT_KIT, PREMIUM_KIT, FORGE_KIT, CYBER_KIT, ...HYBRID, ...CONCEPTS];

const BY_ID = new Map(ALL.flatMap((c) => c.protos.map((p) => [p.id, p] as const)));

/**
 * Готовый прототип: рендер 48 кГц, громкость — по лесенке ступени,
 * пик — под тот же потолок, что у нынешних звуков. Полную энергию
 * не ограничиваем: длинный хвост сцены — предмет прослушивания.
 */
/**
 * Слышимая громкость: мощность после среза ниже ~250 Гц (2-й порядок, Q 0.5) —
 * грубая A-кривая: на 100 Гц −17 дБ, на 200 Гц −8, на 500 Гц −2, как у слуха
 * на тихих UI-звуках. Бас мощности добавляет, а громкости почти нет.
 */
const heardDb = (st: Stereo): number => measureStereo(filterStereo(st, 'highpass', 250, 0.5)).rmsDb;

/** Слышимая громкость нынешнего звука ступени — по ней выставляются прототипы. */
const tierHeard = new Map<Tier, number>();
function heardOf(tier: Tier): number {
  let v = tierHeard.get(tier);
  if (v === undefined) {
    v = heardDb(renderSound(tier, 0));
    tierHeard.set(tier, v);
  }
  return v;
}

export function renderProto(id: string): Stereo {
  const p = BY_ID.get(id);
  if (!p) throw new Error(`нет прототипа ${id}`);
  return withRate(PROTO_RATE, () => {
    const raw = p.render(rng(seedOf(`club:${id}`)));
    if (p.mastered) return raw;
    const lim = limitsFor(p.tier);
    // Громкость — по слуху, а не по мощности: прототип звучит так же громко,
    // как нынешний звук его ступени, — лестница сохраняет пропорции, A/B честный.
    const target = measureStereo(raw).rmsDb + heardOf(p.tier) - heardDb(raw);
    return masterStereo(raw, target, lim.peakDb, 15000);
  });
}
