/**
 * Пространство и клубные голоса для прототипов «Клуб» (src/sfx/club.ts).
 *
 * Объём и сцена держатся на трёх правилах из практики сведения:
 *
 *  - ширину даёт только «сторона» выше ~150 Гц (M/S): низ остаётся в моно,
 *    в наушниках звук широкий, а в моно-динамике не проваливается;
 *  - глубину — ранние отражения и зал с предзадержкой: сухой удар остаётся
 *    впереди, хвост раскрывается за ним;
 *  - зал — сеть задержек с обратной связью (FDN, 8 линий, матрица
 *    Хаусхолдера) с медленной модуляцией длин: хвост плотный и «дышит»,
 *    без металлического звона гребёнок Freeverb.
 *
 * Голоса — то, чем узнаются жанры: органный стаб хауса (короткая атака,
 * без сустейна, фильтр по огибающей), супер-пила EDM (7 голосов,
 * расстройка и баланс по замерам JP-8000 у Адама Сабо), FM-колокол
 * космоса (отношение 1:3.5, слегка расстроенные пары) и сайдчейн-пампинг.
 *
 * Всё синтезировано с нуля и детерминировано сидом, как и dsp.ts.
 */
import {
  SR,
  StereoMix,
  biquad,
  blep,
  noise,
  osc,
  samples,
  type Param,
  type Signal,
  type Stereo,
} from './dsp.js';

type Random = () => number;

const valueAt = (p: Param, t: number): number => (typeof p === 'number' ? p : p(t));

/** MIDI-нота → Гц. */
export const hz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

export const smooth = (x: number): number => (x >= 1 ? 1 : x <= 0 ? 0 : (1 - Math.cos(Math.PI * x)) / 2);

// ── стерео-утилиты ──────────────────────────────────────────────

export function mono(st: Stereo): Signal {
  const n = Math.max(st.l.length, st.r.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ((st.l[i] ?? 0) + (st.r[i] ?? 0)) * 0.5;
  return out;
}

export function gainStereo(st: Stereo, g: Param): Stereo {
  const n = st.l.length;
  for (let i = 0; i < n; i++) {
    const k = valueAt(g, i / SR);
    st.l[i] = st.l[i]! * k;
    st.r[i] = (st.r[i] ?? 0) * k;
  }
  return st;
}

export function filterStereo(st: Stereo, type: 'lowpass' | 'highpass' | 'bandpass', f: Param, q = 0.707): Stereo {
  return { l: biquad(st.l, type, f, q), r: biquad(st.r, type, f, q) };
}

/** Мягкий перегруз по каналам: плотность и «клей» шины. */
export function saturate(st: Stereo, amount: number): Stereo {
  const norm = Math.tanh(amount);
  for (const ch of [st.l, st.r]) for (let i = 0; i < ch.length; i++) ch[i] = Math.tanh(ch[i]! * amount) / norm;
  return st;
}

/**
 * M/S-ширина: «сторона» ниже crossover убирается (низ — в моно),
 * выше — умножается на width. width 1 — как было.
 */
export function widen(st: Stereo, width: number, crossover = 150): Stereo {
  const n = Math.min(st.l.length, st.r.length);
  const mid = new Float32Array(n);
  let side = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    mid[i] = (st.l[i]! + st.r[i]!) * 0.5;
    side[i] = (st.l[i]! - st.r[i]!) * 0.5;
  }
  side = biquad(biquad(side, 'highpass', crossover, 0.6), 'highpass', crossover, 0.6);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = mid[i]! + side[i]! * width;
    r[i] = mid[i]! - side[i]! * width;
  }
  return { l, r };
}

/**
 * Сайдчейн-пампинг без бочки: с момента start громкость на каждой доле
 * резко приседает на depth и плавно возвращается за rel доли — «дыхание»
 * хауса. До start звук не трогается.
 */
export function pump(st: Stereo, bpm: number, depth: number, start = 0, rel = 0.6): Stereo {
  const beat = 60 / bpm;
  return gainStereo(st, (t) => {
    if (t < start) return 1;
    const phase = ((t - start) % beat) / beat;
    const u = Math.min(1, phase / rel);
    return 1 - depth * (1 - smooth(u));
  });
}

