import { BrowserWindow, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { SettingsStore } from './settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const WIDTH = 560;
const INITIAL_HEIGHT = 40;
const MAX_HEIGHT = 260;

/**
 * Слой всплывающего дохода: отдельное прозрачное окно у центра экрана.
 *
 * Отличия от оверлея-панели:
 *  - клики пропускает ВСЕГДА, интерактива нет вовсе — это чистый
 *    floating combat text;
 *  - позиция фиксированная: по горизонтали центр, по вертикали чуть выше
 *    середины — над персонажем, но не поверх прицела и не поверх босс-бара;
 *  - окно скрыто, пока показывать нечего: прозрачная площадь стоит
 *    композитору дорого, а слой большую часть времени пуст.
 *
 * Монитор берётся тот же, где стоит оверлей-панель (обычно это монитор
 * с игрой), иначе — основной.
 */
export class ToastLayer {
  private window: BrowserWindow | null = null;
  private hideTimer: NodeJS.Timeout | null = null;

  constructor(private readonly settings: SettingsStore) {}

  get isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed();
  }

  /** Нужен ли слой вообще: и плашки, и звук живут в этом окне. */
  private get wanted(): boolean {
    const prefs = this.settings.overlay;
    return prefs.popups || prefs.sound;
  }

  /** Приводит существование окна в соответствие с настройками. */
  sync(): void {
    if (this.wanted) this.open();
    else this.close();
  }

  open(): void {
    if (this.isOpen) return;

    this.window = new BrowserWindow({
      width: WIDTH,
      height: INITIAL_HEIGHT,
      ...this.position(),
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        // Слой должен рисовать и звучать, когда фокус у игры.
        backgroundThrottling: false,
      },
    });

    this.window.setAlwaysOnTop(true, 'screen-saver');
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.setIgnoreMouseEvents(true);

    this.window.on('closed', () => {
      this.window = null;
    });

    const devServer = process.env['VITE_DEV_SERVER_URL'];
    if (devServer) {
      void this.window.loadURL(new URL('toasts.html', devServer).href);
    } else {
      void this.window.loadFile(join(__dirname, '../renderer/toasts.html'));
    }
    // Окно НЕ показывается после загрузки: оно ждёт первой плашки.
  }

  close(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.window?.close();
    this.window = null;
  }

  /** Есть плашки — показать; кончились — спрятать с паузой на дожитие анимации. */
  setActive(active: boolean): void {
    if (!this.isOpen) return;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;

    if (active) {
      if (!this.window!.isVisible()) this.window!.showInactive();
      return;
    }
    this.hideTimer = setTimeout(() => {
      if (this.isOpen && this.window!.isVisible()) this.window!.hide();
    }, 600);
  }

  setContentHeight(height: number): void {
    if (!this.isOpen) return;
    const target = Math.max(INITIAL_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(height)));
    const bounds = this.window!.getBounds();
    if (Math.abs(bounds.height - target) < 2) return;
    // Верхний край зафиксирован: стек плашек растёт вниз, к персонажу.
    this.window!.setBounds({ ...bounds, height: target });
  }

  send(channel: string, payload: unknown): void {
    if (this.isOpen) this.window?.webContents.send(channel, payload);
  }

  private position(): { x: number; y: number } {
    const overlayDisplayId = this.settings.overlay.placement?.displayId;
    const display =
      screen.getAllDisplays().find((d) => d.id === overlayDisplayId) ??
      screen.getPrimaryDisplay();
    const area = display.workArea;
    return {
      x: Math.round(area.x + (area.width - WIDTH) / 2),
      // Чуть выше середины: над персонажем, под полосой босса.
      y: Math.round(area.y + area.height * 0.3),
    };
  }
}
