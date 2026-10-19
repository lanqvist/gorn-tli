/**
 * Прототипы раунда 2 — «по партитуре эталона»: от эталонного
 * оповещения о дорогой валюте берём не тембр, а наполнение
 * и исполнение, тембры — свои (космос, кузня, EDM).
 *
 * Партитура эталона, снятая покадрово (окно 50 мс; громкость —
 * от самого громкого места, S/M — сторона против центра):
 *
 *   0–0.05 с    вспышка: короткий яркий верх 2–12 кГц, ≈ −10 дБ, широко;
 *   0–0.55 с    вздох: почти всё ниже 250 Гц, и это САМОЕ громкое место
 *               (пик ≈ 0.25 с), к удару отступает на −6 дБ; шире центра
 *               (S/M +2…+6 дБ);
 *   0.55–1.15 с тон: одна нота (до, 527 Гц) в центре (S/M −10…−15),
 *               −3…−5 дБ от пика вздоха, живое мерцание; низ уходит;
 *   ~1.15 с     просадка на 7 дБ;
 *   1.2–1.9 с   хвост: тон тает −15 → −34 дБ, снизу возвращаются низкие тона;
 *   1.95–2.3 с  космос: −42…−54 дБ, 0.7–5 кГц, снова широко.
 *
 * Вторая модель — сфера возвышения (exalted), другая партитура:
 *
 *   0–0.55 с    одна глубокая саб-нота ≈51 Гц (не шум), пик сразу,
 *               к удару сползает на −8 дБ;
 *   0.6–1.05 с  вспышка: яркий звенящий кластер (2–12 кГц до −6 дБ)
 *               и негармонические тона 190/337/613/1150 Гц, ближе к центру;
 *   1.05–1.75 с тело: низко-средний металлический звон 70–340 Гц,
 *               тает −12 → −28 дБ;
 *   1.9–2.4 с   космос: тихий колокольный кластер 0.9–1.5 кГц, широко.
 *
 * Удар здесь — не щелчок, а смена регистра: широкий низ уходит,
 * в центре загорается одна нота. perform() раскладывает слои палитры
 * по этой партитуре и выставляет их громкость замером, а не на глаз.
 */
import { SR, StereoMix, biquad, noise, osc, type Signal, type Stereo } from './dsp.js';
import {
  BAR,
  GLASS,
  embers,
  sub,
  saturate,
  filterStereo,
  glow,
  hz,
  inhale,
  modal,
  modes,
  mono,
  smooth,
  sparkles,
  supersaw,
} from './fx.js';
import { Scene, finish, type Concept, type Space } from './scene.js';

type Random = () => number;

// ── партитура ───────────────────────────────────────────────────

interface Score {
  /** Длина вздоха до тона, с (эталон — 0.55). */
  pre: number;
  /** Где вздох громче всего, доля от pre (эталон — ≈0.45). */
  peak: number;
  /** Сколько тон держится до просадки, с (эталон — 0.6). */
  hold: number;
  /** Просадка, дБ (эталон — 7). */
  sag: number;
  /** Скорость таяния хвоста, дБ/с (эталон — ≈30). */
  fade: number;
  /** Ноты: множитель основного тона и отступ от начала тона, с. */
  notes: ReadonlyArray<readonly [ratio: number, at: number]>;
  /** Сколько тон живёт после просадки, с (у эталона ≈0.8). */
  tail: number;
  /** Сколько длится россыпь в хвосте, с. */
  dust: number;
}

/** Уровни слоёв относительно пика вздоха, дБ — по эталону. */
const LEVEL = { flash: -8, tone: -4, strike: -9, under: -17, dust: -30 };

interface Palette {
  /** Широкий низ вздоха постоянной громкости; огибающую задаёт партитура. */
  breath(len: number, r: Random): Stereo;
  /** Вспышка в самом начале. */
  flash(r: Random): Stereo;
  /** Тело тона постоянной громкости, строго в центре. */
  tone(f: number, len: number, r: Random): Signal;
  /** Удар на входе тона со своей огибающей (может не быть). */
  strike?(f: number, r: Random): Stereo;
  /** Свои уровни слоёв поверх эталонных (тяжёлый удар громче). */
  levels?: Partial<typeof LEVEL>;
  /** Низкие тона под хвостом, постоянной громкости. */
  under(f: number, len: number): Stereo;
  /** Россыпь в хвосте: искры, эхо — со своей огибающей (может не быть). */
  dust?(len: number, r: Random): Stereo;
  space: Space;
}

const ROOT = 523.25;
const db = (x: number) => Math.pow(10, x / 20);

/** Громкость окна [from, to) — средняя мощность двух каналов, дБ. */
function level(st: Stereo, from: number, to: number): number {
  const a = Math.max(0, Math.floor(from * SR));
  const b = Math.min(st.l.length, Math.floor(to * SR));
  let sum = 0;
  for (let i = a; i < b; i++) sum += (st.l[i]! ** 2 + (st.r[i] ?? 0) ** 2) / 2;
  return 10 * Math.log10(sum / Math.max(1, b - a) + 1e-20);
}

function scaleTo(st: Stereo, current: number, target: number): Stereo {
  const g = db(target - current);
  for (const ch of [st.l, st.r]) for (let i = 0; i < ch.length; i++) ch[i] = ch[i]! * g;
  return st;
}

function shaped(st: Stereo, env: (t: number) => number): Stereo {
  for (const ch of [st.l, st.r]) for (let i = 0; i < ch.length; i++) ch[i] = ch[i]! * env(i / SR);
  return st;
}

const centered = (s: Signal): Stereo => ({ l: s, r: s.slice() });

