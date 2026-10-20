/**
 * Пул потоков решателя: раунды Монте-Карло одного поиска делятся между
 * потоками процесса подсказок (worker_threads).
 *
 * Раунд — чистая функция (позиция, зерно, номер раунда, ход): кости общие
 * по (раунд, день, фаза, номер решения), поэтому неважно, какой поток его
 * сыграл. Номер раунда поток берёт из общего счётчика (Atomics.add), счёт
 * кандидатов кладёт в ячейку кольца по номеру. Главный поток играет вместе
 * со всеми и сливает раунды строго по порядку номеров: суммы, квадраты,
 * парные произведения, отсечение и остановка — те же, что в одном потоке,
 * и при том же числе раундов оценки совпадают до бита. Раунды, сыгранные
 * за отсечённого кандидата или после остановки, просто не сливаются.
 *
 * Потоки считают только внутри step(ms): в конце шага главный опускает
 * флаг, ждёт, пока каждый доиграет начатый раунд, и сливает всё готовое.
 * Между шагами (и между кадрами) пул спит в Atomics.wait и процессора не
 * берёт. Отмена новым кадром и досчёт — как в одном потоке: их делает
 * вызывающий между шагами.
 *
 * Синхронно: step остаётся обычным вызовом, ждут через Atomics.wait —
 * в Node его можно и в главном потоке.
 */
import { availableParallelism, getPriority } from 'node:os';
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads';

import type { Params } from '../model.js';

/** Потолок потоков по умолчанию: игре — остальные ядра. */
export const MAX_SOLVE_THREADS = 4;

/** Потоков решателя по умолчанию: ядра − 2 (игра и интерфейс), от 1 до MAX_SOLVE_THREADS. */
export function defaultSolveThreads(cores = availableParallelism()): number {
  return Math.min(MAX_SOLVE_THREADS, Math.max(1, cores - 2));
}

// ── общая память поиска ─────────────────────────────────────────────────────

/** Раундов в кольце: столько может быть сыграно, но ещё не слито. */
export const RING = 512;

/** Поля заголовка (Int32). */
const NEXT = 0;
const MERGED = 1;
const MAXR = 2;
const HDR = 4;

/**
 * Память одного поиска, общая для потоков: счётчик раундов, сколько слито,
 * живые кандидаты, кольцо счётов по номеру раунда.
 */
export class RoundRing {
  readonly hdr: Int32Array;
  readonly active: Int32Array;
  /** ready[r % RING] = r + 1 — раунд r записан. */
  readonly ready: Int32Array;
  readonly vals: Float64Array;

  constructor(readonly k: number, readonly sab = new SharedArrayBuffer(RoundRing.bytes(k))) {
    this.hdr = new Int32Array(sab, 0, HDR);
    this.active = new Int32Array(sab, HDR * 4, k);
    this.ready = new Int32Array(sab, (HDR + k) * 4, RING);
    this.vals = new Float64Array(sab, RoundRing.valsAt(k), RING * k);
  }

  private static valsAt(k: number): number {
    return Math.ceil(((HDR + k + RING) * 4) / 8) * 8;
  }

  static bytes(k: number): number {
    return RoundRing.valsAt(k) + RING * k * 8;
  }

  /** Ячейка счёта раунда r. */
  slot(r: number): Float64Array {
    const at = (r % RING) * this.k;
    return this.vals.subarray(at, at + this.k);
  }

  claim(): number {
    return Atomics.add(this.hdr, NEXT, 1);
  }

  publish(r: number): void {
    Atomics.store(this.ready, r % RING, r + 1);
  }

  isReady(r: number): boolean {
    return Atomics.load(this.ready, r % RING) === r + 1;
  }

  merged(): number {
    return Atomics.load(this.hdr, MERGED);
  }

  setMerged(n: number): void {
    Atomics.store(this.hdr, MERGED, n);
    Atomics.notify(this.hdr, MERGED);
  }

  maxRounds(): number {
    return Atomics.load(this.hdr, MAXR);
  }

  /** Начало шага: раздача номеров — с первого неслитого. */
  reset(n: number, active: Uint8Array, maxRounds: number): void {
    for (let i = 0; i < this.k; i++) Atomics.store(this.active, i, active[i]!);
    Atomics.store(this.hdr, MAXR, Math.min(maxRounds, 0x7fffffff));
    Atomics.store(this.hdr, MERGED, n);
    Atomics.store(this.hdr, NEXT, n);
  }

  /** Ждать, пока раунд r влезет в кольцо (сыгранные не перетираются). */
  waitRoom(r: number, live: () => boolean): boolean {
    for (;;) {
      const m = Atomics.load(this.hdr, MERGED);
      if (r - m < RING) return true;
      if (!live()) return false;
      Atomics.wait(this.hdr, MERGED, m, 2);
    }
  }
}

