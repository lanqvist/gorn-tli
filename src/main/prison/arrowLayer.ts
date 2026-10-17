import { BrowserWindow, type Display } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { PrisonHint, PrisonMark } from './protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Подсказка в координатах окна (DIP), как её рисует prison.html. */
export interface PrisonLayerHint {
  text: string;
  marks: PrisonMark[];
  live: boolean;
  phase: 'instant' | 'final';
  /** Где поставить текст: над верхней меткой. */
  anchor: number[];
}

/**
 * Окно со стрелками поверх игры.
 *
 * В отличие от оверлея, оно во весь монитор: стрелки тянутся через всю
 * доску. Полноэкранное прозрачное окно дорого для композиции, поэтому оно
 * показано, только пока есть подсказка, и спрятано всё остальное время.
 * Клики проходят насквозь всегда.
 */
export class ArrowLayer {
  private window: BrowserWindow | null = null;
  private ready = false;
  private pending: PrisonLayerHint | null = null;

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

    const win = this.ensure(display);
    win.setBounds(b);
    if (this.ready) {
      win.webContents.send('prison:hint', payload);
      if (!win.isVisible()) win.showInactive();
    } else this.pending = payload;
  }

  /** Совет подтвердился проигрыванием вариантов — тот же ход. */
  settle(live: boolean): void {
    if (this.ready && this.window?.isVisible()) this.window.webContents.send('prison:settled', live);
  }

  clear(): void {
    this.pending = null;
    if (!this.window || this.window.isDestroyed()) return;
    if (this.ready) this.window.webContents.send('prison:hint', null);
    this.window.hide();
  }

  destroy(): void {
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
    win.webContents.once('did-finish-load', () => {
      this.ready = true;
      if (this.pending) {
        win.webContents.send('prison:hint', this.pending);
        this.pending = null;
        win.showInactive();
      }
    });
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