function perform(p: Palette, s: Score, r: Random, root = ROOT): Stereo {
  const T = s.pre;
  const L = { ...LEVEL, ...p.levels };
  const sc = new Scene();

  // Вздох: нарастает к пику, к удару отступает на 6 дБ, после — быстро уходит.
  const peakAt = T * s.peak;
  const breathEnv = (t: number): number => {
    if (t < peakAt) return Math.min(1, t / 0.01) * db(-8 * (1 - smooth(t / peakAt)));
    if (t < T) return db((-6 * (t - peakAt)) / (T - peakAt));
    return db(-6) * Math.exp(-(t - T) / 0.12);
  };
  const breath = shaped(p.breath(T + 0.6, r), breathEnv);
  const ref = level(breath, peakAt - 0.025, peakAt + 0.025);
  if (T > 0) sc.add(breath, 0, 1);

  const flash = p.flash(r);
  sc.add(scaleTo(flash, level(flash, 0, 0.05), ref + L.flash), 0, 1, 0.5);

  // Тон: короткое разгорание, удержание, просадка, таяние.
  const sagGain = db(-s.sag);
  const tail = s.tail;
  const toneEnv = (hold: number) => (t: number): number => {
    if (t < 0.03) return smooth(t / 0.03);
    if (t < hold) return 1;
    if (t < hold + 0.06) return 1 + (sagGain - 1) * smooth((t - hold) / 0.06);
    const u = t - hold - 0.06;
    return sagGain * db(-s.fade * u) * (1 - smooth((u - tail + 0.25) / 0.25));
  };
  s.notes.forEach(([ratio, at], k) => {
    const hold = Math.max(0.05, s.hold - at);
    const len = hold + 0.06 + tail;
    const body = shaped(centered(p.tone(root * ratio, len, r)), toneEnv(hold));
    const lv = level(body, 0.05, Math.min(hold, 0.3));
    sc.add(scaleTo(body, lv, ref + L.tone - k * 2.5), T + at, 1, 0.8);
    const strike = p.strike?.(root * ratio, r);
    if (strike) sc.add(scaleTo(strike, level(strike, 0, 0.05), ref + L.strike - k * 2.5), T + at, 1, 0.7);
  });

  // Низкие тона возвращаются под хвостом.
  const underLen = s.hold + 0.06 + tail;
  const under = shaped(p.under(root, underLen), (t) =>
    smooth(t / 0.15) * (t < s.hold ? 1 : db(-s.fade * 0.6 * (t - s.hold))) * (1 - smooth((t - underLen + 0.25) / 0.25)),
  );
  sc.add(scaleTo(under, level(under, 0.15, 0.3), ref + L.under), T + 0.05, 1);

  if (s.dust > 0 && p.dust) {
    const dust = p.dust(s.dust, r);
    sc.add(scaleTo(dust, level(dust, 0, Math.min(0.4, s.dust)), ref + L.dust), T + 0.05, 1, 0.9);
  }
  return finish(sc, p.space);
}

// ── партитура возвышения ────────────────────────────────────────

interface RisePalette {
  /** Глубокая саб-нота постоянной громкости. */
  sub(len: number, r: Random): Stereo;
  /** Звенящая вспышка со своей огибающей (≈0.45 с). */
  burst(r: Random): Stereo;
  /** Низко-средний металлический звон постоянной громкости. */
  ring(len: number, r: Random): Stereo;
  /** Тихий колокольный кластер космоса со своей огибающей (может не быть). */
  bells?(len: number, r: Random): Stereo;
  /** Удар в точке вспышки без огибающей вспышки: саб-бум, тело (может не быть). */
  impact?(r: Random): Stereo;
  /** Свои уровни слоёв поверх эталонных. */
  levels?: Partial<typeof RISE>;
  space: Space;
}

/** Уровни слоёв возвышения относительно пика саба, дБ — по эталону. */
const RISE = { burst: -11, ring: -12, bells: -30, impact: -4 };

interface RiseShape {
  /** Длина саба до вспышки, с (эталон — 0.58). */
  T: number;
  /** Сколько тело держится до таяния, с (эталон — 0.45). */
  ringHold: number;
  /** Скорость таяния тела, дБ/с (эталон — ≈25). */
  ringFade: number;
  /** Когда тело уходит совсем, с от вспышки (эталон — ≈1.3). */
  ringEnd: number;
}

const EXALTED_SHAPE: RiseShape = { T: 0.58, ringHold: 0.45, ringFade: 25, ringEnd: 1.3 };

function performRise(p: RisePalette, r: Random, sh: RiseShape = EXALTED_SHAPE): Stereo {
  const { T } = sh;
  const L = { ...RISE, ...p.levels };
  const sc = new Scene();
  const subEnv = (t: number): number => {
    if (t < 0.05) return smooth(t / 0.05);
    if (t < T) return db((-8 * (t - 0.05)) / (T - 0.05));
    return db(-8) * Math.exp(-(t - T) / 0.5) * (1 - smooth((t - T - sh.ringEnd + 0.3) / 0.3));
  };
  const sub = shaped(p.sub(T + sh.ringEnd + 0.3, r), subEnv);
  const ref = level(sub, 0.03, 0.08);
  sc.add(sub, 0, 1, 0.05);

  const burst = p.burst(r);
  sc.add(scaleTo(burst, level(burst, 0.1, 0.4), ref + L.burst), T, 1, 0.7);

  const impact = p.impact?.(r);
  if (impact) sc.add(scaleTo(impact, level(impact, 0, 0.1), ref + L.impact), T, 1, 0.4);

  const ringLen = sh.ringEnd + 0.5;
  const ring = shaped(p.ring(ringLen, r), (t) =>
    smooth(t / 0.1) * db(-sh.ringFade * Math.max(0, t - sh.ringHold)) * (1 - smooth((t - sh.ringEnd + 0.3) / 0.3)),
  );
  sc.add(scaleTo(ring, level(ring, 0.3, 0.5), ref + L.ring), T + 0.03, 1, 0.5);

  if (p.bells) {
    const bells = shaped(p.bells(1.8, r), (t) => Math.exp(-t / 0.45));
    sc.add(scaleTo(bells, level(bells, 0, 0.2), ref + L.bells), T + 0.5, 1, 0.9);
  }
  return finish(sc, p.space);
}

// ── общие кирпичики ─────────────────────────────────────────────

