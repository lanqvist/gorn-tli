/**
 * Звук слоя всплывающего дохода.
 *
 * Эстетика — кузница, под стать игре и названию трекера: глухой металл,
 * а не казиношный «дзынь». Три принципа:
 *
 *  1. Тембр металла делается ИНГАРМОНИЧНЫМИ частичными тонами
 *     (соотношения из спектра удара по металлу: 1 / 2.13 / 3.42 / 5.18) —
 *     ровно то, чем звон монеты отличается от синусоидного «пинга».
 *  2. Всё пропущено через резонансный полосовой фильтр и мягкий лоу-пасс:
 *     срезаны верха, из-за которых синтез звучит «дёшево».
 *  3. Каждый удар чуть случаен по высоте (±4%) — повторяющийся сэмпл
 *     раздражает, слегка живой — нет.
 *
 * Синтез вместо файлов: нет ассетов и лицензий, высота и вес звука
 * масштабируются от ценности находки непрерывно. AudioContext создаётся
 * лениво: слой почти всё время молчит.
 */

let ctx: AudioContext | null = null;

function context(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

/** Ингармонические соотношения частичных тонов удара по металлу. */
const METAL_PARTIALS: ReadonlyArray<readonly [ratio: number, share: number]> = [
  [1, 1],
  [2.13, 0.45],
  [3.42, 0.22],
  [5.18, 0.1],
];

const jitter = (spread = 0.04) => 1 + (Math.random() * 2 - 1) * spread;

/**
 * Один металлический удар: пачка ингармонических частичных через
 * резонансный фильтр. brightness 0..1 — сколько верхних частичных слышно.
 */
function metalHit(
  at: number,
  f0: number,
  decay: number,
  gainPeak: number,
  brightness: number,
  volume: number,
): void {
  const audio = context();

  const master = audio.createGain();
  master.gain.value = volume;

  // Лоу-пасс убирает синтетическую «стеклянность» — звук глохнет, как
  // от настоящего металла, а не от генератора.
  const lowpass = audio.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 1800 + brightness * 2600;
  lowpass.Q.value = 0.6;

  lowpass.connect(master).connect(audio.destination);

  for (const [ratio, share] of METAL_PARTIALS) {
    const level = share * (ratio === 1 ? 1 : brightness);
    if (level < 0.02) continue;
    const osc = audio.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f0 * ratio * jitter(0.006);
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(gainPeak * level, at + 0.004);
    // Верхние частичные глохнут быстрее нижних — как в настоящем ударе.
    gain.gain.exponentialRampToValueAtTime(0.0001, at + decay / Math.sqrt(ratio));
    osc.connect(gain).connect(lowpass);
    osc.start(at);
    osc.stop(at + decay + 0.05);
  }

  // Короткий шумовой щелчок атаки: без него удар звучит «нарисованным».
  const noiseDur = 0.03;
  const buffer = audio.createBuffer(1, Math.ceil(audio.sampleRate * noiseDur), audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const noise = audio.createBufferSource();
  noise.buffer = buffer;
  const noiseBand = audio.createBiquadFilter();
  noiseBand.type = 'bandpass';
  noiseBand.frequency.value = f0 * 3;
  noiseBand.Q.value = 1.2;
  const noiseGain = audio.createGain();
  noiseGain.gain.setValueAtTime(gainPeak * 0.5, at);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, at + noiseDur);
  noise.connect(noiseBand).connect(noiseGain).connect(lowpass);
  noise.start(at);
}

/** Треск углей: редкие короткие фильтрованные щелчки после большого удара. */
function emberCrackle(at: number, durationSec: number, volume: number): void {
  const audio = context();
  const master = audio.createGain();
  master.gain.value = volume * 0.35;
  const band = audio.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 2400;
  band.Q.value = 2;
  band.connect(master).connect(audio.destination);

  let t = at + 0.12;
  while (t < at + durationSec) {
    const len = 0.008 + Math.random() * 0.012;
    const buffer = audio.createBuffer(1, Math.ceil(audio.sampleRate * len), audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = audio.createBufferSource();
    src.buffer = buffer;
    const g = audio.createGain();
    // Затухают вместе с ударом.
    g.gain.value = Math.max(0.05, 1 - (t - at) / durationSec) * (0.4 + Math.random() * 0.6);
    src.connect(g).connect(band);
    src.start(t);
    t += 0.05 + Math.random() * 0.13;
  }
}

/**
 * Подбор добычи: короткий глухой звяк монеты о металл.
 * Ценность добавляет весу (ниже и дольше), а не пронзительности.
 */
export function playPickup(valueFe: number, volume: number): void {
  if (volume <= 0) return;
  try {
    const audio = context();
    const now = audio.currentTime;
    const weight = Math.min(1, Math.log10(Math.max(1, valueFe)) / 2.5); // 0..1 к ~300 ФЕ
    const f0 = 340 * (1 - weight * 0.35) * jitter();
    metalHit(now, f0, 0.16 + weight * 0.14, 0.4, 0.35 + weight * 0.25, volume);
    // Весомая находка отзывается вторым, более низким касанием.
    if (weight > 0.45) {
      metalHit(now + 0.07, f0 * 0.66, 0.22, 0.28, 0.3, volume);
    }
  } catch {
    // Звук — украшение: любая ошибка аудиостека не должна ронять слой.
  }
}

/**
 * Крупная находка: удар молота по наковальне с гулом и треском углей.
 * Один основной удар — торжественно, но не мультяшно.
 */
export function playJackpot(volume: number): void {
  if (volume <= 0) return;
  try {
    const audio = context();
    const now = audio.currentTime;
    const f0 = 180 * jitter(0.03);
    // Сам удар: низкий, долгий, тёмный.
    metalHit(now, f0, 1.1, 0.55, 0.5, volume);
    // Октавой выше — «звон» наковальни, тише и короче.
    metalHit(now + 0.012, f0 * 2.02, 0.5, 0.22, 0.7, volume);
    emberCrackle(now, 0.9, volume);
  } catch {
    /* см. playPickup */
  }
}

/** Карта закрыта: два глухих удара вниз — работа сделана. Минус — один тусклый. */
export function playRunEnd(netFe: number, volume: number): void {
  if (volume <= 0) return;
  try {
    const audio = context();
    const now = audio.currentTime;
    if (netFe >= 0) {
      metalHit(now, 240 * jitter(0.02), 0.35, 0.4, 0.35, volume);
      metalHit(now + 0.16, 170 * jitter(0.02), 0.6, 0.42, 0.3, volume);
    } else {
      metalHit(now, 120 * jitter(0.02), 0.4, 0.42, 0.15, volume);
    }
  } catch {
    /* см. playPickup */
  }
}
