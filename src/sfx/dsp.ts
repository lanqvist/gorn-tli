/**
 * Офлайн-DSP для звуков Горна.
 *
 * Звуки не синтезируются на лету, а рендерятся заранее — как иконка
 * в scripts/make-icon.mjs: генератор (src/cli/make-sounds.ts) собирает
 * их из этих кирпичиков и пишет WAV-файлы в репозиторий. Так можно то,
 * что в живом Web Audio дорого или неудобно: перегруз 808, сайдчейн,
 * тейп-стоп, лимитер с заглядыванием вперёд и нормализацию громкости
 * по замеру. Приложение лишь проигрывает готовые файлы.
 *
 * Всё — чистые функции над Float32Array, без Web Audio и без зависимостей:
 * один и тот же код работает в Node (генератор, тесты) и в браузере
 * (дев-страница прослушивания). Случайность — только из сидированного
 * генератора, поэтому рендер детерминирован: тот же рецепт — тот же файл.
 */

/** Частота дискретизации ассетов. Верх всё равно срезается мастером ниже 8 кГц. */
export const SR = 24000;

export type Signal = Float32Array<ArrayBuffer>;

/** Параметр: число или функция от времени в секундах. */
export type Param = number | ((t: number) => number);

const valueAt = (p: Param, t: number): number => (typeof p === 'number' ? p : p(t));

/** Генератор mulberry32: детерминированный шум и вариации. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Строка → сид: у каждого рецепта своя, но стабильная случайность. */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const samples = (sec: number): number => Math.max(1, Math.round(sec * SR));

// ── кривые ──────────────────────────────────────────────────────

/**
 * Кривая по точкам [время, значение] с экспоненциальной интерполяцией —
 * так звучат глайды 808 и проходы фильтра: равномерно на слух, а не по герцам.
 */
export function curve(points: ReadonlyArray<readonly [number, number]>): (t: number) => number {
  return (t) => {
    const first = points[0];
    if (!first) return 0;
    if (t <= first[0]) return first[1];
    for (let i = 1; i < points.length; i++) {
      const [t1, v1] = points[i]!;
      const [t0, v0] = points[i - 1]!;
      if (t <= t1) {
        const k = (t - t0) / Math.max(1e-9, t1 - t0);
        return v0 > 0 && v1 > 0 ? v0 * Math.pow(v1 / v0, k) : v0 + (v1 - v0) * k;
      }
    }
    return points[points.length - 1]![1];
  };
}

// ── источники ───────────────────────────────────────────────────

/** Сглаживание разрыва (polyBLEP): пила и меандр без алиасного свиста. */
function blep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

export type Shape = 'sine' | 'saw' | 'square' | 'tri';

/**
 * Осциллятор. pm — фазовая модуляция в радианах (FM-синтез кристалла),
 * отсчёт к отсчёту с выходом.
 */
export function osc(shape: Shape, freq: Param, dur: number, pm?: Signal): Signal {
  const out = new Float32Array(samples(dur));
  let phase = 0;
  let tri = 0;
  for (let i = 0; i < out.length; i++) {
    const f = valueAt(freq, i / SR);
    const dt = Math.min(0.5, f / SR);
    const p = pm ? phase + (pm[i] ?? 0) / (2 * Math.PI) : phase;
    const t = p - Math.floor(p);
    switch (shape) {
      case 'sine':
        out[i] = Math.sin(2 * Math.PI * t);
        break;
      case 'saw':
        out[i] = 2 * t - 1 - blep(t, dt);
        break;
      case 'square':
        out[i] = (t < 0.5 ? 1 : -1) + blep(t, dt) - blep((t + 0.5) % 1, dt);
        break;
      case 'tri': {
        // Интегрированный меандр: треугольник без изломов-алиасов.
        const sq = (t < 0.5 ? 1 : -1) + blep(t, dt) - blep((t + 0.5) % 1, dt);
        tri = dt * sq * 4 + (1 - dt * 0.5) * tri;
        out[i] = tri;
        break;
      }
    }
    phase += f / SR;
    if (phase > 1e6) phase -= Math.floor(phase);
  }
  return out;
}

export function noise(dur: number, random: () => number): Signal {
  const out = new Float32Array(samples(dur));
  for (let i = 0; i < out.length; i++) out[i] = random() * 2 - 1;
  return out;
}

// ── огибающие и арифметика ──────────────────────────────────────

/**
 * Огибающая «атака — спад»: линейная атака, экспоненциальный спад до −60 дБ
 * к концу decay. hold — сколько держать пик перед спадом.
 */
export function ad(dur: number, attack: number, decay: number, hold = 0): Signal {
  const out = new Float32Array(samples(dur));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    if (t < attack) out[i] = t / attack;
    else if (t < attack + hold) out[i] = 1;
    else out[i] = Math.pow(0.001, (t - attack - hold) / decay);
  }
  return out;
}

