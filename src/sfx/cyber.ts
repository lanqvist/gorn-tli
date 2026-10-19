/**
 * Кибер-подборы: направления в духе киберпанка для стенда прослушивания.
 *
 * Ориентир — не «писк и лазеры», а эстетика звука Cyberpunk 2077, как её
 * описывает звуковая команда CD Projekt Red: мир «органичный, иногда
 * грязный и сырой, но не слишком sci-fi», импланты — живые струны
 * и металл, «ретро-аналоговый sci-fi» — старая механика с цифровыми
 * синтезаторными слоями поверх. Ни одного их звука здесь нет: только
 * приёмы.
 *
 * Отсюда слои: механика (реле, защёлка, сервопривод), грязная цифра
 * (меандр и FM с урезанной разрядностью и частотой, заикание буфера),
 * и, как у всех подборов Горна, мягкий бас снизу. Верх срезан около
 * 4–5 кГц: «цифра» звучит грязно, но не режет.
 */
import { SR, StereoMix, biquad, crush, noise, osc, type Signal, type Stereo } from './dsp.js';
import { glow, hz, modal, smooth } from './fx.js';
import { softBass, type Tap } from './hybrid.js';
import { finish, Scene, type Concept, type Space } from './scene.js';

type Random = () => number;

function shape(sig: Signal, env: (t: number) => number): Signal {
  for (let i = 0; i < sig.length; i++) sig[i] = sig[i]! * env(i / SR);
  return sig;
}

const lowpass = (sig: Signal, f: number): Signal => biquad(biquad(sig, 'lowpass', f, 0.7), 'lowpass', f, 0.7);

/** Реле: замыкание и защёлка — два сухих микрощелчка механики импланта. */
function relay(r: Random): Signal {
  const out = new Float32Array(Math.round(0.06 * SR));
  const gap = 0.01 + r() * 0.012;
  [
    [0, 1],
    [gap, 0.55],
  ].forEach(([at, g]) => {
    const click = biquad(noise(0.005, r), 'bandpass', 2200 + r() * 1400, 1.3);
    shape(click, (t) => Math.exp(-t / 0.0012));
    const body = modal(900 + r() * 400, [[1, 1, 0.025], [2.3, 0.4, 0.012]], r, 0).l;
    const off = Math.round(at! * SR);
    for (let i = 0; i < click.length; i++) out[off + i] = out[off + i]! + click[i]! * g!;
    for (let i = 0; i < body.length && off + i < out.length; i++) out[off + i] = out[off + i]! + body[i]! * 0.25 * g!;
  });
  return lowpass(out, 6000);
}

/** Грязная цифра: меандр с подъездом высоты, урезанный по разрядности и частоте. */
function blip(f: number, len: number, o: { bits?: number; hold?: number; chirp?: number } = {}): Signal {
  const chirp = o.chirp ?? 1;
  const sig = osc('square', (t) => f * (1 + (chirp - 1) * Math.exp(-t / 0.01)), len);
  shape(sig, (t) => smooth(t / 0.002) * Math.exp(-t / (len * 0.35)));
  crush(sig, o.hold ?? 3, o.bits ?? 6);
  return lowpass(sig, 4500);
}

/** FM-пакет данных: высота падает с октавы до тона, индекс гаснет — короткое «чирп». */
function packet(f: number, len: number): Signal {
  const mod = osc('sine', (t) => f * 2 * (1 + Math.exp(-t / 0.012)), len);
  shape(mod, (t) => 3 * Math.exp(-t / 0.02));
  const car = osc('sine', (t) => f * (1 + Math.exp(-t / 0.012)), len, mod);
  shape(car, (t) => smooth(t / 0.002) * Math.exp(-t / (len * 0.3)));
  crush(car, 4, 6);
  return lowpass(car, 4000);
}

/**
 * Заикание буфера: начало звука повторяется 2–4 короткими кусками,
 * как сбойнувший поток, и только потом звучит целиком.
 */
function stutter(sig: Signal, r: Random): Signal {
  const slices = 2 + Math.floor(r() * 3);
  const sl = Math.round((0.007 + r() * 0.008) * SR);
  const out = new Float32Array(sig.length + sl * slices);
  for (let k = 0; k < slices; k++) {
    const g = 0.5 + 0.5 * (k / slices);
    for (let i = 0; i < sl; i++) {
      const fade = Math.min(1, i / 48, (sl - i) / 48);
      out[k * sl + i] = out[k * sl + i]! + sig[i]! * g * fade;
    }
  }
  for (let i = 0; i < sig.length; i++) out[slices * sl + i] = out[slices * sl + i]! + sig[i]!;
  return out;
}

/** Скан: шумовая полоса пробегает вверх за ~40 мс, слева направо. */
function scan(r: Random, len = 0.045): Stereo {
  const n = biquad(noise(len, r), 'bandpass', (t) => 500 * Math.pow(8, t / len), 2);
  shape(n, (t) => Math.sin((Math.PI * Math.min(len, t)) / len) ** 2);
  const l = new Float32Array(n.length);
  const rr = new Float32Array(n.length);
  for (let i = 0; i < n.length; i++) {
    const a = ((i / n.length) * Math.PI) / 2;
    l[i] = n[i]! * Math.cos(a);
    rr[i] = n[i]! * Math.sin(a);
  }
  return { l: lowpass(l, 5000), r: lowpass(rr, 5000) };
}