/** Свой отфильтрованный шум в каждом канале — широкий низ, как у эталона. */
function wideLow(len: number, r: Random, cut: number, grit = 0, hiss = 0): Stereo {
  const out = new StereoMix(len);
  for (const side of [-1, 1] as const) {
    let low = biquad(biquad(noise(len, r), 'lowpass', cut, 0.7), 'lowpass', cut, 0.7);
    if (grit > 0) {
      const mid = biquad(noise(len, r), 'bandpass', 480, 0.7);
      low = low.map((x, i) => x + mid[i]! * grit) as Signal;
    }
    if (hiss > 0) {
      const air = biquad(biquad(noise(len, r), 'highpass', 2000, 0.7), 'lowpass', 9000, 0.7);
      low = low.map((x, i) => x + air[i]! * hiss) as Signal;
    }
    out.add(low, 0, 1, side);
  }
  return out.data;
}

/** Низкие синусы с лёгкой расстройкой между каналами — медленные биения, «пространство» низа. */
function lowChord(ratios: readonly number[], f: number, len: number, beat = 0.6): Stereo {
  const out = new StereoMix(len);
  const quarter = new Float32Array(Math.round(len * SR) + 1).fill(Math.PI / 3);
  for (const ratio of ratios) {
    out.add(osc('sine', f * ratio - beat / 2, len), 0, 0.5, -1);
    out.add(osc('sine', f * ratio + beat / 2, len, quarter), 0, 0.5, 1);
  }
  return out.data;
}

/** Воздух вспышки: шум выше 5 кГц, свой в каждом канале, гаснет за ~40 мс. */
function air(r: Random): Stereo {
  const out = new StereoMix(0.08);
  for (const side of [-1, 1] as const) {
    const n = biquad(biquad(noise(0.08, r), 'highpass', 5000, 0.7), 'highpass', 5000, 0.7);
    for (let i = 0; i < n.length; i++) n[i] = n[i]! * Math.exp(-i / (SR * 0.018));
    out.add(n, 0, 1, side);
  }
  return out.data;
}

const withAir = (st: Stereo, r: Random, g = 0.6): Stereo => new StereoMix(0.1).addStereo(st).addStereo(air(r), 0, g).data;

/** Тон-подпись: синус, тремоло 16 Гц, капля 2-й гармоники — постоянной громкости. */
function steadyGlow(f: number, len: number, depth = 0.28): Signal {
  return glow(f, { swell: 0.001, hold: len, decay: 0.01, depth });
}

function sparkleFlash(r: Random, low = 96, high = 108): Stereo {
  return sparkles(0.06, r, () => 260, { low, high, decay: 0.05 });
}

// ── «Эфир»: космос — тёплый гул пустоты, кристалл, искры, шиммер ─

const ETHER: Palette = {
  breath: (len, r) => {
    const st = new StereoMix(len).addStereo(wideLow(len, r, 280, 0.1, 0.03), 0, 1).addStereo(lowChord([0.125, 0.25], ROOT, len, 0.8), 0, 0.3);
    return st.data;
  },
  flash: (r) => withAir(sparkleFlash(r, 96, 115), r),
  tone: (f, len) => steadyGlow(f, len),
  strike: (f, r) => modal(f, modes(GLASS, 1, 0.45), r, 0.3),
  under: (f, len) => lowChord([0.125, 0.25], f, len, 0.5),
  dust: (len, r) => sparkles(len, r, (t) => 30 * Math.exp(-t / (len * 0.4)), { low: 84, high: 100, decay: 0.12 }),
  space: {
    er: 0.1,
    shimmer: { size: 1.4, decay: 1.9, damp: 6500, predelay: 0.025, mod: 0.5, wet: 0.28, amount: 0.4 },
    width: 1.6,
  },
};

// ── «Горн»: мехи раздувают огонь, металл звенит и поёт, угольки ──

const FORGE: Palette = {
  breath: (len, r) => {
    // Мехи: шершавый тёплый рёв огня, низ свой в каждом канале.
    const roar = wideLow(len, r, 260, 0.12, 0.02);
    return new StereoMix(len).addStereo(roar, 0, 1).addStereo(lowChord([0.125], ROOT, len, 0.4), 0, 0.2).data;
  },
  flash: (r) => withAir(modal(hz(91), modes(BAR, 0.08, 0.6), r, 0.7), r),
  tone: (f, len, r) => {
    // Раскалённый металл поёт: тон и тихие моды бруска, тянущиеся вместе с ним.
    const body = steadyGlow(f, len, 0.22);
    const ring = modal(f, BAR.slice(1, 3).map((ratio, k) => [ratio, 0.12 / (k + 1), len] as const), r, 0);
    for (let i = 0; i < body.length; i++) body[i] = body[i]! + ((ring.l[i] ?? 0) + (ring.r[i] ?? 0)) * 0.5;
    return body;
  },
  strike: (f, r) => modal(f / 2, modes(BAR, 0.9, 0.6), r, 0.4),
  under: (f, len) => lowChord([0.125, 0.25], f, len, 0.3),
  space: {
    er: 0.25,
    room: { size: 1.2, decay: 1.7, damp: 4800, predelay: 0.02, mod: 0.4, wet: 0.3 },
    shimmer: { size: 1.2, decay: 1.6, damp: 5500, predelay: 0.03, wet: 0.1, amount: 0.25 },
    width: 1.5,
  },
};

// ── «Портал»: EDM — риз-саб, яркий щелчок пилы, узкий лид, эхо ──

