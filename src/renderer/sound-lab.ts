/**
 * Дев-страница прослушивания звуков (только `npm run dev`, в сборку
 * не входит). Рендерит ассеты тем же движком, что и генератор,
 * и проигрывает их через такую же шину, как слой плашек.
 */
import { SR, measure } from '../sfx/dsp.js';
import { TIERS, VARIANTS, renderSound, type Tier } from '../sfx/kit.js';

const LABELS: Record<Tier, string> = {
  pickup: 'Мелкий подбор',
  pickupBig: 'Ценный подбор',
  whistle: 'Свист',
  jackpot: 'Золотая находка',
  jackpotHot: 'Вторая подряд',
  runEnd: 'Итог карты',
  runLoss: 'Карта в минус',
  record: 'Рекорд',
};

let ctx: AudioContext | null = null;
let bus: DynamicsCompressorNode | null = null;
const cache = new Map<string, AudioBuffer>();
const turn = new Map<string, number>();

function audio(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
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

function play(tier: Tier, stat?: HTMLElement): void {
  const a = audio();
  const key = tier;
  const v = (turn.get(key) ?? 0) % VARIANTS[tier];
  turn.set(key, v + 1);
  const id = `${key}:${v}`;
  let buffer = cache.get(id);
  if (!buffer) {
    const sig = renderSound(tier, v);
    buffer = a.createBuffer(1, sig.length, SR);
    buffer.copyToChannel(sig, 0);
    cache.set(id, buffer);
    if (stat) {
      const m = measure(sig);
      stat.textContent = `${LABELS[tier]}, вариант ${v + 1}/${VARIANTS[tier]}: ${m.durationSec.toFixed(2)} с, пик ${m.peakDb.toFixed(1)} дБ, громкость ${m.rmsDb.toFixed(1)} дБ`;
    }
  } else if (stat) {
    stat.textContent = `${LABELS[tier]}, вариант ${v + 1}/${VARIANTS[tier]}`;
  }
  const src = a.createBufferSource();
  src.buffer = buffer;
  // Лёгкий разброс высоты, как в приложении: повтор не звучит копией.
  src.playbackRate.value = 1 + (Math.random() * 2 - 1) * 0.015;
  const g = a.createGain();
  g.gain.value = Number((document.getElementById('vol') as HTMLInputElement).value) / 100;
  src.connect(g).connect(bus!);
  src.start();
}

function simulate(): void {
  const plan: Array<[number, Tier]> = [
    [0, 'pickup'], [1.8, 'pickup'], [3.6, 'whistle'], [5.4, 'pickupBig'],
    [7.2, 'pickup'], [9, 'jackpot'], [11.5, 'runEnd'],
  ];
  audio();
  for (const [t, tier] of plan) setTimeout(() => play(tier), t * 1000);
}

const grid = document.getElementById('grid')!;
const card = document.createElement('div');
card.className = 'card';
card.style.setProperty('--k', '#ff8a3d');
card.innerHTML =
  '<h2>Пепельный фонк</h2><p>Мемфисский ковбелл 808 во фригийском ре, рычащий 808 со слайдами, ' +
  'вокальный чоп, кассетная пыль, тейп-стоп на минусе. Свист — на дорогой предмет, как в PoE.</p>' +
  '<div class="btns"></div><div class="stat"></div>';
const btns = card.querySelector('.btns')!;
const stat = card.querySelector<HTMLElement>('.stat')!;
for (const tier of TIERS) {
  const b = document.createElement('button');
  b.innerHTML =
    VARIANTS[tier] > 1 ? `${LABELS[tier]}<small>×${VARIANTS[tier]}</small>` : LABELS[tier];
  b.onclick = () => play(tier, stat);
  btns.appendChild(b);
}
const sim = document.createElement('button');
sim.className = 'sim';
sim.textContent = '▶ Сессия фарма (13 с)';
sim.onclick = simulate;
card.appendChild(sim);
grid.appendChild(card);
