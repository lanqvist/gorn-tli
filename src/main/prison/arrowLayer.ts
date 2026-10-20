import { BrowserWindow, ipcMain, type Display } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { PrisonHint, PrisonMark } from './protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * «Смотрю…» без подсказки дольше этого — убрать. Самый долгий путь кадра
 * (ожидание потока, переоткрытие, толчки, снимок, расчёт, два повтора) — ~12 с.
 */
const THINKING_MAX_MS = 20_000;

/** Подсказка в координатах окна (DIP), как её рисует prison.html. */
export interface PrisonLayerHint {
  text: string;
  marks: PrisonMark[];
  live: boolean;
  phase: 'instant' | 'final';
  /** Где поставить текст: над верхней меткой. */
  anchor: number[];
  /** Ход сделан, новая подсказка считается: показать «смотрю…». */
  thinking?: boolean;
}

/**
 * Окно со стрелками поверх игры.
 *
 * В отличие от оверлея, оно во весь монитор: стрелки тянутся через всю
 * доску. Полноэкранное прозрачное окно дорого для композиции, поэтому оно
 * показано, только пока есть подсказка или «смотрю…», и спрятано всё
 * остальное время. Клики проходят насквозь всегда.
 */
export class ArrowLayer {
  private window: BrowserWindow | null = null;
  private ready = false;
  private pending: PrisonLayerHint | null = null;
  private thinkTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Готовность сообщает сама страница, когда подписалась на подсказки:
    // загрузка HTML раньше — React ещё не смонтирован, и первая подсказка
    // терялась, окно показывалось пустым.
    ipcMain.on('prison:ready', (e) => {
      const win = this.window;
      if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
      this.ready = true;
      if (this.pending) {
        win.webContents.send('prison:hint', this.pending);
        this.pending = null;
        win.showInactive();
      }
    });
  }

  show(display: Display, hint: PrisonHint & { phase: 'instant' | 'final' }): void {
    const b = display.bounds;
    const sx = b.width / hint.frame.w;
    const sy = b.height / hint.frame.h;
    const pt = (p: number[]) => [p[0]! * sx, p[1]! * sy];
    const marks: PrisonMark[] = hint.marks.map((m) =>
      m.kind === 'arrow'
        ? { kind: 'arrow', from: pt(m.from), to: pt(m.to) }
        : m.kind === 'ring'
          ? { kind: 'ring', at: pt(m.at), r: m.r * sx }
          : { kind: 'box', box: [...pt(m.box.slice(0, 2)), ...pt(m.box.slice(2, 4))] },
    );
    const ys = marks.map((m) => (m.kind === 'arrow' ? Math.min(m.from[1]!, m.to[1]!) : m.kind === 'ring' ? m.at[1]! - m.r : m.box[1]!));
    const xs = marks.map((m) => (m.kind === 'arrow' ? m.to[0]! : m.kind === 'ring' ? m.at[0]! : (m.box[0]! + m.box[2]!) / 2));
    const anchor = marks.length ? [xs[0]!, Math.max(40, Math.min(...ys) - 18)] : [b.width / 2, b.height * 0.12];
    const payload: PrisonLayerHint = { text: hint.text, marks, live: hint.live, phase: hint.phase, anchor };

    this.present(display, payload);
  }

  /**
   * Ход сделан, новая подсказка в пути: убрать стрелки и показать
   * «смотрю…». Окно на экране ещё и заставляет Windows пересобирать экран:
   * пока поверх игры ничего нет, она выводит картинку мимо композиции и
   * поток экрана замерзает на старом кадре. В сам захват окно не попадает.
   */
  thinking(display: Display): void {
    const b = display.bounds;
    this.present(display, { text: '', marks: [], live: false, phase: 'instant', anchor: [b.width / 2, b.height * 0.1], thinking: true });
    // Не каждый клик ведёт к кадру (карта, переход в камеру): без подсказки
    // «смотрю…» висел бы во весь монитор с вечным спиннером, а окно поверх
    // игры заставляет Windows пересобирать экран.
    this.thinkTimer = setTimeout(() => this.clear(), THINKING_MAX_MS);
  }

  private present(display: Display, payload: PrisonLayerHint): void {
    if (this.thinkTimer) clearTimeout(this.thinkTimer);
    this.thinkTimer = null;
    const win = this.ensure(display);
    const b = display.bounds;
    const cur = win.getBounds();
    if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) win.setBounds(b);
    if (this.ready) {
      win.webContents.send('prison:hint', payload);
      if (!win.isVisible()) win.showInactive();
    } else this.pending = payload;
  }

  /**
   * Поток застыл: игра снова выводит картинку мимо композиции, хотя окно
   * уже видно. Заново показанное окно поверх игры возвращает композицию.
   */
  nudge(display: Display): void {
    const win = this.window;
    if (!win || win.isDestroyed() || !this.ready) {
      this.thinking(display);
      return;
    }
    if (win.isVisible()) win.hide();
    win.showInactive();
  }

  /** Совет подтвердился проигрыванием вариантов — тот же ход. */
  settle(live: boolean): void {
    if (this.ready && this.window?.isVisible()) this.window.webContents.send('prison:settled', live);
  }

  /** Убрать подсказку и спрятать окно. */
  clear(): void {
    if (this.thinkTimer) clearTimeout(this.thinkTimer);
    this.thinkTimer = null;
    this.pending = null;
    if (!this.window || this.window.isDestroyed()) return;
    if (this.ready) this.window.webContents.send('prison:hint', null);
    this.window.hide();
  }

  destroy(): void {
    if (this.thinkTimer) clearTimeout(this.thinkTimer);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  private ensure(display: Display): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    this.ready = false;
    const win = new BrowserWindow({
      ...display.bounds,
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
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true);
    // Не попадать в собственный захват экрана: на Windows 10 2004+ это
    // WDA_EXCLUDEFROMCAPTURE — окно просто вырезается из снимка. Иначе
    // стрелки, не успевшие спрятаться, читались как часть доски.
    win.setContentProtection(true);
    win.on('closed', () => {
      this.window = null;
      this.ready = false;
    });
    const devServer = process.env['VITE_DEV_SERVER_URL'];
    if (devServer) void win.loadURL(new URL('prison.html', devServer).href);
    else void win.loadFile(join(__dirname, '../renderer/prison.html'));
    this.window = win;
    return win;
  }
}
