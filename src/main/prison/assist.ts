import { desktopCapturer, screen, utilityProcess, type Display, type UtilityProcess } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { planPrune, shotOutcome, type ShotEntry } from '../../core/prisonShots.js';
import { PrisonTriggers, stampMs, type PrisonShot } from '../../core/prisonTriggers.js';
import { ArrowLayer } from './arrowLayer.js';
import { ScreenStream, type Frame } from './screenStream.js';
import type { PrisonShotMessage, PrisonWorkerReply, SavedNear } from './protocol.js';

/** Экран должен столько не меняться, чтобы его снять (анимации осели). */
const STABLE_MS = 300;
/** Дольше этого спокойствия не ждём: снимаем как есть. */
const STABLE_MAX_MS = 2500;
/** Автокадр, который не распознался (экран ещё выезжал), переснимается: через это время, потом через вдвое большее. */
const RETRY_MS = 700;
const RETRIES = 2;
/** Сколько решатель проверяет варианты после мгновенного совета. */
const SOLVE_BUDGET_MS = 1500;
/** Подсказка без новых кадров дольше этого — устарела, прячем. */
const STALE_MS = 120_000;
/** Запасной разовый снимок дольше этого не ждём: при открытом потоке он тянется десятки секунд. */
const SNAPSHOT_MAX_MS = 3000;
/** Последний кадр статичного экрана годится, если снят хотя бы через столько после строки лога. */
const STATIC_AFTER_LINE_MS = 300;
/** Сколько раз подтолкнуть композицию, если поток застыл на старом кадре. */
const NUDGES = 2;
/** Ход игрока в логе: старая подсказка больше не про этот экран. */
const PLAYER_ACTION = /normal-click Btn_S16Board_(RouteCell|ActionCell|RelicPop|ColoredPop|EventPop)|UI_S16_Click_(Eat|Card|Go_Cell|Cancel)/;

/**
 * Подсказки в сезонной тюрьме.
 *
 * Ход игрока в логе сразу убирает старую стрелку и показывает «смотрю…».
 * Строки интерфейса тюрьмы (PrisonTriggers) говорят, что экран сменился;
 * кадр берётся из потока монитора, как только картинка успокоилась, и
 * уходит в поток распознавания и расчёта хода — без очереди: новый кадр
 * обрывает расчёт по старому. Мгновенный совет стратегии приходит сразу,
 * проверка вариантами уточняет его.
 *
 * Снимается монитор (снимок окна игра отдаёт чёрным), тот, где курсор.
 * Окно стрелок вырезано из захвата. Модель доски сохраняется на диск:
 * перезапуск Горна посреди забега не теряет цель, орудия и ходы дня.
 *
 * Ограничение: игра в режиме «окно без рамки» на весь монитор.
 */
export class PrisonAssist {
  private worker: UtilityProcess | null = null;
  private readonly layer = new ArrowLayer();
  private readonly stream = new ScreenStream();
  private readonly triggers = new PrisonTriggers((shot) => void this.capture(shot));
  private enabled = false;
  private nextId = 0;
  private display: Display | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  /** Куда сохранять кадры (null — не сохранять) и что о каждом уже известно. */
  private saveRoot: string | null = null;
  private readonly saving = new Map<number, { base: string; info: Record<string, unknown> }>();
  private pruneTimer: NodeJS.Timeout | null = null;
  /** Снимок идёт; следующий кадр ждёт (только последний). */
  private capturing = false;
  private nextShot: { shot: PrisonShot; manual: boolean } | null = null;
  /** Кадры в работе: для повтора, если автокадр не распознался. */
  private readonly shots = new Map<number, { shot: PrisonShot; manual: boolean; retry: number }>();
  private readonly retries = new WeakMap<PrisonShot, number>();
  /** С какого монитора снят кадр: найдена доска — это монитор игры. */
  private readonly shotDisplay = new Map<number, number>();
  private stateTimer: NodeJS.Timeout | null = null;
  private state: unknown = null;
  /**
   * Монитор с игрой: на нём уже нашлась доска тюрьмы. Дальше снимается
   * он, куда бы ни ушёл курсор (игрок пишет в чат на другом мониторе).
   */
  private gameDisplayId: number | null = null;
  /** Где была доска на кадре: первый кадр после запуска ищет её рядом, а не по всему экрану (1,7 с). */
  private near: SavedNear | null = null;
  private snapshotting = false;
  /** Сколько окон подарков отправлено: кадр, снятый до последнего, — про подарки. */
  private treasureSeq = 0;

