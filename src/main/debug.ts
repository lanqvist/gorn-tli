import type { BrowserWindow } from 'electron';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Snapshot } from './engine.js';

/**
 * Режим живой отладки: `--debug=<папка>`.
 *
 * Приложение продолжает работать, но пишет наружу всё, что нужно, чтобы
 * следить за ним со стороны: сжатый срез состояния на каждое обновление,
 * периодический снимок окна и сообщения из renderer.
 *
 * Нужен для проверки поведения во время реальной игры — того, что нельзя
 * увидеть ни в тестах, ни в браузере: реагирует ли темп на подбор,
 * правильно ли режутся забеги, что происходит при выходе в город.
 */
export class DebugSink {
  private snapshotsFile: string;
  private consoleFile: string;
  private shotFile: string;
  private timer: NodeJS.Timeout | null = null;
  private lastSignature = '';

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.snapshotsFile = join(dir, 'snapshots.jsonl');
    this.consoleFile = join(dir, 'console.log');
    this.shotFile = join(dir, 'latest.png');
    writeFileSync(this.snapshotsFile, '', 'utf8');
    writeFileSync(this.consoleFile, '', 'utf8');
  }

  attach(window: BrowserWindow): void {
    window.webContents.on('console-message', (...args: unknown[]) => {
      const detail = args.find((a) => typeof a === 'object' && a !== null && 'message' in a) as
        | { level?: unknown; message?: unknown }
        | undefined;
      if (!detail) return;
      this.line(this.consoleFile, `${detail.level}: ${String(detail.message)}`);
    });

    this.timer = setInterval(() => {
      if (window.isDestroyed()) return;
      void window.webContents
        .capturePage()
        .then((image) => writeFileSync(this.shotFile, image.toPNG()))
        .catch(() => {});
    }, 5000);
  }

  /**
   * Пишем только изменившиеся срезы: во время забега они приходят каждые
   * две секунды, и без фильтра файл превращается в шум, в котором
   * не видно момента подбора.
   */
  record(snapshot: Snapshot): void {
    const compact = {
      t: new Date().toISOString().slice(11, 19),
      статус: snapshot.status,
      подсказка: snapshot.hint,
      карта: snapshot.current?.name ?? null,
      секунд: snapshot.current
        ? Math.round((Date.now() - snapshot.current.startedAt) / 1000)
        : null,
      фе_в_забеге: snapshot.current?.feGained ?? null,
      чистыми_в_забеге: round(snapshot.current?.netFe),
      предметов: snapshot.current?.drops.length ?? 0,
      сейчас_в_час: round(snapshot.liveRate),
      медиана: round(snapshot.rate.median),
      забегов: snapshot.totals.runs,
      в_картах_с: Math.round(snapshot.totals.inMapMs / 1000),
      всего_фе: snapshot.totals.feGained,
      цен: snapshot.diagnostics.pricedItems,
      незнакомые: snapshot.diagnostics.unknownProtos,
    };

    // Подпись без времени: одинаковые подряд срезы не пишем.
    const { t: _t, секунд: _s, ...rest } = compact;
    const signature = JSON.stringify(rest);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    this.line(this.snapshotsFile, JSON.stringify(compact));
  }

  private line(file: string, text: string): void {
    try {
      appendFileSync(file, `${text}\n`, 'utf8');
    } catch {
      // Отладочная запись не должна ронять приложение.
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function round(value: number | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  return Math.round(value * 10) / 10;
}
