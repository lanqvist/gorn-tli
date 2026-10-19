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
import { ALL, CONCEPTS, PROTO_RATE, renderProto } from '../sfx/club.js';
import { CYBER_KIT, CYBER_TAPS } from '../sfx/cyber.js';
import { LADDER_LABELS, PREMIUM_KIT, PREMIUM_TAPS, SOFT_KIT, SOFT_TAPS } from '../sfx/premium.js';
import { FORGE_KIT, HYBRID, TAPS, type Tap } from '../sfx/hybrid.js';
import type { Concept } from '../sfx/scene.js';
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

const monoCheck = () => (document.getElementById('mono') as HTMLInputElement).checked;

function toBuffer(st: Stereo, rate = SR): AudioBuffer {
  const b = audio().createBuffer(2, st.l.length, rate);
  b.copyToChannel(st.l, 0);
  b.copyToChannel(st.r, 1);
  return b;
}

/** Проверка моно: оба канала — их среднее, как в одном динамике. */
function asMono(buffer: AudioBuffer): AudioBuffer {
  const l = buffer.getChannelData(0);
  const r = buffer.getChannelData(1);
  const m = new Float32Array(l.length);
  for (let i = 0; i < m.length; i++) m[i] = (l[i]! + r[i]!) * 0.5;
  const b = audio().createBuffer(2, m.length, buffer.sampleRate);
  b.copyToChannel(m, 0);
  b.copyToChannel(m, 1);
  return b;
}

