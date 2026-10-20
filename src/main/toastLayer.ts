import { BrowserWindow, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Snapshot } from './engine.js';
import type { SettingsStore } from './settings.js';
import { ToastFeed } from './toastFeed.js';

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
 *    стек растёт ВВЕРХ от закреплённой нижней кромки: вниз расти нельзя,
 *    три плашки доставали бы до персонажа в бою;
 *  - окно скрыто, пока показывать нечего: прозрачная площадь стоит
 *    композитору дорого, а слой большую часть времени пуст.
 *
 * Монитор берётся тот же, где стоит оверлей-панель (обычно это монитор
 * с игрой), иначе — основной.
 */
export class ToastLayer {
  private window: BrowserWindow | null = null;
  private hideTimer: NodeJS.Timeout | null = null;
  /** Экранная координата нижней кромки — от неё стек растёт вверх. */
  private anchorBottom = 0;
  /** Урезанный срез и отсев неизменившихся. */
  private readonly feed = new ToastFeed();

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
    this.feed.reset();

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
    // Нижняя кромка зафиксирована: окно растёт вверх, от персонажа.
    this.window!.setBounds({ ...bounds, y: this.anchorBottom - target, height: target });
  }

  /** Срез движка — урезанным и только если для плашек что-то изменилось. */
  sendSnapshot(snapshot: Snapshot): void {
    if (!this.isOpen) return;
    const slim = this.feed.next(snapshot);
    if (slim) this.window?.webContents.send('snapshot', slim);
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
    // Кромка чуть выше середины: одиночная плашка стоит над персонажем,
    // а полный стек уходит вверх, не доставая до полосы босса.
    this.anchorBottom = Math.round(area.y + area.height * 0.36);
    return {
      x: Math.round(area.x + (area.width - WIDTH) / 2),
      y: this.anchorBottom - INITIAL_HEIGHT,
    };
  }
}