/** Неон-бас: две пилы врозь на 7 центов, резонансный фильтр хлопает вниз — синтвейв-«буп». */
function neonBass(f: number, len: number): Signal {
  const a = osc('saw', f, len);
  const b = osc('saw', f * 1.004, len);
  const s = new Float32Array(a.length);
  for (let i = 0; i < s.length; i++) s[i] = (a[i]! + b[i]!) * 0.5;
  const out = biquad(s, 'lowpass', (t) => 300 + 2200 * Math.exp(-t / 0.04), 4);
  return shape(out, (t) => smooth(t / 0.004) * Math.exp(-t / (len * 0.35)));
}

const CYBER_SPACE: Space = {
  er: 0.1,
  erSize: 0.7,
  ping: { time: 0.07, fb: 0.15, wet: 0.1, lp: 3500, hp: 600, tail: 0.25 },
  room: { size: 0.55, decay: 0.35, damp: 3500, predelay: 0.004, wet: 0.12 },
  width: 1.3,
};

const pan = (r: Random) => (r() - 0.5) * 0.6;

export const CYBER_TAPS: readonly Tap[] = [
  {
    id: 'implant',
    label: 'Имплант',
    steps: [60, 63, 58, 65],
    make: (m, r) =>
      new Scene()
        .addMono(relay(r), 0, 0.5, pan(r), 0.3)
        .addMono(blip(hz(m), 0.09, { bits: 7, hold: 2, chirp: 1.5 }), 0.012, 0.45, 0, 0.5)
        .addMono(glow(hz(m - 12), { swell: 0.006, hold: 0.02, decay: 0.15, depth: 0 }), 0.012, 0.45)
        .addMono(softBass(hz(m - 24), 0.22), 0.012, 0.6),
  },
  {
    id: 'glitch',
    label: 'Глитч',
    steps: [60, 63, 58, 65],
    make: (m, r) => {
      const tone = glow(hz(m), { swell: 0.004, hold: 0.03, decay: 0.16, depth: 0 });
      const dirty = blip(hz(m), 0.2, { bits: 8, hold: 2 });
      for (let i = 0; i < tone.length; i++) tone[i] = tone[i]! + (dirty[i] ?? 0) * 0.35;
      return new Scene().addMono(lowpass(stutter(tone, r), 5000), 0, 0.85, 0, 0.5).addMono(softBass(hz(m - 24), 0.24), 0, 0.6);
    },
  },
  {
    id: 'packet',
    label: 'Пакет данных',
    steps: [67, 70, 65, 72],
    make: (m) =>
      new Scene()
        .addMono(packet(hz(m), 0.12), 0, 0.7, 0, 0.5)
        .addMono(softBass(hz(m - 24), 0.2, { glide: 1.3 }), 0, 0.7),
  },
  {
    id: 'neon',
    label: 'Неон-бас',
    steps: [48, 51, 46, 53],
    make: (m, r) =>
      new Scene()
        .addMono(neonBass(hz(m), 0.22), 0, 0.8, 0, 0.4)
        .addMono(softBass(hz(m - 12), 0.22), 0, 0.45)
        .addMono(relay(r), 0, 0.15, pan(r)),
  },
  {
    id: 'scanner',
    label: 'Сканер',
    steps: [67, 70, 65, 72],
    make: (m, r) =>
      new Scene()
        .add(scan(r), 0, 0.35, 0.3)
        .addMono(relay(r), 0.03, 0.3, pan(r))
        .addMono(blip(hz(m), 0.06, { bits: 5, hold: 3 }), 0.035, 0.4, 0, 0.5)
        .addMono(softBass(hz(m - 24), 0.2), 0.035, 0.6),
  },
  {
    id: 'eddies',
    label: 'Эдди',
    steps: [60, 62, 58, 63],
    make: (m, r) =>
      new Scene()
        .addMono(relay(r), 0, 0.3, pan(r))
        .addMono(blip(hz(m), 0.05, { bits: 6, hold: 3 }), 0.004, 0.45, -0.15, 0.5)
        .addMono(blip(hz(m + 7), 0.12, { bits: 6, hold: 3 }), 0.04, 0.45, 0.15, 0.5)
        .addMono(softBass(hz(m - 24), 0.22), 0.004, 0.6),
  },
];

export const CYBER_KIT: Concept = {
  id: 'cyber-kit',
  title: 'Кибер · подбор',
  blurb:
    'Киберпанк без писка и лазеров — механика и грязная цифра, как в эстетике Cyberpunk 2077 («органично, иногда грязно и сыро, но не слишком sci-fi»): реле и защёлки, меандр и FM с урезанной разрядностью, заикание буфера, синтвейв-бас. Снизу — тот же мягкий бас, что у подборов Горна; верх срезан. Слушать сериями и рядом с «Пламенем».',
  color: '#ffd23f',
  protos: CYBER_TAPS.flatMap((tap) =>
    tap.steps.map((m, v) => ({
      id: `cyber-tap-${tap.id}-${v + 1}`,
      label: `${tap.label} ${v + 1}`,
      tier: 'pickup' as const,
      render: (r: Random) => finish(tap.make(m, r), tap.space ?? CYBER_SPACE),
    })),
  ),
};

