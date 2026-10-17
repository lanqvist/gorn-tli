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

// ---------- Отпечаток кадра: заметил ли глаз изменение ----------

const SIG_W = 64;
const SIG_H = 36;
const sigCanvas = new OffscreenCanvas(SIG_W, SIG_H);
const sigCtx = sigCanvas.getContext('2d', { willReadFrequently: true });
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
        maxFrameRate: 15,
      },
    },
  } as unknown as MediaStreamConstraints;
  const s = await navigator.mediaDevices.getUserMedia(constraints);
  stream = s;
  const track = s.getVideoTracks()[0];
  if (!track) throw new Error('в потоке нет видео');
  void keepLatest(s, track);
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
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
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
api?.onGrab((id, stableMs, maxMs, okAgeMs) => {
  grab(stableMs, maxMs, okAgeMs).then(
    (frame) => api.frame(id, frame, null),
    (err: unknown) => api.frame(id, null, err instanceof Error ? err.message : String(err)),
  );
});