/** Медленный облёт хвоста по кругу: баланс L/R качается синусом. */
export function orbit(st: Stereo, rate: number, depth: number): Stereo {
  const n = st.l.length;
  for (let i = 0; i < n; i++) {
    const s = Math.sin(2 * Math.PI * rate * (i / SR));
    st.l[i] = st.l[i]! * (1 + depth * s);
    st.r[i] = (st.r[i] ?? 0) * (1 - depth * s);
  }
  return st;
}

// ── задержки ────────────────────────────────────────────────────

/** Чтение из кольцевого буфера с дробной задержкой (линейная интерполяция). */
function tap(buf: Float32Array, write: number, delay: number): number {
  let rp = write - delay;
  while (rp < 0) rp += buf.length;
  const i0 = Math.floor(rp);
  const frac = rp - i0;
  const i1 = i0 + 1 === buf.length ? 0 : i0 + 1;
  return buf[i0]! * (1 - frac) + buf[i1]! * frac;
}

/**
 * Пинг-понг: эхо ходит между каналами, в петле — срез низа и верха,
 * каждое повторение темнее и тоньше предыдущего. Только «мокрое».
 */
export function pingPong(
  input: Signal,
  time: number,
  feedback: number,
  o: { lp?: number; hp?: number; tail?: number } = {},
): Stereo {
  const d = samples(time);
  const n = input.length + samples(o.tail ?? time * 8);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const aLp = 1 - Math.exp((-2 * Math.PI * (o.lp ?? 5000)) / SR);
  const aHp = 1 - Math.exp((-2 * Math.PI * (o.hp ?? 300)) / SR);
  let lpL = 0, lpR = 0, hpL = 0, hpR = 0;
  for (let i = d; i < n; i++) {
    // L: вход и возврат из R; R: возврат из L.
    let vl = (input[i - d] ?? 0) + feedback * r[i - d]!;
    let vr = feedback * l[i - d]!;
    lpL += aLp * (vl - lpL);
    lpR += aLp * (vr - lpR);
    hpL += aHp * (lpL - hpL);
    hpR += aHp * (lpR - hpR);
    vl = lpL - hpL;
    vr = lpR - hpR;
    l[i] = vl;
    r[i] = vr;
  }
  return { l, r };
}

/** Ранние отражения: несколько отводов, разных в каждом канале, — стены вокруг звука. */
export function reflections(input: Signal, size = 1): Stereo {
  const taps: ReadonlyArray<readonly [number, number, number]> = [
    // мс, громкость, канал (−1 L, +1 R)
    [7.3, 0.5, -1],
    [9.1, 0.46, 1],
    [13.1, 0.36, -1],
    [15.7, 0.33, 1],
    [19.7, 0.26, -1],
    [22.9, 0.23, 1],
    [26.3, 0.18, -1],
    [29.3, 0.16, 1],
  ];
  const dark = biquad(input, 'lowpass', 6500, 0.6);
  const mix = new StereoMix(input.length / SR + 0.05 * size);
  for (const [ms, g, side] of taps) mix.add(dark, (ms * size) / 1000, g, side * 0.9);
  return mix.data;
}

/**
 * Модуляционный хорус: сухой центр и две медленно гуляющие задержки
 * в противофазе по каналам — ширина и «плёночное» движение, а в моно
 * звук не проваливается.
 */
export function chorus(input: Signal, depthMs = 2.2, rate = 0.6, base = 11, wet = 0.45): Stereo {
  const n = input.length + samples((base + depthMs + 2) / 1000);
  const buf = new Float32Array(samples(0.06));
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  let w = 0;
  for (let i = 0; i < n; i++) {
    buf[w] = input[i] ?? 0;
    const lfo = Math.sin(2 * Math.PI * rate * (i / SR));
    const dry = (input[i] ?? 0) * 0.75;
    l[i] = dry + wet * tap(buf, w, ((base + depthMs * lfo) * SR) / 1000);
    r[i] = dry + wet * tap(buf, w, ((base - depthMs * lfo) * SR) / 1000);
    w = (w + 1) % buf.length;
  }
  return { l, r };
}