function start(buffer: AudioBuffer, card?: HTMLElement): void {
  const a = audio();
  const src = a.createBufferSource();
  src.buffer = monoCheck() ? asMono(buffer) : buffer;
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

// ── прототипы «Клуб»: хаус + космос + EDM, свист со сценой ──────

const protoCache = new Map<string, AudioBuffer>();
const PROTO_LABEL = new Map(ALL.flatMap((c) => c.protos.map((p) => [p.id, `${c.title} · ${p.label}`] as const)));

function proto(id: string): AudioBuffer {
  let buffer = protoCache.get(id);
  if (!buffer) {
    const st = renderProto(id);
    buffer = toBuffer(st, PROTO_RATE);
    protoCache.set(id, buffer);
    const m = measureStereo(st);
    statusEl.textContent = `${PROTO_LABEL.get(id)}: ${(st.l.length / PROTO_RATE).toFixed(2)} с, пик ${m.peakDb.toFixed(1)} дБ, громкость ${m.rmsDb.toFixed(1)} дБ`;
  } else {
    statusEl.textContent = PROTO_LABEL.get(id) ?? id;
  }
  return buffer;
}

function playPlan(plan: ReadonlyArray<readonly [number, string]>, card: HTMLElement, title: string): void {
  stop();
  const play = () => {
    const buffers = plan.map(([t, id]) => [t, proto(id)] as const);
    statusEl.textContent = title;
    for (const [t, buffer] of buffers) timers.push(setTimeout(() => start(buffer, card), t * 1000));
  };
  if (plan.every(([, id]) => protoCache.has(id))) return play();
  // Первый рендер длинного плана занимает секунды — сначала даём странице показать, что идёт работа.
  statusEl.textContent = `${title}: готовлю звуки…`;
  timers.push(setTimeout(play, 30));
}

/** Сессия фарма с концепцией: её подборы, свист «Объём», джекпот и рекорд. */
const sessionPlan = (c: string): ReadonlyArray<readonly [number, string]> => [
  [0, `${c}-pickup`],
  [1.8, `${c}-pickup`],
  [3.6, 'whistle-vol-1'],
  [6, `${c}-pickup`],
  [7.8, `${c}-jackpot`],
  [11, `${c}-pickup`],
  [12.8, `${c}-record`],
];

/** Эталоны партитуры — локальные записи, только для сравнения на слух (как и дивайн выше). */
const EXALTED = Object.values(
  import.meta.glob<string>('../../out/poe2-edits/exalted-space.wav', { query: '?url', import: 'default', eager: true }),
)[0];
const refs = new Map<string, Promise<AudioBuffer | null>>();

function loadUrl(url: string): Promise<AudioBuffer | null> {
  let b = refs.get(url);
  if (!b) {
    b = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((data) => audio().decodeAudioData(data))
      .catch(() => null);
    refs.set(url, b);
  }
  return b;
}

/** A/B: эталон, пауза, прототип — тот же жест другим тембром. */
function abReference(url: string, id: string, el: HTMLElement, title: string): void {
  stop();
  const ours = proto(id);
  void loadUrl(url).then((ref) => {
    if (!ref) return;
    statusEl.textContent = title;
    start(ref, refCard);
    timers.push(setTimeout(() => start(ours, el), (ref.duration + 0.5) * 1000));
  });
}

function cards(list: readonly Concept[], grid: HTMLElement): void {
  for (const c of list) {
    const el = document.createElement('div');
    el.className = 'card';
    el.style.setProperty('--k', c.color);
    el.innerHTML = '<h2></h2><p></p><div class="btns"></div>';
    el.querySelector('h2')!.textContent = c.title;
    el.querySelector('p')!.textContent = c.blurb;
    const b = el.querySelector('.btns')!;
    const has = (suffix: string) => c.protos.some((p) => p.id === `${c.id}-${suffix}`);
    if (c.id === 'whistle') {
      button(b, '▶ A/B до: сейчас → объём → сцена', () =>
        playPlan([[0, 'whistle-now-1'], [2.6, 'whistle-vol-1'], [5.2, 'whistle-stage-1']], el, 'Свист до: сейчас → объём → сцена'), true);
      button(b, '▶ A/B соль', () =>
        playPlan([[0, 'whistle-now-2'], [2.6, 'whistle-vol-2'], [5.2, 'whistle-stage-2']], el, 'Свист соль: сейчас → объём → сцена'), true);
    } else {
      if (REFERENCE && has('jackpot') && has('exalted')) {
        button(b, '▶ A/B: дивайн → как дивайн', () => abReference(REFERENCE, `${c.id}-jackpot`, el, `Эталон дивайна → ${c.title}`), true);
      }
      if (EXALTED && has('exalted')) {
        button(b, '▶ A/B: возвышение → как возвышение', () => abReference(EXALTED, `${c.id}-exalted`, el, `Эталон возвышения → ${c.title}`), true);
      }
      button(b, '▶ Подбор → джекпот → рекорд', () =>
        playPlan([[0, `${c.id}-pickup`], [1.4, `${c.id}-jackpot`], [4.4, `${c.id}-record`]], el, c.title), true);
      button(b, '▶ В сессии · 17 с', () => playPlan(sessionPlan(c.id), el, `${c.title}: сессия со свистом «Объём»`), true);
    }
    for (const p of c.protos) {
      button(b, p.label, () => {
        stop();
        start(proto(p.id), el);
      });
    }
    grid.appendChild(el);
  }
}

/** Серия подборов раз в 1.8 с, как в игре; с рекордом «Пламя» посреди — подбор и рекорд одна семья? */
function series(ids: readonly string[], withRecord: boolean): ReadonlyArray<readonly [number, string]> {
  const plan: Array<readonly [number, string]> = [];
  for (let k = 0; k < 9; k++) plan.push([k * 1.8, ids[k % ids.length]!]);
  if (withRecord) plan.splice(5, 2, [9, 'forge-record-flame']);
  return plan;
}

/** Ряд направлений подбора: удар по кругу, серия и серия с «Пламенем». */
function tapRow(row: Element, el: HTMLElement, taps: readonly Tap[], prefix: string): void {
  for (const tap of taps) {
    const ids = tap.steps.map((_, v) => `${prefix}-${tap.id}-${v + 1}`);
    let n = 0;
    button(row, tap.label, () => {
      stop();
      start(proto(ids[n++ % ids.length]!), el);
    });
    button(row, `▶ Серия · ${tap.label}`, () => playPlan(series(ids, false), el, `Подбор «${tap.label}», серия 15 с`), true);
    button(row, '+ Пламя', () => playPlan(series(ids, true), el, `Подбор «${tap.label}» и рекорд «Пламя»`));
  }
}

/** Карточка набора подборов: каждое направление — удар по кругу, серия и серия с «Пламенем». */
function tapCard(grid: HTMLElement, kit: Concept, taps: readonly Tap[], prefix: string): void {
  const el = document.createElement('div');
  el.className = 'card wide';
  el.style.setProperty('--k', kit.color);
  el.innerHTML = '<h2></h2><p></p><div class="btns"></div>';
  el.querySelector('h2')!.textContent = kit.title;
  el.querySelector('p')!.textContent = kit.blurb;
  tapRow(el.querySelector('.btns')!, el, taps, prefix);
  grid.appendChild(el);
}

/**
 * Премиум-лестница: какое мягкое направление подбора выбрано — тем и звучат
 * подбор и ценный подбор; остальные ступени общие. «Сейчас» — те же планы
 * на звуках, что сейчас в приложении.
 */
function ladderCard(grid: HTMLElement): void {
  const el = document.createElement('div');
  el.className = 'card wide';
  el.style.setProperty('--k', '#ffb35a');
  el.innerHTML =
    '<h2>Премиум · вся лестница</h2><p></p><div class="btns" data-row="pick"></div><div class="btns" data-row="plan"></div><div class="btns" data-row="ab"></div>';
  el.querySelector('p')!.textContent =
    'Все ступени на премиум-цепочке, громкость каждой — по слуху, как у нынешнего звука той же ступени. Подбор и ценный подбор — выбранное мягкое направление; свист — тот же пресет «Подписи» с объёмом; джекпот и стрик — «Пламя» поменьше; рекорд — «Пламя»; итог карты — мягкий щипок соль → до; минус — низкий щипок проседает.';
  const pickRow = el.querySelector('[data-row="pick"]')!;
  const label = document.createElement('label');
  label.textContent = 'Подбор: ';
  const select = document.createElement('select');
  for (const tap of SOFT_TAPS) select.add(new Option(tap.label, tap.id));
  select.value = 'ember';
  label.appendChild(select);
  pickRow.appendChild(label);

  let turnN = 0;
  const id = (tier: Tier, now: boolean): string => {
    if (now) return `now-${tier}`;
    if (tier === 'pickup') return `prem-soft-${select.value}-${(turnN++ % 4) + 1}`;
    if (tier === 'pickupBig') return `lad-big-${select.value}`;
    if (tier === 'whistle') return 'lad-whistle-1';
    return `lad-${tier}`;
  };
  const LADDER: ReadonlyArray<readonly [number, Tier]> = [
    [0, 'pickup'], [1.2, 'pickupBig'], [2.8, 'whistle'], [5, 'jackpot'], [8, 'jackpotHot'], [11, 'record'], [15, 'runEnd'], [17, 'runLoss'],
  ];
  const SESSION: ReadonlyArray<readonly [number, Tier]> = [
    [0, 'pickup'], [1.8, 'pickup'], [3.6, 'pickup'], [5.4, 'whistle'], [7.6, 'pickup'], [9.4, 'pickupBig'], [11.2, 'pickup'],
    [12.6, 'jackpot'], [15.6, 'pickup'], [17.4, 'runEnd'],
  ];
  const plan = (p: ReadonlyArray<readonly [number, Tier]>, now: boolean) => p.map(([t, tier]) => [t, id(tier, now)] as const);
  const row = el.querySelector('[data-row="plan"]')!;
  button(row, '▶ Лестница · премиум', () => playPlan(plan(LADDER, false), el, 'Премиум-лестница'), true);
  button(row, '▶ Сессия 20 с · премиум', () => playPlan(plan(SESSION, false), el, 'Сессия фарма · премиум'), true);
  button(row, 'Лестница · сейчас', () => playPlan(plan(LADDER, true), el, 'Лестница · как сейчас в приложении'));
  button(row, 'Сессия · сейчас', () => playPlan(plan(SESSION, true), el, 'Сессия · как сейчас в приложении'));
  const ab = el.querySelector('[data-row="ab"]')!;
  for (const [tier, name] of LADDER_LABELS) {
    button(ab, `${name}: сейчас → премиум`, () => {
      const a = proto(id(tier, true));
      playPlan([[0, id(tier, true)], [a.duration + 0.5, id(tier, false)]], el, `${name}: сейчас → премиум`);
    });
  }
  grid.appendChild(el);
}

/** Горн: подборы слушаются сериями — как в игре, раз в 1.8 с; рекорд — A/B с прежним. */
function forgeCard(grid: HTMLElement): void {
  const el = document.createElement('div');
  el.className = 'card wide';
  el.style.setProperty('--k', FORGE_KIT.color);
  el.innerHTML = '<h2></h2><p></p><div class="btns" data-row="pickup"></div><div class="btns" data-row="record"></div>';
  el.querySelector('h2')!.textContent = FORGE_KIT.title;
  el.querySelector('p')!.textContent = FORGE_KIT.blurb;
  const pick = el.querySelector('[data-row="pickup"]')!;
  const rec = el.querySelector('[data-row="record"]')!;
  button(pick, '▶ Было: серия', () => playPlan(series(['forge-pickup'], false), el, 'Горн · прежний подбор, серия 15 с'));
  tapRow(pick, el, TAPS, 'forge-tap');
  button(rec, '▶ A/B: было → Металл → Пламя → Молот', () =>
    playPlan(
      [[0, 'forge-record'], [3.3, 'forge-record-metal'], [6.8, 'forge-record-flame'], [10.4, 'forge-record-hammer']],
      el,
      'Рекорд: было → Металл → Пламя → Молот',
    ), true);
  if (EXALTED) {
    button(rec, '▶ Эталон возвышения → Металл', () => abReference(EXALTED, 'forge-record-metal', el, 'Эталон возвышения → Рекорд · Металл'), true);
    button(rec, '▶ Эталон возвышения → Пламя', () => abReference(EXALTED, 'forge-record-flame', el, 'Эталон возвышения → Рекорд · Пламя'));
  }
  for (const [id, label] of [
    ['forge-record', 'Рекорд · было'],
    ['forge-record-metal', 'Рекорд · Металл'],
    ['forge-record-flame', 'Рекорд · Пламя ✓'],
    ['forge-record-hammer', 'Рекорд · Молот'],
  ] as const) {
    button(rec, label, () => {
      stop();
      start(proto(id), el);
    });
  }
  grid.appendChild(el);
}

ladderCard(document.getElementById('forge')!);
tapCard(document.getElementById('forge')!, SOFT_KIT, SOFT_TAPS, 'prem-soft');
tapCard(document.getElementById('forge')!, PREMIUM_KIT, PREMIUM_TAPS, 'prem-tap');
forgeCard(document.getElementById('forge')!);
tapCard(document.getElementById('forge')!, CYBER_KIT, CYBER_TAPS, 'cyber-tap');
cards(HYBRID, document.getElementById('score')!);
cards(CONCEPTS, document.getElementById('club')!);

document.getElementById('stop')!.onclick = stop;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') stop();
});