const PORTAL: Palette = {
  breath: (len, r) => {
    // Риз: две расстроенные пилы на до большой октавы — своя в каждом канале.
    const out = new StereoMix(len);
    for (const side of [-1, 1] as const) {
      const f = (t: number) => hz(36) * (1 + side * 0.006) * Math.pow(0.97, t);
      const saw = biquad(biquad(osc('saw', f, len), 'lowpass', 230, 0.8), 'lowpass', 230, 0.7);
      out.add(saw, 0, 1, side);
    }
    return out.addStereo(wideLow(len, r, 200, 0.08, 0.025), 0, 0.5).data;
  },
  flash: (r) => {
    const st = supersaw(hz(96), 0.07, r, 0.25, 0.7, 1);
    const f = filterStereo(st, 'highpass', 2000, 0.7);
    return shaped(f, (t) => Math.exp(-t / 0.018));
  },
  tone: (f, len, r) => {
    // Узкий лид: супер-пила без разброса, тёмная, на ядре тона-подписи.
    const saw = supersaw(f, len, r, 0.14, 0.55, 0);
    const lead = biquad(saw.l, 'lowpass', 2200, 0.7);
    const core = steadyGlow(f, len, 0.18);
    for (let i = 0; i < core.length; i++) core[i] = core[i]! + (lead[i] ?? 0) * 0.35;
    return core;
  },
  under: (f, len) => lowChord([0.125, 0.25], f, len, 0.4),
  dust: (len, r) => {
    const st = supersaw(hz(84), 0.05, r, 0.2, 0.6, 1);
    return shaped(filterStereo(st, 'lowpass', 5000, 0.7), (t) => Math.exp(-t / 0.02) * (len > 0 ? 1 : 0));
  },
  space: {
    er: 0.15,
    ping: { time: 0.19, fb: 0.38, wet: 0.22, lp: 6000, hp: 700, tail: 1.1 },
    room: { size: 1.3, decay: 1.8, damp: 7500, predelay: 0.02, mod: 0.5, wet: 0.28 },
    width: 1.7,
  },
};

// ── палитры возвышения ──────────────────────────────────────────

/** Саб-нота соль контроктавы: доминанта, которая разрешится в до вспышки. */
const G1 = hz(31);

/** Саб-нота: синус с каплей октавы, каналы чуть расстроены; glideFrom — падение высоты в начале. */
function subNote(len: number, glideFrom = 0): Stereo {
  const out = new StereoMix(len);
  for (const side of [-1, 1] as const) {
    const base = G1 + side * 0.2;
    const f = (t: number) => (glideFrom > 0 ? base * (1 + (glideFrom / G1 - 1) * Math.exp(-t / 0.08)) : base);
    const phase = new Float32Array(Math.round(len * SR) + 1).fill(side > 0 ? Math.PI / 3 : 0);
    const s = osc('sine', f, len, phase);
    const h = osc('sine', (t) => f(t) * 2, len, phase);
    const h3 = osc('sine', (t) => f(t) * 3, len, phase);
    const h5 = osc('sine', (t) => f(t) * 5, len, phase);
    for (let i = 0; i < s.length; i++) s[i] = s[i]! + h[i]! * 0.35 + h3[i]! * 0.15 + h5[i]! * 0.06;
    out.add(s, 0, 1, side);
  }
  // Лёгкий перегруз: у саба эталона слышны гармоники до 700 Гц — «рык», а не чистый синус.
  return saturate(out.data, 1.6);
}

/** Блеск вспышки: шум выше 5 кГц с мелкой зернистостью — по всей сцене. */
function glitter(r: Random): Stereo {
  const out = new StereoMix(0.6);
  for (const side of [-1, 1] as const) {
    const n = biquad(noise(0.6, r), 'highpass', 5500, 0.7);
    for (let i = 0; i < n.length; i++) n[i] = n[i]! * (r() < 0.15 ? 1 : 0.25);
    out.add(biquad(n, 'lowpass', 12000, 0.7), 0, 1, side);
  }
  return out.data;
}

/** Огибающая вспышки: разгорается за 0.08 с, держится, гаснет к 0.5 с. */
const burstEnv = (t: number): number => smooth(t / 0.08) * (t < 0.3 ? 1 : Math.exp(-(t - 0.3) / 0.09));

/** Негармонический звон из строя эталона 190 : 337 : 613 : 1150 Гц. */
const RING = [1, 1.77, 3.22, 6.04] as const;

const ETHER_RISE: RisePalette = {
  sub: (len, r) => new StereoMix(len).addStereo(subNote(len), 0, 1).addStereo(wideLow(len, r, 180, 0.15, 0.03), 0, 0.2).data,
  burst: (r) => {
    const mix = new StereoMix(0.6)
      .addStereo(modal(ROOT, modes(GLASS, 0.6, 0.6), r, 0.3), 0, 1)
      .addStereo(sparkles(0.45, r, () => 160, { low: 91, high: 118, decay: 0.06 }), 0, 0.7)
      .addStereo(glitter(r), 0, 0.5);
    return shaped(mix.data, burstEnv);
  },
  ring: (len, r) => modal(hz(55), RING.map((ratio, k) => [ratio, 1 / (k + 1), len * 3] as const), r, 0.3),
  bells: (len, r) => sparkles(len, r, (t) => 22 * Math.exp(-t / 0.6), { low: 81, high: 91, decay: 0.3 }),
  space: {
    er: 0.1,
    shimmer: { size: 1.4, decay: 1.8, damp: 6500, predelay: 0.025, mod: 0.5, wet: 0.28, amount: 0.4 },
    width: 1.6,
  },
};

const FORGE_RISE: RisePalette = {
  sub: (len, r) => new StereoMix(len).addStereo(subNote(len), 0, 1).addStereo(wideLow(len, r, 140), 0, 0.25).data,
  burst: (r) => {
    const mix = new StereoMix(0.6)
      .addStereo(modal(ROOT, modes(BAR, 0.7, 0.65), r, 0.4), 0, 1)
      .addStereo(glitter(r), 0, 0.4);
    return shaped(mix.data, burstEnv);
  },
  ring: (len, r) => modal(hz(55), BAR.slice(0, 4).map((ratio, k) => [ratio, 1 / (k + 1), len * 3] as const), r, 0.3),
  space: {
    er: 0.25,
    room: { size: 1.2, decay: 1.7, damp: 4800, predelay: 0.02, mod: 0.4, wet: 0.3 },
    width: 1.5,
  },
};