/** Поэлементное умножение (огибающая, модуляция); результат — в a. */
export function mul(a: Signal, b: Signal | Param): Signal {
  for (let i = 0; i < a.length; i++) {
    a[i] = a[i]! * (b instanceof Float32Array ? (b[i] ?? 0) : valueAt(b, i / SR));
  }
  return a;
}

export function scale(a: Signal, g: number): Signal {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! * g;
  return a;
}

/** Сумма сигналов в общий буфер с отступом по времени. */
export class Mix {
  data: Signal;
  constructor(dur: number) {
    this.data = new Float32Array(samples(dur));
  }
  add(sig: Signal, at = 0, g = 1): this {
    const off = Math.round(at * SR);
    // Буфер растёт сам: рецептам не нужно заранее знать длину хвостов.
    if (off + sig.length > this.data.length) {
      const grown = new Float32Array(off + sig.length);
      grown.set(this.data);
      this.data = grown;
    }
    for (let i = 0; i < sig.length; i++) {
      const j = off + i;
      if (j >= 0) this.data[j] = this.data[j]! + sig[i]! * g;
    }
    return this;
  }
}

// ── обработка ───────────────────────────────────────────────────

export type FilterType = 'lowpass' | 'highpass' | 'bandpass';

/**
 * Биквад по RBJ. Частота может меняться во времени: коэффициенты
 * пересчитываются каждые 16 отсчётов — так ходят фильтры reese и райзера.
 */
export function biquad(sig: Signal, type: FilterType, freq: Param, q = 0.707): Signal {
  const out = new Float32Array(sig.length);
  let b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < sig.length; i++) {
    if (i % 16 === 0) {
      const f = Math.min(SR * 0.45, Math.max(10, valueAt(freq, i / SR)));
      const w = (2 * Math.PI * f) / SR;
      const cos = Math.cos(w);
      const alpha = Math.sin(w) / (2 * q);
      const a0 = 1 + alpha;
      if (type === 'lowpass') {
        b0 = (1 - cos) / 2 / a0; b1 = (1 - cos) / a0; b2 = b0;
      } else if (type === 'highpass') {
        b0 = (1 + cos) / 2 / a0; b1 = -(1 + cos) / a0; b2 = b0;
      } else {
        b0 = alpha / a0; b1 = 0; b2 = -alpha / a0;
      }
      a1 = (-2 * cos) / a0;
      a2 = (1 - alpha) / a0;
    }
    const x = sig[i]!;
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

/** Мягкий перегруз tanh: тепло и плотность 808, громкость не растёт. */
export function drive(sig: Signal, amount: number): Signal {
  const norm = Math.tanh(amount);
  for (let i = 0; i < sig.length; i++) sig[i] = Math.tanh(sig[i]! * amount) / norm;
  return sig;
}

/** Лоу-фай: огрубление частоты дискретизации и разрядности — пыль кассеты. */
export function crush(sig: Signal, hold: number, bits: number): Signal {
  const steps = Math.pow(2, bits - 1);
  let held = 0;
  for (let i = 0; i < sig.length; i++) {
    if (i % hold === 0) held = Math.round(sig[i]! * steps) / steps;
    sig[i] = held;
  }
  return sig;
}

/** Эхо с обратной связью и затуханием верхов в петле. */
export function echo(sig: Signal, time: number, feedback: number, wet: number, tail: number): Signal {
  const d = samples(time);
  const out = new Float32Array(sig.length + samples(tail));
  const line = new Float32Array(out.length);
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    const dry = sig[i] ?? 0;
    const back = i >= d ? line[i - d]! : 0;
    lp += 0.45 * (back - lp);
    line[i] = dry + lp * feedback;
    out[i] = dry + back * wet;
  }
  return out;
}

/**
 * Короткий зал по схеме Freeverb: восемь гребенчатых фильтров и четыре
 * всепропускающих. size 0..1, damp 0..1 — гашение верхов в хвосте.
 */
export function reverb(sig: Signal, size: number, damp: number, wet: number, tail: number): Signal {
  const k = SR / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((n) => ({
    buf: new Float32Array(Math.round(n * k)),
    idx: 0,
    lp: 0,
  }));
  const allpasses = [556, 441, 341, 225].map((n) => ({ buf: new Float32Array(Math.round(n * k)), idx: 0 }));
  const feedback = 0.7 + size * 0.28;
  const out = new Float32Array(sig.length + samples(tail));
  for (let i = 0; i < out.length; i++) {
    const x = (sig[i] ?? 0) * 0.015;
    let acc = 0;
    for (const c of combs) {
      const y = c.buf[c.idx]!;
      c.lp = y * (1 - damp) + c.lp * damp;
      c.buf[c.idx] = x + c.lp * feedback;
      c.idx = (c.idx + 1) % c.buf.length;
      acc += y;
    }
    for (const a of allpasses) {
      const y = a.buf[a.idx]!;
      a.buf[a.idx] = acc + y * 0.5;
      a.idx = (a.idx + 1) % a.buf.length;
      acc = y - acc;
    }
    out[i] = (sig[i] ?? 0) + acc * wet;
  }
  return out;
}

