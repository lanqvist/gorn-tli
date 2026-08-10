import { createReadStream, statSync, watch, type FSWatcher } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/**
 * Дочитывание лога в реальном времени.
 *
 * Особенности, которые приходится учитывать на Windows:
 *
 *  - fs.watch на этом файле срабатывает нерегулярно, потому что игра пишет
 *    через буферизованный поток. Поэтому watch дополнен опросом размера.
 *  - Игра ротирует лог: UE_game.log переименовывается в бэкап и создаётся
 *    заново. Уменьшение размера файла — признак ротации, читаем с нуля.
 *  - За одну карту в лог падает несколько мегабайт, поэтому читаем порциями
 *    и не держим весь файл в памяти.
 */

const POLL_INTERVAL_MS = 300;
/** Максимум за один проход, чтобы не блокировать процесс на гигабайтном логе. */
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

export interface TailerOptions {
  /** Начать с конца файла (обычный запуск) или с начала (первичный разбор). */
  fromStart?: boolean;
  onLines: (lines: string[]) => void;
  onRotate?: () => void;
  onError?: (err: Error) => void;
}

export class LogTailer {
  private position = 0;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private reading = false;
  private stopped = false;
  /** Хвост неполной строки, дописанной игрой не до конца. */
  private carry = '';

  constructor(
    private readonly path: string,
    private readonly options: TailerOptions,
  ) {}

  start(): void {
    this.stopped = false;
    try {
      this.position = this.options.fromStart ? 0 : statSync(this.path).size;
    } catch {
      this.position = 0;
    }

    try {
      this.watcher = watch(this.path, { persistent: false }, () => {
        void this.pump();
      });
    } catch {
      // Файла может не быть, пока игра не запущена — работаем на опросе.
    }

    this.timer = setInterval(() => void this.pump(), POLL_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async pump(): Promise<void> {
    if (this.reading || this.stopped) return;
    this.reading = true;
    try {
      let size: number;
      try {
        size = statSync(this.path).size;
      } catch {
        return; // игра ещё не создала файл
      }

      // Файл стал меньше — игра ротировала лог и начала новый.
      if (size < this.position) {
        this.position = 0;
        this.carry = '';
        this.decoder = new StringDecoder('utf8');
        this.options.onRotate?.();
      }

      if (size <= this.position) return;

      const end = Math.min(size, this.position + MAX_CHUNK_BYTES);
      const lines = await this.readRange(this.position, end);
      this.position = end;
      if (lines.length > 0) this.options.onLines(lines);
    } catch (err) {
      this.options.onError?.(err as Error);
    } finally {
      this.reading = false;
    }
  }

  /**
   * Читает диапазон байт и режет на строки.
   *
   * Порция может оборваться и посреди строки, и посреди многобайтового
   * символа UTF-8. StringDecoder держит незавершённый символ у себя,
   * а незавершённая строка переносится в carry до следующего прохода.
   */
  private readRange(start: number, end: number): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const stream = createReadStream(this.path, { start, end: end - 1 });
      let text = '';

      stream.on('data', (chunk) => {
        text += this.decoder.write(chunk as Buffer);
      });
      stream.on('end', () => {
        const parts = (this.carry + text).split(/\r?\n/);
        // Последний элемент — это либо пустая строка после финального
        // перевода строки, либо недописанная строка. И то и другое ждёт.
        this.carry = parts.pop() ?? '';
        resolve(parts);
      });
      stream.on('error', reject);
    });
  }

  private decoder = new StringDecoder('utf8');

  get currentPosition(): number {
    return this.position;
  }
}