const PORTAL_RISE: RisePalette = {
  sub: (len) => subNote(len, G1 * 2),
  burst: (r) => {
    const mix = new StereoMix(0.6);
    for (const m of [72, 79, 84]) mix.addStereo(supersaw(hz(m), 0.6, r, 0.25, 0.7, 1), 0, 0.5);
    const st = filterStereo(mix.data, 'lowpass', (t) => 2500 + 9000 * Math.exp(-t / 0.15), 0.8);
    return shaped(new StereoMix(0.6).addStereo(st).addStereo(glitter(r), 0, 0.35).data, burstEnv);
  },
  ring: (len, r) => {
    const mix = new StereoMix(len);
    for (const m of [43, 50, 55]) mix.addStereo(supersaw(hz(m), len, r, 0.16, 0.55, 0.4), 0, 0.5);
    return filterStereo(mix.data, 'lowpass', 900, 0.7);
  },
  bells: (len, r) => sparkles(len, r, (t) => 12 * Math.exp(-t / 0.5), { low: 83, high: 91, decay: 0.08 }),
  space: {
    er: 0.15,
    ping: { time: 0.19, fb: 0.38, wet: 0.22, lp: 6000, hp: 700, tail: 1.1 },
    room: { size: 1.3, decay: 1.8, damp: 7500, predelay: 0.02, mod: 0.5, wet: 0.28 },
    width: 1.7,
  },
};

// ── «Горн»: подбор — масса, мягкий бас, детали ─────────────────
//
// Подбор звучит раз в 1.8 с весь вечер. Цели: низко и мягко (бас без
// щелчка, тело 100–600 Гц, верх срезан), коротко (≤0.3 с), с массой —
// и с мелкими деталями, которые каждый раз чуть другие: ступень лада,
// число и время мелких призвуков, их высота и громкость. Поэтому у
// каждого подбора четыре варианта, а детали ещё и случайны по сиду.
// Искр нет: они лишние.

export const TAP_SPACE: Space = {
  er: 0.15,
  erSize: 0.8,
  room: { size: 0.6, decay: 0.4, damp: 3500, predelay: 0.006, wet: 0.16 },
  width: 1.2,
};

/** Даль: больше отражений и тёмный зал — удар звучит из глубины кузни. */
const TAP_FAR_SPACE: Space = {
  er: 0.35,
  erSize: 1.3,
  room: { size: 0.9, decay: 0.7, damp: 2500, predelay: 0.012, wet: 0.26 },
  width: 1.3,
};

/** Мягкая атака: щелчок первых миллисекунд и есть «несерьёзность». */
export const soften = (st: Stereo, attack = 0.003): Stereo => shaped(st, (t) => smooth(t / attack));

/** Глухой металл: моды бруска с быстро гаснущим верхом, всё выше bright срезано. */
function hammer(f: number, r: Random, ring: number, bright: number): Stereo {
  return soften(filterStereo(modal(f, modes(BAR, ring, 0.32), r, 0.25), 'lowpass', bright, 0.6));
}

/**
 * Мягкий бас: синус с коротким подъездом высоты сверху, плавная атака,
 * тёплые 2-я и 3-я гармоники — масса слышна и в динамиках ноутбука.
 */
export function softBass(
  f: number,
  len: number,
  o: { attack?: number; glide?: number; warmth?: number; body?: number } = {},
): Signal {
  const attack = o.attack ?? 0.006;
  const glide = o.glide ?? 1.15;
  const warmth = o.warmth ?? 1.8;
  // body — доля длины, за которую бас тает в e раз: больше — мягче, без «тумпа».
  const tau = len * (o.body ?? 0.32);
  const s = osc('sine', (t) => f * (1 + (glide - 1) * Math.exp(-t / 0.025)), len);
  const norm = Math.tanh(warmth);
  for (let i = 0; i < s.length; i++) {
    const t = i / SR;
    const x = s[i]!;
    s[i] = (Math.tanh(warmth * (x + 0.25 * x * x)) / norm) * smooth(t / attack) * Math.exp(-t / tau);
  }
  return biquad(s, 'highpass', 35, 0.7);
}

/** Мелочь при приземлении: 1–3 коротких глухих призвука с разбросом во времени и высоте. */
function settle(r: Random, base: number, count: number): Stereo {
  const mix = new StereoMix(0.3);
  let t = 0.035 + r() * 0.03;
  for (let k = 0; k < count; k++) {
    const f = base * (1.6 + r() * 1.2);
    const tick = filterStereo(modal(f, [[1, 1, 0.04 + r() * 0.03], [2.756, 0.35, 0.02]], r, 0.3), 'lowpass', 2600, 0.6);
    mix.addStereo(soften(tick, 0.0015), t, 0.5 * Math.pow(0.55, k) * (0.7 + 0.3 * r()));
    t += 0.03 + r() * 0.045;
  }
  return mix.data;
}

/** Огонёк: крошечная вспышка пламени — полоса шума взлетает и опадает за ~0.1 с. */
function flicker(r: Random, len = 0.14): Stereo {
  const mix = new StereoMix(len);
  const band = (t: number) => 300 * Math.pow(4, Math.sin((Math.PI * Math.min(len, t)) / len));
  for (const side of [-1, 1] as const) {
    const n = biquad(noise(len, r), 'bandpass', band, 1);
    for (let i = 0; i < n.length; i++) {
      const t = i / SR;
      n[i] = n[i]! * smooth(t / 0.012) * Math.exp(-t / 0.04);
    }
    mix.add(n, 0, 1, side * 0.6);
  }
  return mix.data;
}

/** Тёплое созвучие: тон и квинта, короткие, с лёгким перегрузом — тело «Пламени» в миниатюре. */
function ember(m: number, len = 0.2): Stereo {
  const mix = new StereoMix(len);
  for (const [k, g, pan] of [[0, 1, -0.15], [7, 0.6, 0.15]] as const) {
    mix.add(glow(hz(m + k), { swell: 0.008, hold: 0.02, decay: len - 0.05, depth: 0 }), 0, g, pan);
  }
  return saturate(mix.data, 1.5);
}