  /** Монитор игры: найденный по доске, а пока не найден — под курсором. */
  private gameDisplay(): Display {
    const all = screen.getAllDisplays();
    return all.find((d) => d.id === this.gameDisplayId) ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  constructor(private readonly dirs: { worker: string; state: string }) {
    // Монитор игры с прошлого раза: иначе до первой подсказки Горн гадал
    // по курсору, а курсор у игрока на другом мониторе (чат, браузер).
    try {
      const saved = JSON.parse(readFileSync(this.displayFile, 'utf8')) as { id?: number; near?: SavedNear };
      if (typeof saved.id === 'number') this.gameDisplayId = saved.id;
      if (saved.near && typeof saved.near.s === 'number') this.near = saved.near;
    } catch {
      // Нет файла — узнаем по первой найденной доске.
    }
  }

  private saveDisplay(): void {
    void writeFile(this.displayFile, JSON.stringify({ id: this.gameDisplayId, near: this.near })).catch(() => undefined);
  }

  private get displayFile(): string {
    return join(dirname(this.dirs.state), 'prison-display.json');
  }

  /**
   * Сохранять кадры тюрьмы: PNG и JSON рядом — вид экрана, строки лога,
   * которые его вызвали, и показанная подсказка. Для разбора ошибок.
   */
  setSaveRoot(dir: string | null): void {
    this.saveRoot = dir;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    if (!dir) return;
    // Папка кадров растёт на гигабайт за вечер: чистить при включении и раз в час.
    void this.pruneShots();
    this.pruneTimer = setInterval(() => void this.pruneShots(), 3_600_000);
  }

  /** Убрать из папки кадров лишнее (правило — в core/prisonShots). */
  private async pruneShots(): Promise<void> {
    const root = this.saveRoot;
    if (!root) return;
    try {
      const entries: ShotEntry[] = [];
      const days = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
      for (const day of days) {
        const dir = join(root, day.name);
        const bases = new Set((await readdir(dir)).filter((f) => /\.(png|json)$/.test(f)).map((f) => f.replace(/\.(png|json)$/, '')));
        for (const name of bases) {
          const base = join(dir, name);
          const png = await stat(`${base}.png`).catch(() => null);
          const json = await stat(`${base}.json`).catch(() => null);
          let outcome: ShotEntry['outcome'] = 'miss';
          if (json) {
            try {
              outcome = shotOutcome(JSON.parse(await readFile(`${base}.json`, 'utf8')));
            } catch {
              // Недописанный или испорченный JSON — как сбой.
            }
          }
          entries.push({ base, at: (json ?? png)!.mtimeMs, outcome, png: png ? png.size : 0, json: !!json });
        }
      }
      const drop = planPrune(entries, Date.now());
      let freed = 0;
      for (const f of drop) {
        const s = await stat(f).catch(() => null);
        await rm(f, { force: true });
        freed += s ? s.size : 0;
      }
      for (const day of days) await rmdir(join(root, day.name)).catch(() => undefined);
      if (drop.length) console.log(`[тюрьма] очистка кадров: удалено ${drop.length} файлов, ${Math.round(freed / 1048576)} МБ`);
    } catch (err) {
      console.warn('[тюрьма] очистка кадров не удалась:', err instanceof Error ? err.message : err);
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) {
      this.triggers.cancel();
      this.layer.clear();
      this.stream.stop();
      this.worker?.kill();
      this.worker = null;
    }
  }

  /** Сырые строки лога от движка. */
  onLines(lines: readonly string[]): void {
    if (!this.enabled) return;
    if (lines.some((l) => l.includes('S16'))) {
      const display = this.gameDisplay();
      // В тюрьме — поток экрана открыт заранее, к первому нужному кадру.
      this.stream.warm(display);
      // Игрок сходил: прежняя стрелка уже неверна — убрать сразу, а не
      // когда придёт новая, и показать, что Горн смотрит.
      if (lines.some((l) => PLAYER_ACTION.test(l))) this.layer.thinking(display);
    }
    this.triggers.feed(lines);
  }

  /** Снять кадр сейчас (хоткей): экран определится по картинке. */
  captureNow(): void {
    if (!this.enabled) return;
    this.layer.thinking(this.gameDisplay());
    void this.capture({ kind: 'board', fresh: false, after: '', treasureView: false, rerolled: false, treasureClosed: false, theme: null, day: this.triggers.lastDay, lines: [] }, true);
  }

  /** Начать забег с чистой доски (сохранённое состояние не подходит). */
  resetRun(): void {
    this.worker?.postMessage({ type: 'reset' });
  }

  dispose(): void {
    this.flushState();
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.setEnabled(false);
    this.layer.destroy();
    this.stream.destroy();
  }

  private ensureWorker(): UtilityProcess | null {
    if (this.worker) return this.worker;
    if (!existsSync(this.dirs.worker)) {
      console.warn('[тюрьма] нет процесса подсказок:', this.dirs.worker);
      return null;
    }
    let state: unknown = this.state;
    if (!state) {
      try {
        state = JSON.parse(readFileSync(this.dirs.state, 'utf8'));
      } catch {
        state = null;
      }
    }
    // Отдельный процесс, а не поток: только процессу можно понизить
    // приоритет, чтобы расчёт не отнимал процессор у игры.
    const w = utilityProcess.fork(this.dirs.worker, [], { serviceName: 'Горн — подсказки в тюрьме', stdio: 'inherit' });
    w.postMessage({ type: 'init', state, near: this.near });
    w.on('message', (msg: PrisonWorkerReply) => this.onReply(msg));
    w.on('exit', (code) => {
      if (code) console.error('[тюрьма] процесс подсказок завершился с кодом', code);
      if (this.worker === w) this.worker = null;
    });
    this.worker = w;
    return w;
  }

  private async capture(shot: PrisonShot, manual = false): Promise<void> {
    if (!this.enabled) return;
    if (shot.kind === 'treasure' && !manual) {
      // Окно подарков: доска за ним уже известна, рамка ставится по месту
      // карточки — без снимка и без очереди. Ждущий автокадр снял бы уже
      // само окно подарков.
      this.treasureSeq++;
      if (this.nextShot && !this.nextShot.manual) this.nextShot = null;
      this.post(shot, false, null, this.gameDisplay(), 'без снимка', Date.now(), false);
      return;
    }
    if (this.capturing) {
      this.nextShot = { shot, manual };
      return;
    }
    this.capturing = true;
    try {
      await this.captureOnce(shot, manual);
    } finally {
      this.capturing = false;
      const next = this.nextShot;
      this.nextShot = null;
      if (next) void this.capture(next.shot, next.manual);
    }
  }

  private async captureOnce(shot: PrisonShot, manual: boolean): Promise<void> {
    const t0 = Date.now();
    const seq = this.treasureSeq;
    // Вручную — монитор под курсором: так можно показать Горну игру на
    // другом мониторе. Автокадр — монитор, где уже нашлась доска.
    const display = manual ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) : this.gameDisplay();
    // Окно стрелок видно (хотя бы «смотрю…») — экран пересобирается и поток
    // получает свежие кадры; в сам кадр окно не попадает.
    this.layer.thinking(display);
    // Статичный экран (выбор орудий, событие) новых кадров не даёт: годится
    // последний, снятый после строки лога (с запасом на начало анимации);
    // по хоткею — любой последний: игрок смотрит на экран сам.
    const lineAt = shot.lines.length ? stampMs(shot.lines[shot.lines.length - 1]!) : null;
    const okAge = manual ? 60_000 : lineAt ? Math.max(0, t0 - lineAt - STATIC_AFTER_LINE_MS) : 0;
    let frame = await this.stream.grab(display, manual ? 0 : STABLE_MS, manual ? 600 : STABLE_MAX_MS, okAge);
    let via = 'поток';
    if (!frame && this.stream.lastMiss === 'silent') {
      // Поток молчит — открыть заново и спросить ещё раз. При «stale» (игра
      // не пересобирает экран) переоткрытие не помогает — сразу снимок.
      if (await this.stream.restart(display)) frame = await this.stream.grab(display, 0, 1200);
      via = 'поток заново';
    }
    for (let i = 0; !frame && this.stream.lastMiss === 'stale' && i < NUDGES; i++) {
      this.layer.nudge(display);
      frame = await this.stream.grab(display, 0, 900, okAge);
      via = `поток после толчка ${i + 1}`;
    }
    // Разовый снимок (getSources в 4K) блокирует главный процесс на секунды,
    // а при полноэкранной игре часто пустой: только по хоткею, когда игрок
    // сам попросил.
    if (!frame && manual) {
      frame = await this.snapshot(display);
      via = 'снимок';
    }
    if (!frame) console.warn(`[тюрьма] кадр не получен за ${Date.now() - t0} мс — экран не обновляется`);
    if (!frame) {
      // Пока снимали, открылось окно подарков — его подсказку не трогать.
      if (seq === this.treasureSeq) this.layer.clear();
      return;
    }
    // Пока снимали, открылось окно подарков: доску учесть, совет — по подаркам.
    const late = seq !== this.treasureSeq;
    if (late && shot.kind !== 'board') return;
    this.post(shot, manual, frame, display, via, t0, late);
  }

