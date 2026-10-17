/**
 * Звук слоя всплывающего дохода.
 *
 * Сами звуки — готовые ассеты «Пепельного фонка»: их заранее рендерит
 * наш генератор (src/sfx, npm run sounds) — ковбелл 808, рычащий 808,
 * вокальные чопы, пламя и кристаллы Элементия, свист на дорогой предмет.
 * Громкость каждого файла выверена замером ещё при рендере, поэтому
 * здесь только выбор, когда и что проиграть.
 *
 * Ступени — как в фильтрах добычи PoE: у каждой свой звук-предмет,
 * а не тот же звук погромче. У частых ступеней несколько вариантов,
 * они идут по кругу, и каждый повтор чуть сдвинут по высоте (±1.5%) —
 * ухо не замыливается.
 *
 * Подборы звучат не чаще одного удара за окно троттлинга: лог тикает
 * каждые 300 мс, и удар на каждый тик — звуковой спам, от которого игрок
 * за час выключит звук совсем. Дельты внутри окна копятся и озвучиваются
 * одним ударом с весом накопленного; мелочь тише порога не звенит вовсе.
 *
 * Файлы встроены в бандл как data-URL: страницы грузятся с file://,
 * и так звук работает одинаково в деве и в собранном приложении.
 * AudioContext и декодирование — лениво: слой почти всё время молчит.
 */
import type { Tier } from '../../sfx/kit.js';

const FILES = import.meta.glob<string>('../assets/sfx/*.wav', {
  query: '?inline',
  import: 'default',
  eager: true,
});

/** Ступень → её варианты (data-URL), по порядку номеров в имени файла. */
const BANK = new Map<Tier, string[]>();
for (const [path, url] of Object.entries(FILES).sort(([a], [b]) => a.localeCompare(b))) {
  const match = /\/([A-Za-z]+)-\d+\.wav$/.exec(path);
  if (!match) continue;
  const tier = match[1] as Tier;
  BANK.set(tier, [...(BANK.get(tier) ?? []), url]);
}

let ctx: AudioContext | null = null;

