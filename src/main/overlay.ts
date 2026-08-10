import { BrowserWindow, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { OverlayMode, SettingsStore } from './settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Ширина окна под каждый режим. Высота не задаётся: её сообщает сам
 * интерфейс после отрисовки, потому что она зависит от количества
 * строк дропа и меняется по ходу забега.
 */
const WIDTHS: Record<OverlayMode, number> = {
  minimal: 250,
  compact: 320,
  full: 380,
};

/** Стартовая высота до первого замера — окно не должно мигать большим. */
const INITIAL_HEIGHT = 64;
const MAX_HEIGHT = 520;

/**
 * Оверлей поверх игры.
 *
 * Три решения, продиктованные тем, как Electron ведёт себя на Windows:
 *
 * 1. Окно маленькое, ровно по содержимому. Полноэкранное прозрачное окно
 *    заставляет DirectComposition идти по дорогому пути с premultiplied alpha
 *    и способно уронить fps игры в разы — при том что рисуем мы пару строк.
 *
 * 2. Клики пропускаются сквозь окно целиком. Частичной прозрачности для
 *    кликов в Electron нет: setIgnoreMouseEvents работает на всё окно.
 *    Поэтому режим «разблокирован» временно включает приём кликов целиком.
 *
 * 3. focusable: false — клик по оверлею не должен забирать фокус у игры,
 *    иначе игра в безрамочном режиме может свернуться.
 *
 * Перекрыть эксклюзивный полноэкранный режим нельзя ничем: он минует
 * оконный композитор. Игре нужен borderless / оконный полноэкранный.
 */
export class Overlay {
  private window: BrowserWindow | null = null;

  constructor(private readonly settings: SettingsStore) {}

  get isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed();
  }

  open(): void {
    if (this.isOpen) {
      this.window?.showInactive();
      return;
    }

    const prefs = this.settings.overlay;
    const size = { width: WIDTHS[prefs.mode], height: INITIAL_HEIGHT };
    const position = this.restorePosition(size);

    this.window = new BrowserWindow({
      ...size,
      ...position,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      // Создаём скрытым и показываем после отрисовки: прозрачные окна
      // иначе мигают белым при появлении.
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        // Оверлей не должен «замерзать», когда игра в фокусе.
        backgroundThrottling: false,
      },
    });

    // 'screen-saver' — практический потолок: выше держатся только
    // системные элементы вроде экранной клавиатуры.
    this.window.setAlwaysOnTop(true, 'screen-saver');
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.applyClickThrough(prefs.locked);
    this.window.setOpacity(prefs.opacity);

    this.window.once('ready-to-show', () => this.window?.showInactive());
    this.window.on('moved', () => this.rememberPosition());
    this.window.on('closed', () => {
      this.window = null;
    });

    void this.load();
    this.settings.patchOverlay({ enabled: true });
  }

  private async load(): Promise<void> {
    if (!this.window) return;
    const devServer = process.env['VITE_DEV_SERVER_URL'];
    if (devServer) {
      await this.window.loadURL(new URL('overlay.html', devServer).href);
    } else {
      await this.window.loadFile(join(__dirname, '../renderer/overlay.html'));
    }
  }

  close(): void {
    this.window?.close();
    this.window = null;
    this.settings.patchOverlay({ enabled: false });
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Заблокирован — клики уходят в игру. Разблокирован — можно двигать. */
  setLocked(locked: boolean): boolean {
    this.settings.patchOverlay({ locked });
    this.applyClickThrough(locked);
    this.send('overlay:locked', locked);
    return locked;
  }

  toggleLocked(): boolean {
    return this.setLocked(!this.settings.overlay.locked);
  }

  setMode(mode: OverlayMode): void {
    this.settings.patchOverlay({ mode });
    // Ширину задаём сразу, высоту пришлёт интерфейс после перерисовки.
    const bounds = this.window?.getBounds();
    if (bounds) this.window?.setBounds({ ...bounds, width: WIDTHS[mode] });
    this.send('overlay:mode', mode);
  }

  /**
   * Подгоняет высоту окна под содержимое.
   *
   * Прозрачное окно стоит композитору дорого, поэтому лишней прозрачной
   * площади быть не должно: держим окно ровно по тому, что нарисовано.
   */
  setContentHeight(height: number): void {
    if (!this.isOpen) return;
    const target = Math.max(INITIAL_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(height)));
    const bounds = this.window!.getBounds();
    if (Math.abs(bounds.height - target) < 2) return;
    this.window!.setBounds({ ...bounds, height: target });
  }

  cycleMode(): OverlayMode {
    const order: OverlayMode[] = ['minimal', 'compact', 'full'];
    const next = order[(order.indexOf(this.settings.overlay.mode) + 1) % order.length]!;
    this.setMode(next);
    return next;
  }

  setOpacity(opacity: number): void {
    const clamped = Math.min(1, Math.max(0.25, opacity));
    this.settings.patchOverlay({ opacity: clamped });
    this.window?.setOpacity(clamped);
  }

  send(channel: string, payload: unknown): void {
    if (this.isOpen) this.window?.webContents.send(channel, payload);
  }

  private applyClickThrough(locked: boolean): void {
    // forward: true оставляет наведение работающим — окно продолжает
    // получать mousemove, хотя клики уходят насквозь.
    this.window?.setIgnoreMouseEvents(locked, { forward: true });
  }

  private currentPosition(): { x: number; y: number } {
    const bounds = this.window?.getBounds();
    return { x: bounds?.x ?? 0, y: bounds?.y ?? 0 };
  }

  private rememberPosition(): void {
    if (!this.window) return;
    const bounds = this.window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    this.settings.patchOverlay({
      placement: { x: bounds.x, y: bounds.y, displayId: display.id },
    });
  }

  /**
   * Восстанавливает позицию с оглядкой на текущие мониторы.
   *
   * Если монитор, на котором окно стояло, отключили, оверлей уехал бы
   * за пределы видимой области и его было бы не достать. Поэтому позиция
   * всегда подрезается по рабочей области существующего экрана.
   */
  private restorePosition(size: { width: number; height: number }): { x: number; y: number } {
    const saved = this.settings.overlay.placement;
    const displays = screen.getAllDisplays();
    const display =
      displays.find((d) => d.id === saved?.displayId) ?? screen.getPrimaryDisplay();
    const area = display.workArea;

    if (!saved) {
      // По умолчанию — правый верхний угол, там меньше всего игрового HUD.
      return { x: area.x + area.width - size.width - 24, y: area.y + 24 };
    }

    return {
      x: Math.min(Math.max(saved.x, area.x), area.x + area.width - size.width),
      y: Math.min(Math.max(saved.y, area.y), area.y + area.height - size.height),
    };
  }
}
