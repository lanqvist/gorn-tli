/**
 * Дев-страница прослушивания звуков (только `npm run dev`, в сборку
 * не входит — её нет среди входов vite.config.ts).
 *
 * Ступени рендерятся прямо здесь тем же движком, что и генератор ассетов.
 * Эталон — локальная запись чужого звука из out/ (папка вне Git): он нужен
 * только чтобы сравнивать на слух, никогда не импортируется кодом
 * приложения и не попадает ни в ассеты, ни в сборку. Нет файла — нет кнопки.
 */
import { SR, measureStereo, type Stereo } from '../sfx/dsp.js';
import { TIERS, VARIANTS, renderSound, type Tier } from '../sfx/kit.js';

const REFERENCE = Object.values(
  import.meta.glob<string>('../../out/poe2-edits/divine-space.wav', {
    query: '?url',
    import: 'default',
    eager: true,
  }),
)[0];

const LABELS: Record<Tier, string> = {
  pickup: 'Подбор',
  pickupBig: 'Ценный подбор',
  whistle: 'Свист',
  jackpot: 'Джекпот',
  jackpotHot: 'Стрик',
  runEnd: 'Итог карты',
  runLoss: 'Карта в минус',
  record: 'Рекорд',
};

/** Лестница ценности: от частого к редкому, с паузами под хвосты. */
const LADDER: ReadonlyArray<readonly [number, Tier]> = [
  [0, 'pickup'], [1.2, 'pickupBig'], [2.8, 'whistle'], [5, 'jackpot'], [8, 'jackpotHot'], [11, 'record'],
];

/** Сессия фарма, 20 с: как на карте, подборы не чаще раза в 1.8 с. */
const FARM: ReadonlyArray<readonly [number, Tier]> = [
  [0, 'pickup'], [1.8, 'pickup'], [3.6, 'pickupBig'], [5.4, 'pickup'], [7.2, 'pickup'],
  [9, 'whistle'], [11, 'pickup'], [12.8, 'pickup'], [14, 'jackpot'], [17.5, 'runEnd'],
];

let ctx: AudioContext | null = null;
let bus: DynamicsCompressorNode | null = null;
const playing = new Set<AudioBufferSourceNode>();
const timers: Array<ReturnType<typeof setTimeout>> = [];
const cache = new Map<string, AudioBuffer>();
const turn = new Map<Tier, number>();
let referenceBuffer: Promise<AudioBuffer | null> | null = null;

const statusEl = document.getElementById('status')!;
const volume = () => Number((document.getElementById('vol') as HTMLInputElement).value) / 100;

function audio(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    // Та же шина, что у слоя плашек в приложении.
    bus = ctx.createDynamicsCompressor();
    bus.threshold.value = -18;
    bus.knee.value = 12;
    bus.ratio.value = 6;
    bus.attack.value = 0.002;
    bus.release.value = 0.12;
    bus.connect(ctx.destination);
  }
  void ctx.resume();
  return ctx;
}

function toBuffer(st: Stereo): AudioBuffer {
  const b = audio().createBuffer(2, st.l.length, SR);
  b.copyToChannel(st.l, 0);
  b.copyToChannel(st.r, 1);
  return b;
}

function start(buffer: AudioBuffer, card?: HTMLElement): void {
  const a = audio();
  const src = a.createBufferSource();
  src.buffer = buffer;
  const g = a.createGain();
  g.gain.value = volume();
  src.connect(g).connect(bus!);
  playing.add(src);
  card?.classList.add('playing');
  src.onended = () => {
    playing.delete(src);
    if (playing.size === 0) card?.classList.remove('playing');
  };
  src.start();
}

function stop(): void {
  for (const t of timers.splice(0)) clearTimeout(t);
  for (const s of playing) s.stop();
  playing.clear();
  document.querySelectorAll('.playing').forEach((el) => el.classList.remove('playing'));
  statusEl.textContent = '';
}

/** Очередной вариант ступени (повторы перебирают варианты, как в приложении). */
function next(tier: Tier): AudioBuffer {
  const v = (turn.get(tier) ?? 0) % VARIANTS[tier];
  turn.set(tier, v + 1);
  const id = `${tier}:${v}`;
  let buffer = cache.get(id);
  if (!buffer) {
    const st = renderSound(tier, v);
    buffer = toBuffer(st);
    cache.set(id, buffer);
    const m = measureStereo(st);
    statusEl.textContent = `${LABELS[tier]} ${v + 1}/${VARIANTS[tier]}: ${m.durationSec.toFixed(2)} с, пик ${m.peakDb.toFixed(1)} дБ, громкость ${m.rmsDb.toFixed(1)} дБ, энергия ${m.energyDb.toFixed(1)} дБ`;
  } else {
    statusEl.textContent = `${LABELS[tier]} ${v + 1}/${VARIANTS[tier]}`;
  }
  return buffer;
}

function loadReference(): Promise<AudioBuffer | null> {
  if (!referenceBuffer) {
    referenceBuffer = REFERENCE
      ? fetch(REFERENCE)
          .then((r) => r.arrayBuffer())
          .then((data) => audio().decodeAudioData(data))
          .catch(() => null)
      : Promise.resolve(null);
  }
  return referenceBuffer;
}

function schedule(plan: ReadonlyArray<readonly [number, Tier]>, card: HTMLElement, title: string): void {
  stop();
  // Рендерим всё заранее, чтобы план шёл ровно по времени.
  const buffers = plan.map(([t, tier]) => [t, next(tier)] as const);
  statusEl.textContent = title;
  for (const [t, buffer] of buffers) timers.push(setTimeout(() => start(buffer, card), t * 1000));
}

// ── разметка ────────────────────────────────────────────────────

function button(parent: Element, label: string, onClick: () => void, main = false): void {
  const b = document.createElement('button');
  b.textContent = label;
  if (main) b.className = 'main';
  b.onclick = onClick;
  parent.appendChild(b);
}

const refCard = document.getElementById('ref')!;
refCard.innerHTML =
  '<h2>Эталон · дивайн с космосом</h2><p>Локальная запись, только для сравнения на слух.</p><div class="btns"></div>';
const refBtns = refCard.querySelector('.btns')!;

const card = document.createElement('div');
card.className = 'card';
card.innerHTML =
  '<h2>Подпись Горна</h2><p>Один тембр — разный вес находки: от короткого тона подбора до полной подписи с аккордом на рекорде.</p><div class="btns"></div>';
const btns = card.querySelector('.btns')!;
document.getElementById('grid')!.appendChild(card);

if (REFERENCE) {
  button(refBtns, '▶ Эталон', () => {
    stop();
    void loadReference().then((b) => b && start(b, refCard));
  }, true);
  button(refBtns, '▶ A/B: эталон → джекпот', () => {
    stop();
    void loadReference().then((b) => {
      if (!b) return;
      start(b, refCard);
      timers.push(setTimeout(() => start(next('jackpot'), card), (b.duration + 0.6) * 1000));
    });
  });
} else {
  refBtns.textContent = 'Эталона нет: out/poe2-edits/divine-space.wav не найден.';
}

button(btns, '▶ Лестница ценности', () => schedule(LADDER, card, 'Лестница ценности'), true);
button(btns, '▶ Сессия фарма · 20 с', () => schedule(FARM, card, 'Сессия фарма'), true);
for (const tier of TIERS) {
  const n = VARIANTS[tier];
  button(btns, n > 1 ? `${LABELS[tier]} ×${n}` : LABELS[tier], () => {
    stop();
    start(next(tier), card);
  });
}

document.getElementById('stop')!.onclick = stop;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') stop();
});