/**
 * Щипок струны (Карплус — Стронг): шумовой всплеск бежит по линии
 * задержки длиной в период и тает, — тёплый живой щипок без синтетики.
 */
function pluck(f: number, len: number, r: Random, bright = 0.5): Signal {
  const N = Math.max(2, Math.round(SR / f));
  const buf = new Float32Array(N);
  let lp = 0;
  for (let i = 0; i < N; i++) {
    lp += bright * (r() * 2 - 1 - lp);
    buf[i] = lp;
  }
  const out = new Float32Array(Math.round(len * SR));
  const loss = Math.pow(0.001, 1 / (len * f));
  let idx = 0;
  for (let i = 0; i < out.length; i++) {
    const a = buf[idx]!;
    const b = buf[(idx + 1) % N]!;
    out[i] = a;
    buf[idx] = loss * 0.5 * (a + b);
    idx = (idx + 1) % N;
  }
  // Затравка из отфильтрованного шума тихая: выводим щипок к пику 1.
  const hp = biquad(out, 'highpass', 40, 0.7);
  let peak = 1e-9;
  for (const x of hp) peak = Math.max(peak, Math.abs(x));
  for (let i = 0; i < hp.length; i++) hp[i] = hp[i]! / peak;
  return hp;
}

/** Короткий вдох: хвост комнаты от удара задом наперёд — звук «втягивается» в удар. */
function suck(src: Signal, len: number): Stereo {
  return inhale(src, len, { size: 0.6, decay: 0.35, damp: 3000, predelay: 0.004 });
}

export interface Tap {
  id: string;
  label: string;
  /** Четыре ступени по кругу (MIDI). */
  steps: readonly number[];
  make: (m: number, r: Random) => Scene;
  space?: Space;
}

/**
 * Шесть разных направлений подбора — карта, чтобы найти вкус на слух.
 * У всех: мягкая атака, масса снизу (мягкий бас), тело в слышимой
 * полосе, длина до ~0.3 с, четыре ступени по кругу и случайные детали.
 */
export const TAPS: readonly Tap[] = [
  {
    id: 'flame',
    label: 'Огонёк',
    steps: [60, 63, 58, 65],
    make: (m, r) =>
      new Scene()
        .add(flicker(r), 0, 0.45, 0.4)
        .add(ember(m), 0.02, 0.9, 0.6)
        .addMono(softBass(hz(m - 24), 0.24), 0.02, 0.7),
  },
  {
    id: 'tone',
    label: 'Тон подписи',
    steps: [60, 63, 58, 65],
    make: (m, r) =>
      new Scene()
        .addMono(glow(hz(m), { swell: 0.012, hold: 0.03, decay: 0.22, depth: 0.25 }), 0, 1, 0, 0.7)
        .addMono(softBass(hz(m - 24), 0.24), 0, 0.6)
        .add(settle(r, hz(m), 1), 0.01, 0.12, 0.3),
  },
  {
    id: 'crystal',
    label: 'Мягкий кристалл',
    steps: [67, 70, 65, 72],
    make: (m, r) =>
      new Scene()
        .add(soften(filterStereo(modal(hz(m), modes(GLASS, 0.3, 0.45), r, 0.3), 'lowpass', 2500, 0.6), 0.004), 0, 0.9, 0.7)
        .addMono(glow(hz(m - 12), { swell: 0.006, hold: 0.01, decay: 0.18, depth: 0 }), 0, 0.45, 0, 0.5)
        .addMono(softBass(hz(m - 24), 0.22), 0, 0.5),
  },
  {
    id: 'inhale',
    label: 'Вдох',
    steps: [55, 58, 53, 60],
    make: (m, r) => {
      const T = 0.09;
      const hit = new StereoMix(0.3).addStereo(hammer(hz(m), r, 0.16, 1400), 0, 1.6).add(softBass(hz(m - 12), 0.22), 0, 0.45).data;
      return new Scene().add(suck(mono(hit), T), 0, 0.5, 0).add(hit, T, 1, 0.5);
    },
  },
  {
    id: 'string',
    label: 'Струна',
    steps: [55, 58, 60, 53],
    make: (m, r) =>
      new Scene()
        .addMono(biquad(pluck(hz(m), 0.32, r, 0.3 + r() * 0.06), 'lowpass', 2200, 0.6), 0, 0.9, -0.1, 0.6)
        .addMono(biquad(pluck(hz(m + 12) * 1.002, 0.22, r, 0.18), 'lowpass', 1800, 0.6), 0.004, 0.35, 0.2, 0.6)
        .addMono(softBass(hz(m - 24), 0.24, { glide: 1.06 }), 0, 0.5),
  },
  {
    id: 'hush',
    label: 'Едва',
    steps: [55, 58, 53, 56],
    make: (m, r) => {
      const tup = biquad(biquad(noise(0.03, r), 'lowpass', 900, 0.7), 'lowpass', 900, 0.7);
      for (let i = 0; i < tup.length; i++) tup[i] = tup[i]! * smooth(i / (SR * 0.003)) * (1 - i / tup.length) ** 2;
      return new Scene()
        .addMono(softBass(hz(m - 12), 0.14, { glide: 1.08 }), 0, 0.5)
        .addMono(tup, 0, 0.9)
        .addMono(glow(hz(m), { swell: 0.005, hold: 0.005, decay: 0.08, depth: 0 }), 0.004, 0.8, 0, 0.3);
    },
  },
];

const tapProtos = TAPS.flatMap((tap) =>
  tap.steps.map((m, v) => ({
    id: `forge-tap-${tap.id}-${v + 1}`,
    label: `${tap.label} ${v + 1}`,
    tier: 'pickup' as const,
    render: (r: Random) => finish(tap.make(m, r), tap.space ?? TAP_SPACE),
  })),
);

