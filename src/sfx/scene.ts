/**
 * Сцена прототипов: сухая шина, посыл в пространство и каталог
 * концепций для стенда прослушивания. Общая для src/sfx/club.ts
 * и src/sfx/hybrid.ts.
 */
import { StereoMix, type Signal, type Stereo } from './dsp.js';
import { duckAt, mono, orbit, pingPong, pump, reflections, room, saturate, shimmer, widen, type RoomOptions } from './fx.js';
import type { Tier } from './kit.js';

type Random = () => number;

// ── сцена: сухая шина и посыл в пространство ────────────────────

export class Scene {
  readonly dry = new StereoMix(0.1);
  readonly send = new StereoMix(0.1);
  /** Стерео-голос: в сухую шину и с долей send — в пространство. */
  add(st: Stereo, at: number, g: number, send = 0): this {
    this.dry.addStereo(st, at, g);
    if (send > 0) this.send.addStereo(st, at, g * send);
    return this;
  }
  /** Моно-голос (бочка, саб): по умолчанию мимо пространства — низ не мутит хвост. */
  addMono(sig: Signal, at: number, g: number, pan = 0, send = 0): this {
    this.dry.add(sig, at, g, pan);
    if (send > 0) this.send.add(sig, at, g * send, pan);
    return this;
  }
}

export interface Space {
  /** Ранние отражения: громкость и размер. */
  er?: number;
  erSize?: number;
  ping?: { time: number; fb: number; wet: number; lp?: number; hp?: number; tail?: number };
  room?: RoomOptions & { wet: number };
  shimmer?: RoomOptions & { wet: number; amount: number };
  /** Ширина «мокрого» (M/S выше 150 Гц). */
  width?: number;
  /** Пампинг «мокрого» с момента start. */
  pump?: { bpm: number; depth: number; start: number };
  orbit?: { rate: number; depth: number };
  /** Провал «мокрого» в точке удара: сайдчейн без темпа. */
  duck?: { at: number; depth: number; release: number };
  /** Перегруз суммы: плотность. */
  glue?: number;
}

export function finish(sc: Scene, sp: Space): Stereo {
  const send = mono(sc.send.data);
  const wet = new StereoMix(0.1);
  if (sp.er) wet.addStereo(reflections(send, sp.erSize ?? 1), 0, sp.er);
  if (sp.ping) {
    const p = sp.ping;
    wet.addStereo(pingPong(send, p.time, p.fb, p), 0, p.wet);
  }
  if (sp.room) wet.addStereo(room(send, sp.room), 0, sp.room.wet);
  if (sp.shimmer) wet.addStereo(shimmer(send, sp.shimmer, sp.shimmer.amount), 0, sp.shimmer.wet);
  let w = widen(wet.data, sp.width ?? 1.3);
  if (sp.pump) w = pump(w, sp.pump.bpm, sp.pump.depth, sp.pump.start);
  if (sp.orbit) w = orbit(w, sp.orbit.rate, sp.orbit.depth);
  if (sp.duck) w = duckAt(w, sp.duck.at, sp.duck.depth, sp.duck.release);
  const out = new StereoMix(0.1).addStereo(sc.dry.data).addStereo(w).data;
  return sp.glue ? saturate(out, sp.glue) : out;
}


export interface Proto {
  id: string;
  label: string;
  /** По какой ступени выставлена громкость. */
  tier: Tier;
  render: (r: Random) => Stereo;
  /** Без мастера «Клуба»: уже готовый ассет. */
  mastered?: boolean;
}

export interface Concept {
  id: string;
  title: string;
  blurb: string;
  color: string;
  protos: Proto[];
}