  /** Кадр — в поток распознавания; frame null — без картинки (подарки). */
  private post(shot: PrisonShot, manual: boolean, frame: Frame | null, display: Display, via: string, t0: number, asTreasure: boolean): void {
    const lineAt = shot.lines.length ? stampMs(shot.lines[shot.lines.length - 1]!) : null;
    const lag = lineAt ? `строка ${((t0 - lineAt) / 1000).toFixed(1)} с назад` : 'вручную';
    const id = ++this.nextId;
    this.shots.set(id, { shot, manual, retry: this.retries.get(shot) ?? 0 });
    const savePath = this.saveRoot && frame ? this.noteShot(id, manual ? 'manual' : shot.kind, shot) : null;
    console.log(`[тюрьма] кадр ${id} (${manual ? 'manual' : shot.kind}${asTreasure ? ', к подаркам' : ''}): ${lag}, ${via} ${Date.now() - t0} мс`);
    this.display = display;
    this.shotDisplay.set(id, display.id);
    const msg: PrisonShotMessage = {
      type: 'shot',
      id,
      kind: manual ? 'manual' : shot.kind,
      fresh: shot.fresh,
      after: shot.after,
      treasureView: shot.treasureView,
      rerolled: shot.rerolled,
      treasureClosed: shot.treasureClosed,
      theme: shot.theme,
      day: shot.day,
      asTreasure,
      width: frame ? frame.width : Math.round(display.size.width * display.scaleFactor),
      height: frame ? frame.height : Math.round(display.size.height * display.scaleFactor),
      buffer: frame ? frame.buffer : new ArrayBuffer(0),
      format: frame ? frame.format : 'rgba',
      budgetMs: SOLVE_BUDGET_MS,
      savePath,
    };
    const w = this.ensureWorker();
    // Без очереди: процесс сам бросит расчёт по прошлому кадру.
    w?.postMessage(msg);
  }