/**
 * Сдвиг высоты двумя головками задержки с перекрёстным ханн-фейдом —
 * классика гармонайзеров. ratio 2 — октава вверх. Для шиммера: на
 * размытом хвосте зала окно не слышно.
 */
export function pitchShift(input: Signal, ratio: number, window = 0.05): Signal {
  const W = samples(window);
  const buf = new Float32Array(W * 2 + 4);
  const out = new Float32Array(input.length);
  let p = 0;
  let w = 0;
  const step = (1 - ratio) / W;
  for (let i = 0; i < input.length; i++) {
    buf[w] = input[i]!;
    const f1 = p - Math.floor(p);
    const f2 = (f1 + 0.5) % 1;
    const g1 = Math.sin(Math.PI * f1) ** 2;
    const g2 = 1 - g1;
    out[i] = g1 * tap(buf, w, 1 + f1 * W) + g2 * tap(buf, w, 1 + f2 * W);
    p += step;
    w = (w + 1) % buf.length;
  }
  return out;
}

// ── зал ─────────────────────────────────────────────────────────

export interface RoomOptions {
  /** Масштаб длин линий: 0.5 — комната, 1 — зал, 1.6 — собор. */
  size: number;
  /** Спад до −60 дБ, с. */
  decay: number;
  /** Срез верхов в петле, Гц: ниже — темнее хвост. */
  damp: number;
  /** Предзадержка, с: сухой удар успевает прозвучать до хвоста. */
  predelay?: number;
  /** Глубина модуляции линий, мс: против металлического звона. */
  mod?: number;
}

const LINES_MS = [31.13, 37.27, 41.91, 47.71, 53.93, 61.31, 67.13, 73.73];
const RATES = [0.13, 0.21, 0.29, 0.37, 0.43, 0.53, 0.61, 0.71];
const SIGN_L = [1, -1, 1, -1, 1, -1, 1, -1];
const SIGN_R = [1, 1, -1, -1, 1, 1, -1, -1];

/** Диффузия входа: четыре последовательных всепропускающих — атака хвоста без «флама». */
function diffuse(input: Signal, size: number): Signal {
  let x: Signal = input;
  for (const ms of [4.77, 3.59, 12.73, 9.31]) {
    const d = Math.max(1, samples((ms * Math.min(1.4, size)) / 1000));
    const buf = new Float32Array(d);
    const out = new Float32Array(x.length);
    let w = 0;
    for (let i = 0; i < x.length; i++) {
      const delayed = buf[w]!;
      const v = x[i]! + delayed * 0.6;
      out[i] = delayed - v * 0.6;
      buf[w] = v;
      w = (w + 1) % d;
    }
    x = out;
  }
  return x;
}

/**
 * Зал FDN: 8 линий, матрица Хаусхолдера, гашение верхов и медленная
 * модуляция длины в каждой линии; стерео — разные знаковые суммы линий
 * (каналы некоррелированы). Только «мокрое», длина — вход плюс хвост.
 */
export function room(input: Signal, o: RoomOptions): Stereo {
  const N = 8;
  const pre = samples(o.predelay ?? 0.015);
  const n = input.length + pre + samples(o.decay * 1.05 + 0.1);
  const x = diffuse(input, o.size);
  const len = LINES_MS.map((ms) => (ms * o.size * SR) / 1000);
  const modDepth = ((o.mod ?? 0.3) * SR) / 1000;
  const bufLen = Math.ceil(Math.max(...len) + modDepth + 4);
  const bufs = len.map(() => new Float32Array(bufLen));
  const gain = len.map((l) => Math.pow(10, (-3 * (l / SR)) / o.decay));
  const a = 1 - Math.exp((-2 * Math.PI * o.damp) / SR);
  const lp = new Float64Array(N);
  const fb = new Float64Array(N);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const norm = 1 / Math.sqrt(N);
  let w = 0;
  for (let i = 0; i < n; i++) {
    const xin = i >= pre ? (x[i - pre] ?? 0) : 0;
    const t = i / SR;
    let sum = 0;
    let ol = 0;
    let or = 0;
    for (let k = 0; k < N; k++) {
      const d = len[k]! + modDepth * Math.sin(2 * Math.PI * RATES[k]! * t + k * 0.77);
      const y = tap(bufs[k]!, w, d);
      lp[k] = lp[k]! + a * (y - lp[k]!);
      fb[k] = lp[k]! * gain[k]!;
      sum += fb[k]!;
      ol += y * SIGN_L[k]!;
      or += y * SIGN_R[k]!;
    }
    const h = (2 / N) * sum;
    for (let k = 0; k < N; k++) bufs[k]![w] = fb[k]! - h + xin * (k % 2 === 0 ? norm : -norm);
    w = (w + 1) % bufLen;
    l[i] = ol * norm;
    r[i] = or * norm;
  }
  return { l, r };
}

