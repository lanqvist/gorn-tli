import { BrowserWindow, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Snapshot } from './engine.js';
import { SnapshotGate } from './snapshotGate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Вкладки пульта — те же имена, что в renderer (PanelApp). */
export type PanelTab = 'run' | 'session' | 'prices' | 'maps';

const WIDTH = 780;
const HEIGHT = 540;

/**
 * Пульт — второй слой оверлея, как в Awakened PoE Trade: открывается
 * клавишей поверх игры, принимает мышь и клавиатуру, закрывается по Esc,
 * клавише или клику в игру. Постоянный слой («Сводка») остаётся маленьким
 * и пропускает клики; всё, ради чего раньше уходили в главное окно, — здесь.
 *
 * В отличие от остальных окон Горна пульт фокусируемый: в него печатают.
 * Проверено вживую 19.10: TLI в режиме «окно без рамки на весь экран»
 * при этом не сворачивается, а после Esc снова слушается клавиатуры.
 * Эксклюзивный полноэкранный режим, как и для всего оверлея, не поддержан.
 *
 * Цена: окно непрозрачное (прозрачное во весь пульт — дорогой путь
 * композитора), создаётся при первом открытии и дальше только прячется.
 * Спрятанное окно не рисуется, снимки ему не шлются (SnapshotGate) —
 * при показе уходит последний.
 */
export class Panel {
  private window: BrowserWindow | null = null;
  private loaded = false;
  private pendingTab: PanelTab | null = null;
  private readonly snapshots = new SnapshotGate<Snapshot>(() =>
    this.window && !this.window.isDestroyed()
      ? {
          visible: () => this.window!.isVisible(),
          send: (s) => this.window!.webContents.send('snapshot', s),
        }
      : null,
  );

  constructor(private readonly fontScale: () => number) {}

  get isVisible(): boolean {
    return this.window !== null && !this.window.isDestroyed() && this.window.isVisible();
  }

  /** Открыть на вкладке; та же вкладка уже открыта — закрыть (клавиша работает как переключатель). */
  toggle(tab: PanelTab | null = null): void {
    if (this.isVisible && (tab === null || tab === this.shownTab)) {
      this.hide();
      return;
    }
    this.open(tab);
  }

  private shownTab: PanelTab | null = null;

  open(tab: PanelTab | null = null): void {
    const win = this.ensureWindow();
    const scale = this.fontScale();
    const width = Math.round(WIDTH * scale);
    const height = Math.round(HEIGHT * scale);
    // Справа по центру: слева и в центре — персонаж и бой, сверху справа — миникарта.
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    win.setBounds({
      x: Math.round(area.x + area.width - width - Math.max(24, area.width * 0.06)),
      y: Math.round(area.y + (area.height - height) / 2),
      width,
      height,
    });
    win.show();
    win.focus();
    win.webContents.focus();
    this.snapshots.shown();
    this.shownTab = tab;
    if (this.loaded) win.webContents.send('panel:open', { tab, scale });
    else this.pendingTab = tab;
  }

  hide(): void {
    if (!this.isVisible) return;
    this.window!.webContents.send('panel:hidden');
    this.window!.hide();
    this.shownTab = null;
  }

  /** Вкладку переключили в самом пульте — клавиша вкладки снова закроет её. */
  setTab(tab: PanelTab): void {
    this.shownTab = tab;
  }

  pushSnapshot(snapshot: Snapshot): void {
    this.snapshots.push(snapshot);
  }

  destroy(): void {
    this.window?.destroy();
    this.window = null;
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    this.loaded = false;
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      transparent: false,
      backgroundColor: '#141217',
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Клик в игру — пульт уходит, как окно цены в APT.
    win.on('blur', () => this.hide());
    win.on('closed', () => {
      this.window = null;
      this.loaded = false;
    });
    win.webContents.once('did-finish-load', () => {
      this.loaded = true;
      if (win.isVisible()) {
        this.snapshots.shown();
        win.webContents.send('panel:open', { tab: this.pendingTab, scale: this.fontScale() });
      }
      this.pendingTab = null;
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.window = win;
    void this.load(win);
    return win;
  }

  private async load(win: BrowserWindow): Promise<void> {
    const devServer = process.env['VITE_DEV_SERVER_URL'];
    if (devServer) await win.loadURL(new URL('panel.html', devServer).href);
    else await win.loadFile(join(__dirname, '../renderer/panel.html'));
  }
}
