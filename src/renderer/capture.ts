/**
 * Скрытое окно с потоком экрана для подсказок в тюрьме.
 *
 * Снимок через desktopCapturer.getSources в 4K занимает от 0,4 до 4 секунд —
 * подсказка опаздывала на ход. Поток монитора держится открытым, окно хранит
 * последний пришедший кадр и следит, когда картинка последний раз менялась:
 * кадр для подсказки берётся, как только экран успокоился после хода, а не
 * через фиксированную паузу «на анимацию».
 */
const video = document.getElementById('screen') as HTMLVideoElement;
let stream: MediaStream | null = null;
let track: MediaStreamTrack | null = null;
/** Размер потока: applyConstraints без него сбросил бы разрешение. */
let size = { width: 0, height: 0 };
let latest: VideoFrame | null = null;
let latestAt = 0;
/** Когда картинка последний раз заметно менялась. */
let changedAt = 0;
let canvas: OffscreenCanvas | null = null;

/**
 * Кадр уменьшается здесь же до ширины не больше этой: распознавание и так
 * работает на ~1920 (4K оно уменьшает вдвое), а 4K-кадр — это 33 МБ на
 * чтение с холста и передачу между процессами, почти секунда.
 */
const MAX_WIDTH = 2600;

/**
 * Кадров в секунду из потока. Экран «успокоился» — 300 мс без изменений:
 * при 10 кадрах это три кадра подряд, кадр приходит в среднем на 17 мс
 * позже, чем при 15, а захват 4K дешевле на треть (замер 19.10).
 */
const FPS = 10;
/**
 * Кадров в секунду, пока Горн ничего не ждёт. Игра перерисовывает экран
 * всё время (факелы, свечение), и на 10 к/с поток всю тюрьму тянул 4K и
 * отпечаток каждого кадра. Ход игрока (main шлёт boost) и запрос кадра
 * поднимают частоту до FPS; обратно — через BOOST_MS. Возврат до первого
 * кадра на 10 к/с — ~0,26 с (замер 20.10).
 */
const IDLE_FPS = 2;
const BOOST_MS = 5000;
let rate = 0;
let boostTimer: ReturnType<typeof setTimeout> | null = null;
let idleLogged = false;

/** Частота дорожки: Chrome прореживает кадры и реже снимает сам экран. */
function setRate(fps: number): void {
  const t = track;
  if (!t || rate === fps) return;
  rate = fps;
  t.applyConstraints({ width: { exact: size.width }, height: { exact: size.height }, frameRate: { max: fps } }).then(
    () => {
      if (fps !== IDLE_FPS || idleLogged || track !== t) return;
      idleLogged = true;
      const st = t.getSettings();
      console.log(`[поток] в простое ${st.frameRate} к/с (${st.width}×${st.height}), при ходе — ${FPS}`);
    },
    (err: unknown) => {
      // Не вышло — частота осталась прежней; следующий вызов попробует снова.
      if (track === t && rate === fps) rate = 0;
      console.warn(`[поток] частота ${fps} к/с не применилась:`, err instanceof Error ? err.message : String(err));
    },
  );
}

/** Полная частота на BOOST_MS: экран вот-вот сменится или нужен кадр. */
function boost(): void {
  setRate(FPS);
  if (boostTimer) clearTimeout(boostTimer);
  boostTimer = setTimeout(() => {
    boostTimer = null;
    setRate(IDLE_FPS);
  }, BOOST_MS);
}

// ---------- Отпечаток кадра: заметил ли глаз изменение ----------

const SIG_W = 64;
const SIG_H = 36;
const sigCanvas = new OffscreenCanvas(SIG_W, SIG_H);
// Холст на видеокарте: кадр 4K уменьшается там, а читается только 64×36.
// Холст в памяти процессора тянул каждый кадр 4K целиком — 14,7 мс на кадр,
// ~20% ядра на окно захвата и GPU (замер 19.10); на видеокарте — 4,3 мс.
// willReadFrequently: false — явно: без него Chrome после нескольких чтений
// может сам перевести холст в память процессора.
const sigCtx = sigCanvas.getContext('2d', { willReadFrequently: false });
let lastSig: Uint8ClampedArray | null = null;
/**
 * Средняя разница отпечатков (0–255), выше которой картинка «изменилась».
 * Факелы и свечение узников мерцают на 1–2; карточки, стрелка надзирателя,
 * затемнение — десятки.
 */
const CHANGE = 3;

function noteChange(frame: VideoFrame, at: number): void {
  if (!sigCtx) return;
  sigCtx.drawImage(frame, 0, 0, SIG_W, SIG_H);
  const sig = sigCtx.getImageData(0, 0, SIG_W, SIG_H).data;
  if (lastSig) {
    let diff = 0;
    for (let i = 0; i < sig.length; i += 4) diff += Math.abs(sig[i]! - lastSig[i]!) + Math.abs(sig[i + 1]! - lastSig[i + 1]!);
    if (diff / ((sig.length / 4) * 2) > CHANGE) changedAt = at;
  } else changedAt = at;
  lastSig = sig;
}

declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack });
  readonly readable: ReadableStream<VideoFrame>;
}

async function start(sourceId: string, width: number, height: number): Promise<void> {
  stop();
  // Старый, но рабочий в Electron способ выбрать источник без диалога.
  const constraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        minWidth: width,
        maxWidth: width,
        minHeight: height,
        maxHeight: height,
        maxFrameRate: FPS,
      },
    },
  } as unknown as MediaStreamConstraints;
  const s = await navigator.mediaDevices.getUserMedia(constraints);
  stream = s;
  const t = s.getVideoTracks()[0];
  if (!t) throw new Error('в потоке нет видео');
  track = t;
  size = { width, height };
  rate = FPS;
  // Только что открыли — значит, кадр скоро понадобится; потом простой.
  boost();
  void keepLatest(s, t);
}

/** Держать последний кадр дорожки; старые сразу освобождать. */
async function keepLatest(s: MediaStream, track: MediaStreamTrack): Promise<void> {
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  try {
    while (stream === s) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const at = performance.now();
      noteChange(value, at);
      latest?.close();
      latest = value;
      latestAt = at;
    }
  } finally {
    reader.releaseLock();
  }
}

function stop(): void {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  track = null;
  rate = 0;
  idleLogged = false;
  if (boostTimer) clearTimeout(boostTimer);
  boostTimer = null;
  latest?.close();
  latest = null;
  lastSig = null;
  video.srcObject = null;
}

function pixels(frame: VideoFrame): { width: number; height: number; buffer: ArrayBuffer } {
  const srcWidth = frame.displayWidth;
  const srcHeight = frame.displayHeight;
  const f = Math.max(1, Math.ceil(srcWidth / MAX_WIDTH));
  const width = Math.floor(srcWidth / f);
  const height = Math.floor(srcHeight / f);
  if (!canvas || canvas.width !== width || canvas.height !== height) canvas = new OffscreenCanvas(width, height);
  // Холст на видеокарте: 4K уменьшается там, с видеокарты читается уже
  // 1920×1080. Холст в памяти процессора тянул 4K целиком и уменьшал сам —
  // 40 мс против 9,5; разница пикселей — не больше 2 из 255, в среднем 0,12
  // (замер 20.10 на кадрах экрана 3840×2160).
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  if (!ctx) throw new Error('нет 2d-контекста');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(frame, 0, 0, width, height);
  return { width, height, buffer: ctx.getImageData(0, 0, width, height).data.buffer as ArrayBuffer };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Кадр после запроса, на котором экран уже stableMs не менялся; не дольше
 * maxMs (тогда — последний свежий). Новых кадров нет — поток присылает
 * кадры только на изменения, и статичный экран (выбор орудий, окно события)
 * их не даёт: годится последний, если он не старше okAgeMs (снят уже после
 * события). Иначе — ошибка «stale»: main-процесс подтолкнёт и спросит снова.
 */
async function grab(stableMs: number, maxMs: number, okAgeMs = 0): Promise<{ width: number; height: number; buffer: ArrayBuffer }> {
  if (!stream) throw new Error('поток не открыт');
  boost();
  const asked = performance.now();
  for (;;) {
    const now = performance.now();
    const fresh = latestAt >= asked;
    if (fresh && now - changedAt >= stableMs) break;
    if (now - asked >= maxMs) break;
    await wait(20);
  }
  if (!latest) throw new Error('из потока ещё не пришло ни одного кадра');
  if (latestAt < asked && asked - latestAt > okAgeMs) throw new Error(`stale: последнему кадру ${Math.round(asked - latestAt)} мс`);
  const t1 = performance.now();
  const out = pixels(latest);
  console.log(`[поток] ждал ${Math.round(t1 - asked)} мс (спокойно ${Math.round(t1 - changedAt)} мс), пиксели ${Math.round(performance.now() - t1)} мс`);
  return out;
}

const api = window.gorn?.capture;
api?.onStart((req) => {
  start(req.sourceId, req.width, req.height).then(
    () => api.started(null),
    (err: unknown) => api.started(err instanceof Error ? err.message : String(err)),
  );
});
api?.onStop(() => stop());
api?.onBoost(() => boost());
api?.onGrab((id, stableMs, maxMs, okAgeMs) => {
  grab(stableMs, maxMs, okAgeMs).then(
    (frame) => api.frame(id, frame, null),
    (err: unknown) => api.frame(id, null, err instanceof Error ? err.message : String(err)),
  );
});
