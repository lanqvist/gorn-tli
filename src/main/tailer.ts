import { closeSync, createReadStream, openSync, readSync, statSync, watch, type FSWatcher } from 'node:fs';
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
/** Позиция неизвестна: файл не удалось прочитать при старте. */
const UNKNOWN_POSITION = -1;

export interface TailerOptions {
  /** Начать с конца файла (обычный запуск) или с начала (первичный разбор). */
  fromStart?: boolean;
  /**
   * Явная стартовая позиция в байтах — то место, до которого файл уже
   * разобран ретро-сканом. Приоритетнее fromStart. Закрывает щель между
   * сканом и стартом дочитывания: строки, записанные игрой в этом окне,
   * иначе не достаются никому.
   */
  initialPosition?: number;
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
  /**
   * Старт с конца файла пришёлся на середину строки: её начало осталось
   * до стартовой позиции, и первый кусок до перевода строки — обрубок.
   * «Num = 1» от «Num = 151» дал бы фантомный прирост.
   */
  private skipPartial = false;

  constructor(
    private readonly path: string,
    private readonly options: TailerOptions,
  ) {}

  start(): void {
    this.stopped = false;
    if (this.options.initialPosition !== undefined) {
      this.position = this.options.initialPosition;
    } else {
      try {
        this.position = this.options.fromStart ? 0 : statSync(this.path).size;
        this.skipPartial = this.position > 0 && !this.endsWithNewline(this.position);
      } catch {
        // Файла ещё нет или он мгновение заблокирован. Раньше здесь ставился
        // ноль, и при живом файле первый же pump скармливал движку ВЕСЬ лог —
        // все забеги задваивались. Помечаем позицию неизвестной: pump выставит
        // её по первому успешному stat.
        this.position = UNKNOWN_POSITION;
      }
    }

    try {
      this.watcher = watch(this.path, { persistent: false }, () => {
        void this.pump();
      });
      // Без обработчика ошибка наблюдателя (файл удалён при ротации,
      // EPERM на Windows) роняла бы процесс. Опрос справится и один.
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
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

      if (this.position === UNKNOWN_POSITION) {
        // Первый успешный stat после неудачного старта. Сюда попадаем,
        // когда файла не существовало (движок передаёт initialPosition
        // всякий раз, когда лог был разобран сканом) — значит, игра
        // создала его только что, и это начало сессии: читаем целиком.
        this.position = 0;
      }

      // Файл стал меньше — игра ротировала лог и начала новый.
      if (size < this.position) {
        this.position = 0;
        this.carry = '';
        this.skipPartial = false;
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
        if (this.skipPartial && parts.length > 0) {
          parts.shift();
          this.skipPartial = false;
        }
        resolve(parts);
      });
      stream.on('error', reject);
    });
  }

  private decoder = new StringDecoder('utf8');

  /** Байт перед позицией — перевод строки, то есть позиция на границе строк. */
  private endsWithNewline(position: number): boolean {
    let fd: number | null = null;
    try {
      fd = openSync(this.path, 'r');
      const byte = Buffer.alloc(1);
      readSync(fd, byte, 0, 1, position - 1);
      return byte[0] === 0x0a;
    } catch {
      return true;
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  get currentPosition(): number {
    return this.position;
  }
}