/**
 * Шиммер: зал, затем его хвост октавой выше снова в зал — и ещё раз.
 * Каскад вместо петли: светится так же, но не может раскачаться.
 */
export function shimmer(input: Signal, o: RoomOptions, amount: number, stages = 2): Stereo {
  const first = room(input, o);
  const mix = new StereoMix(first.l.length / SR);
  mix.addStereo(first);
  let cur = mono(first);
  for (let s = 1; s <= stages; s++) {
    const up = biquad(biquad(pitchShift(cur, 2, 0.06), 'lowpass', 9000, 0.6), 'highpass', 500, 0.6);
    const next = room(up, { ...o, predelay: 0.03, decay: o.decay * 1.15 });
    mix.addStereo(next, 0, Math.pow(amount, s));
    cur = mono(next);
  }
  return mix.data;
}

// ── голоса ──────────────────────────────────────────────────────

/**
 * ADSR-огибающая с гейтом: атака, спад до sustain, после gate — release.
 * Кривые спада и релиза экспоненциальные, как у аналоговых VCA.
 */
export function adsr(a: number, d: number, s: number, gate: number, r: number): (t: number) => number {
  const level = (t: number): number => {
    if (t < a) return smooth(t / a);
    return s + (1 - s) * Math.exp((-5 * (t - a)) / Math.max(1e-4, d));
  };
  const atGate = level(gate);
  return (t) => (t < gate ? level(t) : atGate * Math.exp((-6.9 * (t - gate)) / Math.max(1e-4, r)));
}

/** Детюн и баланс супер-пилы JP-8000 (замеры Адама Сабо). */
const SAW_OFFSETS = [-0.11002313, -0.06288439, -0.01952356, 0, 0.01991221, 0.06216538, 0.10745242];
const SAW_PANS = [-1, 0.66, -0.33, 0, 0.33, -0.66, 1];

/**
 * Супер-пила: 7 пил с полиBLEP и свободными фазами. detune 0..1 — доля
 * максимальной расстройки (±11%), сладкая зона 0.12–0.25; mix 0..1 —
 * доля боковых голосов; spread — разброс голосов по панораме.
 */
export function supersaw(freq: Param, dur: number, r: Random, detune = 0.18, mixAmt = 0.6, spread = 0.8): Stereo {
  const n = samples(dur);
  const l = new Float32Array(n);
  const rr = new Float32Array(n);
  const center = -0.55366 * mixAmt + 0.99785;
  const sideG = -0.73764 * mixAmt * mixAmt + 1.2841 * mixAmt + 0.044372;
  const phases = SAW_OFFSETS.map(() => r());
  const gl = SAW_PANS.map((p) => Math.cos(((p * spread + 1) * Math.PI) / 4));
  const gr = SAW_PANS.map((p) => Math.sin(((p * spread + 1) * Math.PI) / 4));
  for (let i = 0; i < n; i++) {
    const f = valueAt(freq, i / SR);
    let sl = 0;
    let sr = 0;
    for (let k = 0; k < 7; k++) {
      const fk = f * (1 + SAW_OFFSETS[k]! * detune);
      const dt = Math.min(0.5, fk / SR);
      const t = phases[k]!;
      const v = (2 * t - 1 - blep(t, dt)) * (k === 3 ? center : sideG);
      sl += v * gl[k]!;
      sr += v * gr[k]!;
      phases[k] = t + dt >= 1 ? t + dt - 1 : t + dt;
    }
    l[i] = sl * 0.3;
    rr[i] = sr * 0.3;
  }
  // Как у JP-8000: срез ниже основного тона убирает гул биений.
  const hp = (t: number) => valueAt(freq, t) * 0.7;
  return { l: biquad(l, 'highpass', hp, 0.7), r: biquad(rr, 'highpass', hp, 0.7) };
}

