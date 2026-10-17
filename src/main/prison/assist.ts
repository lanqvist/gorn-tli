import { desktopCapturer, screen, type Display } from 'electron';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { PrisonTriggers, type PrisonShot } from '../../core/prisonTriggers.js';
import { ArrowLayer } from './arrowLayer.js';
import type { PrisonShotMessage, PrisonWorkerReply } from './protocol.js';

/** Заголовок окна игры (и у русского клиента тоже). */
const GAME_TITLE = /torchlight/i;
/** Сколько решатель проигрывает варианты после мгновенного совета. */
const SOLVE_BUDGET_MS = 2500;
/** Подсказка без новых кадров дольше этого — устарела, прячем. */
const STALE_MS = 120_000;

/**
 * Подсказки в сезонной тюрьме.
 *
 * Строки лога → (PrisonTriggers) → снимок окна игры → поток распознавания
 * и расчёта хода → стрелки поверх игры. Снимается окно игры, а не экран:
 * так наши же стрелки не попадают в кадр.
 *
 * Ограничение: игра в режиме «окно без рамки» на весь монитор. Положение
 * окна игры не узнать без вызовов Win32, поэтому считается, что оно
 * занимает весь монитор, на котором сейчас курсор.
 */
export class PrisonAssist {
  private worker: Worker | null = null;
  private readonly layer = new ArrowLayer();
  private readonly triggers = new PrisonTriggers((shot) => void this.capture(shot));
  private enabled = false;
  private nextId = 0;
  /** Кадр в работе у потока и ждущий своей очереди (только последний). */
  private busy = 0;
  private queued: PrisonShotMessage | null = null;
  private display: Display | null = null;
  private staleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly dirs: { worker: string; vendor: string }) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) {
      this.triggers.cancel();
      this.layer.clear();
      void this.worker?.terminate();
      this.worker = null;
      this.busy = 0;
      this.queued = null;
    }
  }

  /** Сырые строки лога от движка. */
  onLines(lines: readonly string[]): void {
    if (this.enabled) this.triggers.feed(lines);
  }

  /** Снять кадр сейчас (хоткей): экран определится по картинке. */
  captureNow(): void {
    if (!this.enabled) return;
    void this.capture({ kind: 'board', fresh: false, after: '', treasureView: false, lines: [] }, true);
  }

  dispose(): void {
    this.setEnabled(false);
    this.layer.destroy();
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (!existsSync(this.dirs.worker) || !existsSync(join(this.dirs.vendor, 'advisor.js'))) {
      console.warn('[тюрьма] нет потока или кода симулятора:', this.dirs.worker, this.dirs.vendor);
      return null;
    }
    const w = new Worker(this.dirs.worker, { workerData: { vendorDir: this.dirs.vendor } });
    w.on('message', (msg: PrisonWorkerReply) => this.onReply(msg));
    w.on('error', (err: Error) => {
      console.error('[тюрьма] поток упал:', err.message);
      this.worker = null;
      this.busy = 0;
    });
    this.worker = w;
    return w;
  }

  private async capture(shot: PrisonShot, manual = false): Promise<void> {
    if (!this.enabled) return;
    // Экран сменился: старая подсказка больше не про него.
    this.layer.clear();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const size = {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    };
    let sources: Electron.DesktopCapturerSource[];
    try {
      sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: size, fetchWindowIcons: false });
    } catch (err) {
      console.warn('[тюрьма] снимок не удался:', err instanceof Error ? err.message : err);
      return;
    }
    const game = sources.find((s) => GAME_TITLE.test(s.name));
    if (!game || game.thumbnail.isEmpty()) return;
    const { width, height } = game.thumbnail.getSize();
    const bitmap = game.thumbnail.toBitmap();
    // Своя копия пикселей: её можно передать потоку без копирования.
    const buffer = new Uint8Array(bitmap).buffer as ArrayBuffer;
    this.display = display;
    const msg: PrisonShotMessage = {
      type: 'shot',
      id: ++this.nextId,
      kind: manual ? 'manual' : shot.kind,
      fresh: shot.fresh,
      after: shot.after,
      treasureView: shot.treasureView,
      width,
      height,
      buffer,
      budgetMs: SOLVE_BUDGET_MS,
    };
    if (this.busy) this.queued = msg;
    else this.send(msg);
  }

  private send(msg: PrisonShotMessage): void {
    const w = this.ensureWorker();
    if (!w) return;
    this.busy = msg.id;
    w.postMessage(msg, [msg.buffer]);
  }

  private onReply(msg: PrisonWorkerReply): void {
    const done = msg.type !== 'hint' || msg.phase === 'final';
    // Ответ на кадр, который уже сменился новым, не показываем.
    const current = !this.queued && msg.id === this.nextId;
    if (current && this.display) {
      if (msg.type === 'hint') {
        this.layer.show(this.display, msg);
        this.armStale();
      } else if (msg.type === 'settled') this.layer.settle(msg.live);
      else if (msg.type === 'clear') this.layer.clear();
      else if (msg.type === 'error') console.error('[тюрьма] ошибка разбора кадра:', msg.message);
    }
    if (done && msg.id === this.busy) {
      this.busy = 0;
      const next = this.queued;
      this.queued = null;
      if (next) this.send(next);
    }
  }

  private armStale(): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => this.layer.clear(), STALE_MS);
  }
}
