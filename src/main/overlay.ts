import { BrowserWindow, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { OverlayMode, Settings, SettingsStore } from './settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Ширина окна под каждый режим. Высота не задаётся: её сообщает сам
 * интерфейс после отрисовки, потому что она зависит от количества
 * строк дропа и меняется по ходу забега.
 */
const WIDTHS: Record<OverlayMode, number> = {
  minimal: 250,
  compact: 290,
  full: 330,
};

/** Стартовая высота до первого замера — окно не должно мигать большим. */
const INITIAL_HEIGHT = 64;
const MAX_HEIGHT = 520;

/**
 * Срез настроек для окон оверлея и плашек: только то, что влияет
 * на отрисовку и звук, без позиции и служебных полей.
 */
export function prefsPayload(prefs: Settings['overlay']): {
  popups: boolean;
  sound: boolean;
  volume: number;
  divineFe: number;
  jackpotFe: number;
  exaltedFe: number;
  fontScale: number;
  goalFe: number;
} {
  return {
    popups: prefs.popups,
    sound: prefs.sound,
    volume: prefs.volume,
    divineFe: prefs.divineFe,
    jackpotFe: prefs.jackpotFe,
    exaltedFe: prefs.exaltedFe,
    fontScale: prefs.fontScale,
    goalFe: prefs.goalFe,
  };
}

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

  /** Зовётся при каждом открытии/закрытии — главное окно держит кнопку в актуальном виде. */
  onOpenChanged: ((open: boolean) => void) | null = null;

  constructor(private readonly settings: SettingsStore) {}

  get isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed();
  }

  open(): void {
    if (this.isOpen) {
      this.window?.showInactive();
      return;
    }

    // Первое включение — открепленным: у закреплённого оверлея нет ни одного
    // видимого органа управления, и игрок не узнал бы ни про перетаскивание,
    // ни про режимы. Дальше — как оставил игрок.
    if (!this.settings.overlay.introShown) {
      this.settings.patchOverlay({ locked: false, introShown: true });
    }

    const prefs = this.settings.overlay;
    const size = {
      width: Math.round(WIDTHS[prefs.mode] * prefs.fontScale),
      height: INITIAL_HEIGHT,
    };
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
      this.onOpenChanged?.(false);
    });

    void this.load();
    this.settings.patchOverlay({ enabled: true });
    this.onOpenChanged?.(true);
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

  /**
   * persist=false — закрытие при выходе из приложения: настройка
   * «оверлей включён» должна пережить перезапуск.
   */
  close(persist = true): void {
    this.window?.close();
    this.window = null;
    if (persist) this.settings.patchOverlay({ enabled: false });
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
    if (bounds) {
      const width = Math.round(WIDTHS[mode] * this.settings.overlay.fontScale);
      this.window?.setBounds(this.keepOnScreen({ ...bounds, width }));
    }
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
    this.window!.setBounds(this.keepOnScreen({ ...bounds, height: target }));
  }

  /**
   * Не даёт окну вылезти за рабочую область при росте высоты или ширины:
   * позиция восстанавливалась со стартовой высотой 64px, и подросшее окно
   * могло свеситься за нижний край экрана.
   */
  private keepOnScreen(bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): { x: number; y: number; width: number; height: number } {
    const area = screen.getDisplayMatching(bounds).workArea;
    return {
      ...bounds,
      x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width),
      y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height),
    };
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

  /** Настройки всплывашек, звука и масштаба. Оверлей узнаёт об изменении сразу. */
  patchPrefs(patch: {
    popups?: boolean;
    sound?: boolean;
    volume?: number;
    divineFe?: number;
    jackpotFe?: number;
    exaltedFe?: number;
    fontScale?: number;
    goalFe?: number;
  }): void {
    const clean = { ...patch };
    if (clean.volume !== undefined) {
      clean.volume = Math.min(1, Math.max(0, clean.volume));
    }
    if (clean.goalFe !== undefined) {
      clean.goalFe = Math.max(0, Math.round(clean.goalFe));
    }
    if (clean.jackpotFe !== undefined) {
      // 0 — «авто»: порог берётся из снапшота (P95 цен сезона).
      clean.jackpotFe = Math.max(0, clean.jackpotFe);
    }
    if (clean.exaltedFe !== undefined) {
      // 0 — звук «возвышение» выключен.
      clean.exaltedFe = Math.max(0, clean.exaltedFe);
    }
    if (clean.divineFe !== undefined) {
      // 0 — звук «дивайн» выключен.
      clean.divineFe = Math.max(0, clean.divineFe);
    }
    if (clean.fontScale !== undefined) {
      clean.fontScale = Math.min(1.6, Math.max(0.8, clean.fontScale));
    }
    const prefs = this.settings.patchOverlay(clean);
    if (clean.fontScale !== undefined) this.applyFontScale();
    this.send('overlay:prefs', prefsPayload(prefs));
  }

  /**
   * Масштаб рисуется через zoom в renderer, поэтому окну нужна
   * пропорциональная ширина — иначе контент вылезет за прозрачный край.
   */
  private applyFontScale(): void {
    const prefs = this.settings.overlay;
    const bounds = this.window?.getBounds();
    if (bounds) {
      this.window?.setBounds(
        this.keepOnScreen({ ...bounds, width: Math.round(WIDTHS[prefs.mode] * prefs.fontScale) }),
      );
    }
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