/**
 * Органный стаб хауса (дух M1 «Organ 2»): синусы-регистры 8', 4', 2 2/3',
 * 2', 1 1/3', 1', щелчок клавиши. Огибающую и фильтр задаёт вызывающий.
 */
export function organ(f: number, dur: number, r: Random): Signal {
  const out = new Float32Array(samples(dur));
  const bars: ReadonlyArray<readonly [number, number]> = [
    [1, 1],
    [2, 0.75],
    [3, 0.42],
    [4, 0.5],
    [6, 0.22],
    [8, 0.16],
  ];
  for (const [ratio, g] of bars) {
    if (f * ratio > SR * 0.45) continue;
    const s = osc('sine', f * ratio * (1 + (r() - 0.5) * 0.0016), dur);
    for (let i = 0; i < out.length; i++) out[i] = out[i]! + s[i]! * g * 0.3;
  }
  const click = biquad(noise(0.006, r), 'bandpass', 2600, 0.8);
  for (let i = 0; i < click.length; i++) {
    out[i] = out[i]! + click[i]! * 0.35 * (1 - i / click.length);
  }
  return out;
}

/**
 * FM-колокол: несущая и модулятор 1:ratio, индекс гаснет быстрее тона —
 * звон в атаке, чистый тон в хвосте. Две пары, расстроенные на ±det
 * центов и разведённые по каналам, — живое хоровое мерцание.
 */
export function bell(f: number, dur: number, o: { ratio?: number; index?: number; decay?: number; det?: number } = {}): Stereo {
  const ratio = o.ratio ?? 3.5;
  const index = o.index ?? 2.4;
  const decay = o.decay ?? dur * 0.6;
  const det = o.det ?? 4;
  const mix = new StereoMix(dur);
  for (const side of [-1, 1] as const) {
    const fc = f * Math.pow(2, (side * det) / 1200);
    const mod = osc('sine', fc * ratio, dur);
    for (let i = 0; i < mod.length; i++) mod[i] = mod[i]! * index * Math.exp(-(i / SR) / (decay * 0.18));
    const car = osc('sine', fc, dur, mod);
    for (let i = 0; i < car.length; i++) {
      const t = i / SR;
      car[i] = car[i]! * Math.min(1, t / 0.002) * Math.exp((-6.9 * t) / decay);
    }
    mix.add(car, 0, 0.6, side * 0.55);
  }
  return mix.data;
}

/** Саб-удар: синус с падающей высотой (бочка/808) и щелчок атаки. */
export function sub(dur: number, from: number, to: number, glide: number, decay: number, r: Random, click = 0.3): Signal {
  const body = osc('sine', (t) => to + (from - to) * Math.exp(-t / glide), dur);
  for (let i = 0; i < body.length; i++) {
    const t = i / SR;
    body[i] = body[i]! * Math.min(1, t / 0.002) * Math.exp((-6.9 * t) / decay);
  }
  if (click > 0) {
    const c = biquad(noise(0.012, r), 'bandpass', 3200, 0.7);
    for (let i = 0; i < c.length; i++) body[i] = body[i]! + c[i]! * click * Math.exp(-i / (SR * 0.002));
  }
  return body;
}

/**
 * Райзер: шум в полосе, ползущей вверх, и громкость, растущая к концу;
 * в каждом канале свой шум — подъём заполняет всю сцену.
 */
export function riser(dur: number, r: Random, from = 500, to = 7000): Stereo {
  const mix = new StereoMix(dur);
  const sweep = (t: number) => from * Math.pow(to / from, Math.pow(t / dur, 1.4));
  for (const side of [-1, 1] as const) {
    const s = biquad(noise(dur, r), 'bandpass', sweep, 1.6);
    for (let i = 0; i < s.length; i++) s[i] = s[i]! * Math.pow(i / s.length, 2.2);
    mix.add(s, 0, 0.8, side * 0.85);
  }
  return mix.data;
}

// ── игровые слои: удар, свечение, искры, угольки, движение ─────