// ── «Горн»: рекорд с массой ─────────────────────────────────────
//
// Звон колокола заменён исполнением «как возвышение»: рык саба, затем
// широкий взрыв (шум, фильтр которого закрывается от яркого к тёмному),
// металлический обвал вместо звона и тяжёлое тело — раскалённый металл
// гудит низко. Без искр, без звонкой верхушки, большой тёмный зал.

/** Плотные негармонические моды плиты: масса, а не колокол. */
const SLAB = [1, 1.47, 2.09, 2.56, 3.2, 4.1, 5.4] as const;

/** Металлический обвал: моды плиты гаснут за полсекунды, верх срезан. */
function crash(f: number, r: Random, decay = 0.6, bright = 2200): Stereo {
  const m = SLAB.map((ratio, k) => [ratio, Math.pow(0.72, k), decay / Math.sqrt(ratio)] as const);
  return soften(filterStereo(modal(f, m, r, 0.5), 'lowpass', bright, 0.6), 0.002);
}

/** Взрыв: шум, фильтр которого закрывается от яркого к тёмному, — «выдох» вспышки, свой в каждом канале. */
function blast(r: Random, len = 0.6, from = 9000, to = 600): Stereo {
  const mix = new StereoMix(len);
  for (const side of [-1, 1] as const) {
    const cut = (t: number) => to + (from - to) * Math.exp(-t / 0.07);
    const n = biquad(biquad(noise(len, r), 'lowpass', cut, 0.7), 'lowpass', cut, 0.7);
    for (let i = 0; i < n.length; i++) {
      const t = i / SR;
      n[i] = n[i]! * smooth(t / 0.006) * Math.exp(-t / 0.13);
    }
    mix.add(n, 0, 1, side);
  }
  return mix.data;
}

/** Пламя: полоса шума поднимается и опадает, под ней низкий гул — горн вспыхивает. */
function flare(r: Random, len = 0.7): Stereo {
  const mix = new StereoMix(len);
  const band = (t: number) => 250 * Math.pow(5.6, Math.sin((Math.PI * Math.min(len, t)) / len));
  for (const side of [-1, 1] as const) {
    const roar = biquad(noise(len, r), 'bandpass', band, 0.9);
    const rumble = biquad(biquad(noise(len, r), 'lowpass', 160, 0.7), 'lowpass', 160, 0.7);
    for (let i = 0; i < roar.length; i++) {
      const t = i / SR;
      roar[i] = (roar[i]! + rumble[i]! * 2.5) * smooth(t / 0.04) * Math.exp(-t / 0.25);
    }
    mix.add(roar, 0, 1, side * 0.8);
  }
  return mix.data;
}

/** Тело: раскалённый металл гудит низко — до малой, соль, до первой с тёплым перегрузом и октава под ними. */
function heavyBody(len: number, root = 48): Stereo {
  const mix = new StereoMix(len);
  ([[root, 1, -0.2], [root + 7, 0.7, 0.25], [root + 12, 0.45, 0]] as const).forEach(([m, g, pan]) =>
    mix.add(steadyGlow(hz(m), len, 0.12), 0, g, pan),
  );
  mix.add(osc('sine', hz(root - 12), len), 0, 0.35);
  return saturate(mix.data, 1.6);
}

const RECORD_SPACE: Space = {
  er: 0.35,
  erSize: 1.5,
  room: { size: 1.5, decay: 2.4, damp: 3500, predelay: 0.025, mod: 0.4, wet: 0.38 },
  width: 1.5,
  glue: 1.2,
};

/** Рекорд длиннее и тяжелее эталона: тело держится дольше и тает медленнее. */
const RECORD_SHAPE: RiseShape = { T: 0.7, ringHold: 0.7, ringFade: 16, ringEnd: 2.1 };

const heavySub = (len: number, r: Random): Stereo =>
  new StereoMix(len).addStereo(subNote(len), 0, 1).addStereo(wideLow(len, r, 150, 0.2, 0.01), 0, 0.3).data;

const boom = (r: Random): Signal => sub(1.5, 110, 36, 0.07, 1.3, r, 0);

const RISE_METAL: RisePalette = {
  sub: heavySub,
  burst: (r) => new StereoMix(0.7).addStereo(blast(r), 0, 1).addStereo(crash(hz(48), r), 0, 0.8).addStereo(glitter(r), 0, 0.12).data,
  impact: (r) => new StereoMix(1.6).add(boom(r), 0, 1).addStereo(crash(hz(36), r, 0.9, 1200), 0, 0.7).data,
  ring: (len) => heavyBody(len),
  levels: { burst: -7, ring: -9, impact: -2 },
  space: RECORD_SPACE,
};

const RISE_FLAME: RisePalette = {
  sub: heavySub,
  burst: (r) => new StereoMix(0.8).addStereo(flare(r), 0, 1).addStereo(blast(r, 0.5, 5000, 500), 0, 0.6).data,
  impact: (r) => new StereoMix(1.6).add(boom(r), 0, 1).addStereo(crash(hz(43), r, 0.7, 1000), 0, 0.45).data,
  ring: (len) => heavyBody(len, 43),
  levels: { burst: -6, ring: -9, impact: -3 },
  space: RECORD_SPACE,
};

// «Молот» по партитуре дивайна — удар теперь не колокол, а глухая плита.
const FORGE_HEAVY: Palette = {
  breath: (len, r) => {
    const roar = wideLow(len, r, 220, 0.14, 0.015);
    return new StereoMix(len).addStereo(roar, 0, 1).addStereo(lowChord([0.0625, 0.125], ROOT, len, 0.3), 0, 0.3).data;
  },
  flash: (r) => crash(hz(55), r, 0.15, 1800),
  tone: (f, len, r) => {
    // Металл поёт низко: тон, октава под ним для веса, тихие моды бруска, тёплый перегруз.
    const body = steadyGlow(f, len, 0.14);
    const low = osc('sine', f / 2, len);
    const ring = modal(f, BAR.slice(1, 3).map((ratio, k) => [ratio, 0.1 / (k + 1), len] as const), r, 0);
    for (let i = 0; i < body.length; i++) {
      body[i] = Math.tanh(1.4 * (body[i]! + (low[i] ?? 0) * 0.35 + ((ring.l[i] ?? 0) + (ring.r[i] ?? 0)) * 0.5)) / Math.tanh(1.4);
    }
    return body;
  },
  strike: (f, r) => new StereoMix(1.6).addStereo(crash(f / 2, r, 0.7, 1500), 0, 1).add(boom(r), 0, 0.9).addStereo(blast(r, 0.4, 4000, 400), 0, 0.4).data,
  levels: { strike: -4, tone: -5, under: -14 },
  under: (f, len) => lowChord([0.25, 0.375], f, len, 0.3),
  space: RECORD_SPACE,
};