/**
 * Тейп-стоп: скорость ленты падает до нуля за dur секунд, высота съезжает
 * вместе с ней — фирменное «вууу» лоу-фай и фонка.
 */
export function tapeStop(sig: Signal, startAt: number, dur: number): Signal {
  const start = samples(startAt);
  const out = new Float32Array(start + samples(dur));
  out.set(sig.subarray(0, Math.min(start, sig.length)));
  let pos = start;
  for (let i = start; i < out.length; i++) {
    const k = 1 - (i - start) / (out.length - start);
    const j = Math.floor(pos);
    const frac = pos - j;
    out[i] = ((sig[j] ?? 0) * (1 - frac) + (sig[j + 1] ?? 0) * frac) * Math.min(1, k * 4);
    pos += k * k;
  }
  return out;
}

/** Сайдчейн: сигнал «приседает» на каждом ударе и отпускает за release. */
export function duck(sig: Signal, hits: readonly number[], depth: number, release: number): Signal {
  for (let i = 0; i < sig.length; i++) {
    const t = i / SR;
    let g = 1;
    for (const h of hits) {
      if (t >= h) g = Math.min(g, 1 - depth * Math.exp(-(t - h) / release));
    }
    sig[i] = sig[i]! * g;
  }
  return sig;
}

// ── мастеринг ───────────────────────────────────────────────────

export const db = (x: number): number => 20 * Math.log10(Math.max(1e-9, x));
export const fromDb = (d: number): number => Math.pow(10, d / 20);

/** Пик и максимальная громкость в окне 50 мс — так же, как замеряли прежние звуки. */
export function measure(sig: Signal): { peakDb: number; rmsDb: number; durationSec: number } {
  let peak = 0;
  for (const v of sig) peak = Math.max(peak, Math.abs(v));
  const w = samples(0.05);
  let maxRms = 0;
  for (let s = 0; s + w <= sig.length; s += w >> 1) {
    let e = 0;
    for (let i = s; i < s + w; i++) e += sig[i]! * sig[i]!;
    maxRms = Math.max(maxRms, Math.sqrt(e / w));
  }
  if (sig.length < w) {
    let e = 0;
    for (const v of sig) e += v * v;
    maxRms = Math.sqrt(e / Math.max(1, sig.length));
  }
  return { peakDb: db(peak), rmsDb: db(maxRms), durationSec: sig.length / SR };
}

/** Лимитер с заглядыванием на 3 мс: пики не проходят выше ceiling. */
export function limit(sig: Signal, ceilingDb: number): Signal {
  const ceiling = fromDb(ceilingDb);
  const look = samples(0.003);
  const release = Math.exp(-1 / (SR * 0.08));
  const out = new Float32Array(sig.length);
  let g = 1;
  for (let i = 0; i < sig.length; i++) {
    let m = 0;
    for (let j = i; j < Math.min(sig.length, i + look); j++) m = Math.max(m, Math.abs(sig[j]!));
    const target = m > ceiling ? ceiling / m : 1;
    g = target < g ? target : target - (target - g) * release;
    out[i] = Math.max(-ceiling, Math.min(ceiling, sig[i]! * g));
  }
  return out;
}

/** Обрезка тишины в хвосте (ниже −48 дБ от пика) и короткий фейд. */
export function trim(sig: Signal, fadeSec = 0.015): Signal {
  let peak = 0;
  for (const v of sig) peak = Math.max(peak, Math.abs(v));
  const floor = peak * fromDb(-48);
  let end = sig.length;
  while (end > 1 && Math.abs(sig[end - 1]!) < floor) end--;
  const out = sig.slice(0, Math.min(sig.length, end + samples(0.01)));
  const fade = Math.min(out.length, samples(fadeSec));
  for (let i = 0; i < fade; i++) out[out.length - 1 - i] = out[out.length - 1 - i]! * (i / fade);
  return out;
}

/**
 * Мастер ассета: срез инфранизов и верхов выше ~7 кГц (никакого писка),
 * громкость — к заданной по замеру, пики — под потолок лимитером.
 */
export function master(sig: Signal, targetRmsDb: number, ceilingDb: number): Signal {
  let out = biquad(sig, 'highpass', 30, 0.7);
  out = biquad(out, 'lowpass', 7000, 0.6);
  for (let pass = 0; pass < 3; pass++) {
    const { rmsDb } = measure(out);
    out = limit(scale(out, fromDb(targetRmsDb - rmsDb)), ceilingDb);
  }
  return trim(out);
}

/** WAV: 16 бит, моно. */
export function toWav(sig: Signal, rate = SR): Uint8Array {
  const bytes = new Uint8Array(44 + sig.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + sig.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, sig.length * 2, true);
  for (let i = 0; i < sig.length; i++) {
    const v = Math.max(-1, Math.min(1, sig[i]!));
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return bytes;
}