/** Что поток получает о поиске: из этого он сам строит раунды. */
export interface JobDef {
  type: 'job';
  id: number;
  sab: SharedArrayBuffer;
  k: number;
  root: Int32Array;
  codes: Int32Array;
  seed: number;
  knownEvents: boolean;
  params: Params;
  weights: Float64Array;
}

// ── управление пулом ────────────────────────────────────────────────────────

/** Поля управления (Int32): эпоха шага, идёт ли шаг, чей поиск, сколько потоков в шаге, выход, счёт раундов. */
export const C_EPOCH = 0;
export const C_RUN = 1;
export const C_JOB = 2;
export const C_BUSY = 3;
export const C_QUIT = 4;
/** Раундов, сыгранных потоками пула (не главным), — для замеров. */
export const C_PLAYED = 5;
const C_SIZE = 8;

/** Столько ждать, пока потоки доиграют начатые раунды; дольше — поток завис, пул выключается. */
const DRAIN_LIMIT_MS = 2000;

export interface PoolOptions {
  /** Всего потоков вместе с главным (1 — без пула). */
  threads: number;
  /** Файл потока: собранный poolWorker (в приложении) или .ts под tsx. */
  entry: string | URL;
  execArgv?: string[];
}

export class SolvePool {
  readonly ctl = new Int32Array(new SharedArrayBuffer(C_SIZE * 4));
  private readonly workers: Worker[] = [];
  private readonly ports: MessagePort[] = [];
  private posted = -1;
  private broken = false;

  constructor(opts: PoolOptions) {
    let priority = 0;
    try {
      priority = getPriority();
    } catch {
      // без прав — потоки с приоритетом по умолчанию
    }
    for (let t = 1; t < opts.threads; t++) {
      const { port1, port2 } = new MessageChannel();
      const w = new Worker(opts.entry, {
        workerData: { ctl: this.ctl, port: port2, priority },
        transferList: [port2],
        ...(opts.execArgv ? { execArgv: opts.execArgv } : {}),
      });
      w.unref();
      w.on('error', (err) => {
        console.warn('[тюрьма] поток решателя упал:', err instanceof Error ? err.message : err);
        this.broken = true;
      });
      this.workers.push(w);
      this.ports.push(port1);
    }
  }

  /** Потоков вместе с главным. */
  get threads(): number {
    return this.workers.length + 1;
  }

  /** Раундов, сыгранных потоками пула с запуска. */
  get workerRounds(): number {
    return Atomics.load(this.ctl, C_PLAYED);
  }

  get usable(): boolean {
    return !this.broken && this.workers.length > 0;
  }

  /** Начать шаг поиска id: потоки берут его раунды, пока не stop(). */
  begin(id: number, def: () => JobDef): void {
    if (this.posted !== id) {
      const d = def();
      for (const p of this.ports) p.postMessage(d);
      this.posted = id;
    }
    Atomics.store(this.ctl, C_JOB, id);
    Atomics.store(this.ctl, C_RUN, 1);
    Atomics.add(this.ctl, C_EPOCH, 1);
    Atomics.notify(this.ctl, C_EPOCH);
  }

  /** Потокам больше не брать раундов (начатые доиграют). */
  stop(): void {
    Atomics.store(this.ctl, C_RUN, 0);
  }

  /**
   * Конец шага: дождаться, пока потоки доиграют начатые раунды, сливая
   * готовое (иначе поток, упёршийся в кольцо, ждал бы вечно).
   */
  end(drain: () => void): void {
    this.stop();
    const limit = performance.now() + DRAIN_LIMIT_MS;
    for (;;) {
      const busy = Atomics.load(this.ctl, C_BUSY);
      if (busy === 0) break;
      drain();
      if (performance.now() > limit) {
        console.warn('[тюрьма] потоки решателя не ответили — считаю в одном');
        this.broken = true;
        this.close();
        break;
      }
      Atomics.wait(this.ctl, C_BUSY, busy, 1);
    }
  }

  close(): void {
    Atomics.store(this.ctl, C_QUIT, 1);
    Atomics.add(this.ctl, C_EPOCH, 1);
    Atomics.notify(this.ctl, C_EPOCH);
    for (const p of this.ports) p.close();
    for (const w of this.workers) void w.terminate();
    this.workers.length = 0;
    this.ports.length = 0;
  }
}

let pool: SolvePool | null = null;

/** Пул решателя (null — считать в одном потоке). */
export function solvePool(): SolvePool | null {
  return pool?.usable ? pool : null;
}

/** Запустить пул на threads потоков (1 — выключить). Ошибка запуска — остаёмся в одном потоке. */
export function startSolvePool(opts: PoolOptions): SolvePool | null {
  stopSolvePool();
  if (opts.threads <= 1) return null;
  try {
    pool = new SolvePool(opts);
  } catch (err) {
    console.warn('[тюрьма] пул решателя не запущен:', err instanceof Error ? err.message : err);
    pool = null;
  }
  return pool;
}

export function stopSolvePool(): void {
  pool?.close();
  pool = null;
}