  /** Запасной способ: разовый снимок монитора (медленно — до секунд). */
  private async snapshot(display: Display): Promise<Frame | null> {
    if (this.snapshotting) return null;
    this.snapshotting = true;
    try {
      return await Promise.race([
        this.snapshotOnce(display),
        new Promise<null>((r) => setTimeout(() => r(null), SNAPSHOT_MAX_MS)),
      ]);
    } finally {
      this.snapshotting = false;
    }
  }

  private async snapshotOnce(display: Display): Promise<Frame | null> {
    const size = {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    };
    let sources: Electron.DesktopCapturerSource[];
    try {
      sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    } catch (err) {
      console.warn('[тюрьма] снимок не удался:', err instanceof Error ? err.message : err);
      return null;
    }
    const game = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined);
    if (!game || game.thumbnail.isEmpty()) {
      console.warn(`[тюрьма] ${game ? 'пустой снимок монитора' : `нет снимка монитора ${display.id}`}`);
      return null;
    }
    const { width, height } = game.thumbnail.getSize();
    const buffer = new Uint8Array(game.thumbnail.toBitmap()).buffer as ArrayBuffer;
    return { width, height, buffer, format: 'bgra' };
  }

  private onReply(msg: PrisonWorkerReply): void {
    if (msg.type === 'state') {
      this.saveState(msg.model);
      return;
    }
    if (msg.type === 'near') {
      this.near = msg.near;
      this.saveDisplay();
      return;
    }
    const done = msg.type !== 'hint' || msg.phase === 'final';
    this.noteReply(msg, done);
    // Ответ на кадр, который уже сменился новым, не показываем.
    const from = this.shotDisplay.get(msg.id);
    if (msg.type === 'hint' && from !== undefined && from !== this.gameDisplayId) {
      this.gameDisplayId = from;
      this.saveDisplay();
    }
    if (done) this.shotDisplay.delete(msg.id);
    if (msg.id === this.nextId && this.display) {
      if (msg.type === 'hint') {
        this.layer.show(this.display, msg);
        this.armStale();
      } else if (msg.type === 'settled') this.layer.settle(msg.live);
      else if (msg.type === 'clear') this.layer.clear();
      else if (msg.type === 'error') {
        console.error('[тюрьма] ошибка разбора кадра:', msg.message);
        this.layer.clear();
      }
    }
    // Автокадр не распознался (анимация ещё шла) — переснять, до двух раз.
    const sent = this.shots.get(msg.id);
    if (done) this.shots.delete(msg.id);
    // Доска после подарка без дверей — не ошибка, а запомненное состояние.
    if (done && msg.type === 'clear' && sent && !sent.manual && sent.retry < RETRIES && !sent.shot.treasureClosed && (sent.shot.kind === 'board' || sent.shot.kind === 'instruments')) {
      const id = msg.id;
      if (this.display) this.layer.thinking(this.display);
      setTimeout(() => {
        if (this.nextId !== id) return;
        this.retries.set(sent.shot, sent.retry + 1);
        void this.capture(sent.shot);
      }, RETRY_MS * (sent.retry + 1));
    }
  }

  /** Модель доски — на диск, не чаще раза в секунду. */
  private saveState(model: unknown): void {
    this.state = model;
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => this.flushState(), 1000);
  }

  private flushState(): void {
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = null;
    if (!this.state) return;
    void mkdir(dirname(this.dirs.state), { recursive: true })
      .then(() => writeFile(this.dirs.state, JSON.stringify(this.state)))
      .catch((err: unknown) => console.warn('[тюрьма] состояние не сохранено:', err instanceof Error ? err.message : err));
  }

  /**
   * Запомнить кадр для сохранения: PNG пишет поток подсказок, JSON — этот
   * класс, когда придёт итоговый ответ. Возвращает путь для PNG.
   */
  private noteShot(id: number, kind: string, shot: PrisonShot): string | null {
    if (!this.saveRoot) return null;
    const now = new Date();
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
    const base = join(this.saveRoot, day, `${time}-${kind}`);
    this.saving.set(id, { base, info: { kind, fresh: shot.fresh, after: shot.after, treasureView: shot.treasureView, treasureClosed: shot.treasureClosed, rerolled: shot.rerolled, theme: shot.theme, day: shot.day, lines: shot.lines, hints: [] } });
    return `${base}.png`;
  }

  /** Ответ потока — в JSON кадра; итоговый ответ записывает файл. */
  private noteReply(msg: PrisonWorkerReply, done: boolean): void {
    const entry = this.saving.get(msg.id);
    if (!entry) return;
    (entry.info['hints'] as unknown[]).push(msg);
    if (!done) return;
    this.saving.delete(msg.id);
    void mkdir(dirname(entry.base), { recursive: true })
      .then(() => writeFile(`${entry.base}.json`, JSON.stringify(entry.info, null, 1)))
      .catch((err: unknown) => console.warn('[тюрьма] описание кадра не сохранено:', err instanceof Error ? err.message : err));
  }

  private armStale(): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => this.layer.clear(), STALE_MS);
  }
}