/** «Молот»: до малой октавы, затем добивающий удар октавой ниже. */
const RECORD_HAMMER: Score = {
  pre: 0.62,
  peak: 0.42,
  sag: 9,
  fade: 18,
  tail: 1.2,
  dust: 0,
  hold: 0.8,
  notes: [
    [1, 0],
    [0.5, 0.3],
  ],
};

/** Горн целиком: прежние подбор и рекорд для A/B, новые варианты подбора и тяжёлые рекорды. */
export const FORGE_KIT: Concept = {
  id: 'forge-kit',
  title: 'Горн · подбор и рекорд',
  blurb:
    'Рекорд выбран — «Пламя». Подбор — карта из шести разных направлений, чтобы найти вкус на слух: Огонёк (Пламя в миниатюре), Тон подписи, Мягкий кристалл, Вдох, Струна, Едва. У каждого четыре удара по кругу; слушать сериями и рядом с «Пламенем».',
  color: '#ff9f5a',
  protos: [
    ...tapProtos,
    { id: 'forge-record-metal', label: 'Рекорд · Металл', tier: 'record', render: (r) => performRise(RISE_METAL, r, RECORD_SHAPE) },
    { id: 'forge-record-flame', label: 'Рекорд · Пламя', tier: 'record', render: (r) => performRise(RISE_FLAME, r, RECORD_SHAPE) },
    { id: 'forge-record-hammer', label: 'Рекорд · Молот', tier: 'record', render: (r) => perform(FORGE_HEAVY, RECORD_HAMMER, r, ROOT / 2) },
  ],
};

// ── ступени ─────────────────────────────────────────────────────

/** Подбор — партитура в миниатюре: короткий вздох, тон, короткий хвост. */
const PICKUP: Score = { pre: 0.09, peak: 0.5, hold: 0.04, sag: 6, fade: 70, tail: 0.35, notes: [[1, 0]], dust: 0.25 };
/** Джекпот — партитура эталона целиком. */
const JACKPOT: Score = { pre: 0.55, peak: 0.45, hold: 0.6, sag: 12, fade: 26, tail: 0.8, notes: [[1, 0]], dust: 1.4 };
/** Рекорд — она же с квинтой и октавой, вступающими друг за другом. */
const RECORD: Score = {
  pre: 0.62,
  peak: 0.45,
  hold: 0.7,
  sag: 10,
  fade: 22,
  tail: 1,
  notes: [
    [1, 0],
    [1.5, 0.12],
    [2, 0.26],
  ],
  dust: 2,
};

const set = (id: string, p: Palette, rise: RisePalette) => [
  { id: `${id}-pickup`, label: 'Подбор', tier: 'pickup' as const, render: (r: Random) => perform(p, PICKUP, r, ROOT * 2) },
  { id: `${id}-exalted`, label: 'Как возвышение', tier: 'jackpot' as const, render: (r: Random) => performRise(rise, r) },
  { id: `${id}-jackpot`, label: 'Как дивайн', tier: 'jackpot' as const, render: (r: Random) => perform(p, JACKPOT, r) },
  { id: `${id}-record`, label: 'Рекорд', tier: 'record' as const, render: (r: Random) => perform(p, RECORD, r) },
];

export const HYBRID: Concept[] = [
  {
    id: 'ether',
    title: 'Эфир · космос',
    blurb:
      'Партитура эталона: искры-вспышка, широкий гул пустоты (самое громкое место), затем в центре загорается тон с кристаллом на входе. Просадка, хвост с низкими тонами, шиммер и редкие искры в космосе.',
    color: '#a9c8ff',
    protos: set('ether', ETHER, ETHER_RISE),
  },
  {
    id: 'forge',
    title: 'Горн · кузня',
    blurb:
      'Та же партитура, тембры Горна: звон молотка-вспышка, мехи раздувают огонь — шершавый широкий рёв. Тон — раскалённый металл поёт поверх удара по наковальне. В хвосте угольки и тёмный зал.',
    color: '#ff9f5a',
    protos: set('forge', FORGE, FORGE_RISE),
  },
  {
    id: 'portal',
    title: 'Портал · EDM',
    blurb:
      'Та же партитура в EDM: щелчок супер-пилы, вздох — широкий риз-саб с расстроенными пилами. Тон — узкий лид на ядре подписи, хвост разлетается пинг-понгом по сторонам.',
    color: '#d08cff',
    protos: set('portal', PORTAL, PORTAL_RISE),
  },
];

/**
 * «Пламя» с заданной формой: рекорд — RECORD_SHAPE, джекпот — короче
 * и легче. Нужен премиум-лестнице (src/sfx/premium.ts).
 */
export function flame(r: Random, size: 'record' | 'jackpot' = 'record'): Stereo {
  const shape: RiseShape = size === 'record' ? RECORD_SHAPE : { T: 0.5, ringHold: 0.45, ringFade: 22, ringEnd: 1.4 };
  return performRise(RISE_FLAME, r, shape);
}

/** «Горн · как возвышение»: рык саба, звенящая вспышка, металлическое тело — без искр. */
export const forgeExalted = (r: Random): Stereo => performRise(FORGE_RISE, r);

/** «Горн · как дивайн»: вздох мехов, удар, в центре загорается тон, просадка, тёмный хвост. */
export const forgeDivine = (r: Random): Stereo => perform(FORGE, JACKPOT, r);
