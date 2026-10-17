import { BrowserWindow, desktopCapturer, ipcMain, type Display } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Сверх ожидания спокойного экрана — запас на ответ окна потока. */
const GRAB_SLACK_MS = 1500;
/** Только что открытому потоку — столько на первый кадр, а не «молчит». */
const COLD_MS = 2500;
/** Поток без запросов дольше этого закрывается (вышли из тюрьмы). */
const IDLE_MS = 180_000;

export interface Frame {
  width: number;
  height: number;
  buffer: ArrayBuffer;
  format: 'rgba' | 'bgra';
}

/**
 * Поток экрана монитора с игрой в скрытом окне (renderer/capture.html).
 * Кадр по запросу — текущая картинка видео, без нового снимка экрана.
 */
export class ScreenStream {
  private window: BrowserWindow | null = null;
  private loaded: Promise<void> | null = null;
  private displayId: number | null = null;
  private starting: Promise<boolean> | null = null;
  private live = false;
  private nextGrab = 0;
  private readonly grabs = new Map<number, (f: Frame | null) => void>();
  private idleTimer: NodeJS.Timeout | null = null;
  private startedCb: ((err: string | null) => void) | null = null;
  private openedAt = 0;
  /** Источник монитора: getSources в 4K — секунды, а id монитора не меняется. */
  private readonly sourceIds = new Map<number, string>();
  /**
   * Почему последний grab вернул null: «stale» — поток жив, но игра не
   * пересобирает экран (переоткрытие не поможет), иначе — поток молчит.
   */
  lastMiss: 'stale' | 'silent' | null = null;

  constructor() {
    ipcMain.on('capture:started', (e, err: string | null) => {
      if (e.sender !== this.window?.webContents) return;
      this.startedCb?.(err);
    });
    ipcMain.on('capture:frame', (e, id: number, frame: { width: number; height: number; buffer: ArrayBuffer } | null, err: string | null) => {
      if (e.sender !== this.window?.webContents) return;
      if (err && !err.startsWith('stale')) console.warn('[тюрьма] кадр из потока:', err);
      if (err?.startsWith('stale')) console.log(`[тюрьма] из потока нет свежего кадра (${err.slice(7)})`);
      this.lastMiss = frame ? null : err?.startsWith('stale') ? 'stale' : 'silent';
      const done = this.grabs.get(id);
      this.grabs.delete(id);
      done?.(frame ? { ...frame, format: 'rgba' } : null);
    });
  }

  /** Открыть поток заранее (в тюрьме, до первого нужного кадра). */
  warm(display: Display): void {
    void this.ensure(display);
  }

  /**
   * Кадр монитора, на котором экран уже stableMs не менялся (не дольше
   * maxMs), или null — тогда запасной способ.
   */
  async grab(display: Display, stableMs = 0, maxMs = 400): Promise<Frame | null> {
    this.lastMiss = 'silent';
    if (!(await this.ensure(display)) || !this.window) return null;
    this.touch();
    if (Date.now() - this.openedAt < COLD_MS) maxMs = Math.max(maxMs, COLD_MS);
    const id = ++this.nextGrab;
    return new Promise<Frame | null>((resolve) => {
      const timer = setTimeout(() => {
        this.grabs.delete(id);
        console.warn('[тюрьма] поток не отдал кадр за', maxMs + GRAB_SLACK_MS, 'мс');
        resolve(null);
      }, maxMs + GRAB_SLACK_MS);
      this.grabs.set(id, (f) => {
        clearTimeout(timer);
        resolve(f);
      });
      this.window?.webContents.send('capture:grab', id, stableMs, maxMs);
    });
  }

  stop(): void {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('capture:stop');
    this.live = false;
    this.displayId = null;
  }

  /** Поток молчит (ни одного кадра) — открыть заново. */
  async restart(display: Display): Promise<boolean> {
    this.stop();
    return this.ensure(display);
  }

  destroy(): void {
    this.stop();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_MS);
  }

  private async ensure(display: Display): Promise<boolean> {
    if (this.live && this.displayId === display.id) return true;
    if (this.starting) return this.starting;
    this.starting = this.start(display).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(display: Display): Promise<boolean> {
    const known = this.sourceIds.get(display.id);
    if (known && (await this.open(display, known))) return true;
    this.sourceIds.delete(display.id);
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined);
      if (!source) return false;
      if (!(await this.open(display, source.id))) return false;
      this.sourceIds.set(display.id, source.id);
      return true;
    } catch (err) {
      console.warn('[тюрьма] поток экрана:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  private async open(display: Display, sourceId: string): Promise<boolean> {
    try {
      const win = this.ensureWindow();
      await this.loaded;
      const width = Math.round(display.size.width * display.scaleFactor);
      const height = Math.round(display.size.height * display.scaleFactor);
      const err = await new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve('поток не открылся за 5 с'), 5000);
        this.startedCb = (e) => {
          clearTimeout(timer);
          resolve(e);
        };
        win.webContents.send('capture:start', { sourceId, width, height });
      });
      this.startedCb = null;
      if (err) {
        console.warn('[тюрьма] поток экрана:', err);
        return false;
      }
      this.live = true;
      this.displayId = display.id;
      this.openedAt = Date.now();
      this.touch();
      console.log(`[тюрьма] поток экрана открыт: монитор ${display.id}, ${width}×${height}`);
      return true;
    } catch (err) {
      console.warn('[тюрьма] поток экрана:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 180,
      skipTaskbar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        // Скрытое окно не должно засыпать: кадры нужны в любой момент.
        backgroundThrottling: false,
      },
    });
    const devServer = process.env['VITE_DEV_SERVER_URL'];
    this.loaded = (devServer ? win.loadURL(new URL('capture.html', devServer).href) : win.loadFile(join(__dirname, '../renderer/capture.html'))).then(() => undefined);
    // Журнал скрытого окна — в общий журнал: иначе его не видно.
    win.webContents.on('console-message', (e) => console.log(`[тюрьма] ${e.message}`));
    win.on('closed', () => {
      this.window = null;
      this.live = false;
    });
    this.window = win;
    return win;
  }
}