/** Задом наперёд: из хвоста зала получается «вдох» перед ударом. */
export function reverse(sig: Signal): Signal {
  return sig.slice().reverse();
}

/** Мода удара: отношение к основному тону, громкость, спад до −60 дБ (с). */
export type Mode = readonly [ratio: number, gain: number, decay: number];

/** Свободный брусок (наковальня, металлическая пластина): 1 : 2.756 : 5.404 : 8.933. */
export const BAR = [1, 2.756, 5.404, 8.933, 13.34] as const;
/** Стекло и кристалл: моды теснее и звонче бруска. */
export const GLASS = [1, 2.32, 4.25, 6.63, 9.38] as const;

/**
 * Модальный удар: набор негармонических синусов, у каждого свой спад.
 * Верхние моды гаснут быстрее и стоят шире — удар раскрывается по сцене.
 */
export function modal(f: number, modes: readonly Mode[], r: Random, spread = 0.6): Stereo {
  const dur = Math.max(...modes.map((m) => m[2])) + 0.05;
  const mix = new StereoMix(dur);
  modes.forEach(([ratio, gain, decay], k) => {
    const fk = f * ratio * (1 + (r() - 0.5) * 0.002);
    if (fk > SR * 0.45) return;
    const s = osc('sine', fk, decay + 0.05);
    for (let i = 0; i < s.length; i++) {
      const t = i / SR;
      s[i] = s[i]! * Math.min(1, t / 0.0008) * Math.exp((-6.9 * t) / decay);
    }
    const pan = k === 0 ? 0 : (k % 2 ? -1 : 1) * spread * Math.min(1, k / 3);
    mix.add(s, 0, gain * 0.5, pan);
  });
  return mix.data;
}

/** Набор мод из строя: громкость и спад падают к верху. */
export function modes(ratios: readonly number[], decay: number, tilt = 0.55, gains?: readonly number[]): Mode[] {
  return ratios.map((ratio, k) => [ratio, gains?.[k] ?? Math.pow(tilt, k), decay / Math.pow(ratio, 0.6)] as const);
}

/**
 * Свечение — тон семьи «Подписи»: синус с тремоло 16 Гц и лёгкой
 * 2-й гармоникой. Им новые звуки родня свисту.
 */
export function glow(f: number, o: { swell?: number; hold?: number; decay?: number; depth?: number } = {}): Signal {
  const swell = o.swell ?? 0.02;
  const hold = o.hold ?? 0.2;
  const decay = o.decay ?? 0.8;
  const depth = o.depth ?? 0.28;
  const dur = swell + hold + decay + 0.05;
  const a = osc('sine', f, dur);
  const b = osc('sine', f * 2, dur);
  const out = new Float32Array(a.length);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const env = t < swell ? smooth(t / swell) : t < swell + hold ? 1 : Math.exp((-6.9 * (t - swell - hold)) / decay);
    const trem = 1 - depth * 0.5 * (1 - Math.cos(2 * Math.PI * 16 * t));
    out[i] = (a[i]! + b[i]! * 0.06) * env * trem * 0.6;
  }
  return out;
}

const PENTA = [0, 3, 5, 7, 10];

/**
 * Искры: короткие звонкие зёрна по пентатонике до минора, случайно
 * по высоте и по сцене; density(t) — зёрен в секунду.
 */
export function sparkles(
  dur: number,
  r: Random,
  density: (t: number) => number,
  o: { low?: number; high?: number; decay?: number } = {},
): Stereo {
  const low = o.low ?? 88;
  const high = o.high ?? 103;
  const pool: number[] = [];
  for (let m = low; m <= high; m++) if (PENTA.includes(((m % 12) + 12) % 12)) pool.push(m);
  const mix = new StereoMix(dur + 0.3);
  const dt = 0.002;
  for (let t = 0; t < dur; t += dt) {
    if (r() >= density(t) * dt) continue;
    const m = pool[Math.floor(r() * pool.length)]!;
    const decay = (o.decay ?? 0.1) * (0.5 + r());
    const g = glowGrain(hz(m), decay);
    mix.add(g, t, 0.15 + 0.25 * r(), r() * 1.9 - 0.95);
  }
  return mix.data;
}