function context(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

let bus: DynamicsCompressorNode | null = null;

/**
 * Общая выходная шина с компрессором-лимитером: хвосты подборов,
 * свист и джекпот могут наложиться, и на громкости ближе к единице
 * без него возможен клиппинг.
 */
function output(): AudioNode {
  const audio = context();
  if (!bus) {
    bus = audio.createDynamicsCompressor();
    bus.threshold.value = -18;
    bus.knee.value = 12;
    bus.ratio.value = 6;
    bus.attack.value = 0.002;
    bus.release.value = 0.12;
    bus.connect(audio.destination);
  }
  return bus;
}

const decoded = new Map<string, Promise<AudioBuffer>>();

/**
 * data-URL → AudioBuffer. Base64 разбираем сами, а не через fetch:
 * CSP страниц (connect-src) не пускает fetch даже к data:.
 */
function load(url: string): Promise<AudioBuffer> {
  let buffer = decoded.get(url);
  if (!buffer) {
    const binary = atob(url.slice(url.indexOf(',') + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    buffer = context().decodeAudioData(bytes.buffer);
    decoded.set(url, buffer);
  }
  return buffer;
}

const turn = new Map<Tier, number>();

/** Проиграть очередной вариант ступени. Ошибки глотаются: звук — украшение. */
function playTier(tier: Tier, volume: number): void {
  const variants = BANK.get(tier);
  if (!variants || variants.length === 0 || volume <= 0) return;
  const n = turn.get(tier) ?? 0;
  turn.set(tier, n + 1);
  const url = variants[n % variants.length]!;
  try {
    const audio = context();
    void audio.resume();
    load(url)
      .then((buffer) => {
        const src = audio.createBufferSource();
        src.buffer = buffer;
        src.playbackRate.value = 1 + (Math.random() * 2 - 1) * 0.015;
        const gain = audio.createGain();
        gain.gain.value = volume;
        src.connect(gain).connect(output());
        src.start();
      })
      .catch(() => {
        // Битый или недекодируемый файл не должен ронять слой.
      });
  } catch {
    /* см. выше */
  }
}

/** Подбор: весомый (≈13 ФЕ и выше) звучит двумя ковбеллами с 808, мелкий — одной нотой. */
function pickupVoice(valueFe: number, volume: number): void {
  const weight = Math.min(1, Math.log10(Math.max(1, valueFe)) / 2.5); // 0..1 к ~300 ФЕ
  playTier(weight > 0.45 ? 'pickupBig' : 'pickup', volume);
}

/** Пикапы звучат не чаще одного удара за это окно. */
const PICKUP_THROTTLE_MS = 1800;
/** Накопленная мелочь тише этого порога не озвучивается вовсе. */
const PICKUP_MIN_FE = 1;

let pendingFe = 0;
let pendingVolume = 0;
let lastHitAt = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Подбор добычи: ковбелл.
 *
 * Троттлинг живёт здесь, а не у вызывающего: дельты внутри окна копятся
 * и звучат одним ударом с весом накопленной суммы. Джекпот и итог карты
 * идут мимо — они редкие и осмысленные.
 */
export function playPickup(valueFe: number, volume: number): void {
  if (volume <= 0) return;
  pendingFe += valueFe;
  pendingVolume = Math.max(pendingVolume, volume);
  const sinceLast = Date.now() - lastHitAt;
  if (sinceLast >= PICKUP_THROTTLE_MS) {
    flushPickup();
  } else if (flushTimer === null) {
    flushTimer = setTimeout(flushPickup, PICKUP_THROTTLE_MS - sinceLast);
  }
}

function flushPickup(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const valueFe = pendingFe;
  const volume = pendingVolume;
  pendingFe = 0;
  pendingVolume = 0;
  // Не добравшаяся до порога мелочь сбрасывается, а не копится вечно:
  // иначе мусор по 0,1 ФЕ раз в десять минут внезапно звенел бы.
  if (valueFe < PICKUP_MIN_FE) return;
  lastHitAt = Date.now();
  pickupVoice(valueFe, volume);
}

/** Свист не чаще раза в это окно: босс может высыпать пачку дорогого. */
const WHISTLE_GAP_MS = 1500;
let lastWhistleAt = 0;

/**
 * Дорогой предмет — свист, как в фильтрах PoE. Свист заменяет удар
 * подбора: накопленная мелочь сгорает, и следующий удар ждёт полное
 * окно троттлинга, чтобы ковбелл не наступал свисту на хвост.
 */
export function playWhistle(volume: number): void {
  if (volume <= 0) return;
  const now = Date.now();
  if (now - lastWhistleAt < WHISTLE_GAP_MS) return;
  lastWhistleAt = now;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pendingFe = 0;
  pendingVolume = 0;
  lastHitAt = now;
  playTier('whistle', volume);
}

/**
 * Крупная находка: вокальный чоп, фраза ковбелла над рычащим 808,
 * вспышка пламени. Стрик (второй джекпот подряд) добавляет «эй!»
 * и пробег ковбелла вверх.
 */
export function playJackpot(volume: number, hot = false): void {
  playTier(hot ? 'jackpotHot' : 'jackpot', volume);
}

/** Рекорд сессии: полтакта мемфисского грува с точкой из кристаллов. */
export function playCoinRain(volume: number): void {
  playTier('record', volume);
}

/** Карта закрыта: 808 съезжает вниз под два ковбелла. Минус — тейп-стоп, «вууу». */
export function playRunEnd(netFe: number, volume: number): void {
  playTier(netFe >= 0 ? 'runEnd' : 'runLoss', volume);
}

/**
 * Пробный удар для ползунка громкости: средний подбор, мимо троттлинга —
 * игрок крутит ползунок и должен слышать результат сразу.
 */
export function playTest(volume: number): void {
  pickupVoice(40, volume);
}

export type SoundPreview =
  | 'pickup'
  | 'whistle'
  | 'jackpot'
  | 'jackpotHot'
  | 'runEnd'
  | 'runLoss'
  | 'record';

/** Прослушивание из настроек: каждый звук как в игре, мимо троттлинга. */
export function playPreview(kind: SoundPreview, volume: number): void {
  switch (kind) {
    case 'pickup':
      return playTest(volume);
    case 'whistle':
      return playTier('whistle', volume);
    case 'jackpot':
      return playJackpot(volume);
    case 'jackpotHot':
      return playJackpot(volume, true);
    case 'runEnd':
      return playRunEnd(100, volume);
    case 'runLoss':
      return playRunEnd(-10, volume);
    case 'record':
      return playCoinRain(volume);
  }
}