function glowGrain(f: number, decay: number): Signal {
  const s = osc('sine', f, decay + 0.01);
  for (let i = 0; i < s.length; i++) {
    const t = i / SR;
    s[i] = s[i]! * Math.min(1, t / 0.002) * Math.exp((-6.9 * t) / decay);
  }
  return s;
}

/** Угольки: редкий треск — щелчки шума в полосе 1.5–6 кГц по всей сцене. */
export function embers(dur: number, r: Random, density: (t: number) => number): Stereo {
  const mix = new StereoMix(dur + 0.05);
  const dt = 0.002;
  for (let t = 0; t < dur; t += dt) {
    if (r() >= density(t) * dt) continue;
    const len = 0.002 + r() * 0.005;
    const c = biquad(noise(len, r), 'bandpass', 1500 + r() * 4500, 1.5);
    for (let i = 0; i < c.length; i++) c[i] = c[i]! * (1 - i / c.length) ** 2;
    mix.add(c, t, 0.3 + 0.7 * r(), r() * 1.9 - 0.95);
  }
  return mix.data;
}

/**
 * «Вдох»: зал от звука src, развёрнутый задом наперёд и обрезанный
 * до len — нарастает и обрывается ровно в точке удара.
 */
export function inhale(src: Signal, len: number, o: RoomOptions): Stereo {
  const wet = room(src, o);
  const n = samples(len);
  const cut = (ch: Signal): Signal => {
    const rev = reverse(ch);
    const out = new Float32Array(n);
    const off = Math.max(0, rev.length - n);
    for (let i = 0; i < n; i++) out[i] = (rev[off + i] ?? 0) * smooth(i / (n * 0.3));
    return out;
  };
  return { l: cut(wet.l), r: cut(wet.r) };
}

/**
 * Провал после удара: с момента at громкость уходит на depth
 * и за release возвращается — ощущение сайдчейна без темпа.
 */
export function duckAt(st: Stereo, at: number, depth: number, release: number): Stereo {
  return gainStereo(st, (t) => (t < at ? 1 : 1 - depth * (1 - smooth((t - at) / release))));
}

// ── премиум-цепочка: то, чем дорогой UI-звук отличается от синтетики ──

/**
 * Аналоговый генератор: несколько голосов со случайной фазой, лёгкой
 * расстройкой и медленным дрейфом высоты — живой, а не «идеальный» тон.
 */
export function analog(f: Param, dur: number, r: Random, o: { shape?: 'saw' | 'square'; voices?: number; detune?: number } = {}): Signal {
  const voices = o.voices ?? 2;
  const detune = o.detune ?? 0.004;
  const out = new Float32Array(samples(dur));
  for (let v = 0; v < voices; v++) {
    const off = voices > 1 ? (v / (voices - 1) - 0.5) * 2 * detune : 0;
    const rate = 0.4 + r() * 0.8;
    const ph = r() * 2 * Math.PI;
    const phase = new Float32Array(out.length).fill(r() * 2 * Math.PI);
    const s = osc(o.shape ?? 'saw', (t) => valueAt(f, t) * (1 + off) * (1 + 0.0015 * Math.sin(2 * Math.PI * rate * t + ph)), dur, phase);
    for (let i = 0; i < out.length; i++) out[i] = out[i]! + s[i]! / voices;
  }
  return out;
}

/**
 * Лестничный фильтр 24 дБ/окт: четыре однополюсника и обратная связь
 * через tanh — мягкий резонанс и тёплая перегрузка входа, как у аналога.
 */
export function ladder(sig: Signal, cutoff: Param, res = 0.3, drive = 1): Signal {
  const out = new Float32Array(sig.length);
  let s1 = 0, s2 = 0, s3 = 0, s4 = 0, g = 0;
  for (let i = 0; i < sig.length; i++) {
    if (i % 16 === 0) g = 1 - Math.exp((-2 * Math.PI * Math.min(SR * 0.45, valueAt(cutoff, i / SR))) / SR);
    const x = Math.tanh(drive * sig[i]! - 4 * res * s4);
    s1 += g * (x - s1);
    s2 += g * (s1 - s2);
    s3 += g * (s2 - s3);
    s4 += g * (s3 - s4);
    out[i] = s4;
  }
  return out;
}

/** Возбуждение удара: короткий всплеск шума с экспоненциальным спадом. */
export function impulse(r: Random, len = 0.003): Signal {
  const n = noise(len * 3, r);
  for (let i = 0; i < n.length; i++) n[i] = n[i]! * Math.exp(-i / (SR * len * 0.5));
  return n;
}

/** Резонатор материала: (частота, добротность, громкость) — у удара появляется тело. */
export type Res = readonly [f: number, q: number, gain: number];

export function resonate(exc: Signal, bank: readonly Res[], tail = 0.4): Signal {
  const src = new Float32Array(exc.length + samples(tail));
  src.set(exc);
  const out = new Float32Array(src.length);
  for (const [f, q, g] of bank) {
    if (f > SR * 0.45) continue;
    const b = biquad(src, 'bandpass', f, q);
    for (let i = 0; i < out.length; i++) out[i] = out[i]! + b[i]! * g * Math.sqrt(q);
  }
  return out;
}

/** Микро-Haas: копия на 0.2–0.8 мс позже в одном канале — транзиент шире, тон в моно не страдает. */
export function haas(sig: Signal, ms = 0.4, side: 1 | -1 = 1): Stereo {
  const d = Math.max(1, Math.round((ms * SR) / 1000));
  const late = new Float32Array(sig.length + d);
  late.set(sig, d);
  const early = new Float32Array(sig.length + d);
  early.set(sig);
  return side > 0 ? { l: early, r: late } : { l: late, r: early };
}

const peakOf = (st: Stereo): number => {
  let p = 1e-9;
  for (const ch of [st.l, st.r]) for (const x of ch) p = Math.max(p, Math.abs(x));
  return p;
};

/** Компрессор по пику обоих каналов: порог в дБ от пика, быстрая атака — «склейка» слоёв. */
export function compress(st: Stereo, below = 10, ratio = 3, attack = 0.002, release = 0.08): Stereo {
  const th = peakOf(st) * Math.pow(10, -below / 20);
  const a = Math.exp(-1 / (SR * attack));
  const rel = Math.exp(-1 / (SR * release));
  let env = 0;
  const n = Math.min(st.l.length, st.r.length);
  for (let i = 0; i < n; i++) {
    const x = Math.max(Math.abs(st.l[i]!), Math.abs(st.r[i]!));
    env = x > env ? a * env + (1 - a) * x : rel * env + (1 - rel) * x;
    const g = env > th ? Math.pow(env / th, 1 / ratio - 1) : 1;
    st.l[i] = st.l[i]! * g;
    st.r[i] = st.r[i]! * g;
  }
  return st;
}

/** Лента: несимметричное мягкое насыщение — тёплые чётные гармоники; вход выводится к пику 1. */
export function tape(st: Stereo, drive = 1.3): Stereo {
  const k = 1 / peakOf(st);
  const norm = Math.tanh(drive);
  const ch = (s: Signal): Signal => {
    const o = s.map((x) => {
      const y = x * k;
      return Math.tanh(drive * (y + 0.08 * y * y)) / norm;
    }) as Signal;
    return biquad(o, 'highpass', 25, 0.7);
  };
  return { l: ch(st.l), r: ch(st.r) };
}

/**
 * Воздух: верх сигнала слегка перегружается и выше 7 кГц подмешивается
 * обратно — гладкий «блеск» вместо звенящего писка. amount — доля громкости.
 */
export function air(st: Stereo, amount = 0.12, from = 3000): Stereo {
  const ch = (s: Signal): Signal => {
    const h = biquad(s, 'highpass', from, 0.7);
    let rs = 0, rh = 0;
    for (let i = 0; i < s.length; i++) rs += s[i]! ** 2;
    const sat = h.map((x) => Math.tanh(x * 8)) as Signal;
    const e = biquad(biquad(sat, 'highpass', 7000, 0.7), 'highpass', 7000, 0.7);
    for (let i = 0; i < e.length; i++) rh += e[i]! ** 2;
    const g = rh > 0 ? amount * Math.sqrt(rs / rh) * 0.3 : 0;
    return s.map((x, i) => x + e[i]! * g) as Signal;
  };
  return { l: ch(st.l), r: ch(st.r) };
}
