/**
 * Свой путь подсказок в тюрьме: распознавание (recognize) → память забега
 * (adapter) → проверка вариантами (solver) → метки (hint). Без Electron:
 * им пользуются поток подсказок (worker.ts) и сравнение на сохранённых
 * кадрах (src/cli/prison-replay.ts).
 *
 * Механизмы прежнего пути сохранены: окно подарков без снимка (рамка по
 * месту подарка), доска за сокровищницей, переходная доска без карточек —
 * не совет, доска после подарка — только запомнить, цепочка, которую
 * модель не объясняет, — совет по подсвеченным целям, неузнанная карта
 * выбора не глушит совет, геометрия доски переживает перезапуск.
 *
 * Показывается сразу проверенный ход: мгновенный совет стратегии меняется
 * проверкой почти в половине ходов, и стрелка прыгала бы. Решатель
 * считает до 300 мс (обычно останавливается сам, медиана ~100 мс); не
 * уложился — уходит лучший на этот момент, а решатель досчитывает, пока
 * кадр на экране (до budgetMs), и меняет стрелку, только если новый
 * лидер заметно лучше показанного (clearlyBetter: ≥ max(2 SE, 0,02),
 * «уточнено»). То же между кадрами одного решения (ряд решений → выбор
 * цели того же Пожирания, тот же кадр снова): поиск продолжается, а
 * показанный ход остаётся, пока другой не станет заметно лучше.
 */
import { advise as policyAdvise } from '../../core/prison/policy/instant.js';
import { PrisonAdapter, type Position } from '../../core/prison/adapter.js';
import { decode, encode } from '../../core/prison/engine/actions.js';
import { TOOL_IDS, type Action, type ToolId } from '../../core/prison/model.js';
import { hint, type HintContext } from '../../core/prison/hint.js';
import { defaultGeometry, read, rerollBox, treasureBoxes, type Frame, type Geometry } from '../../core/prison/recognize/index.js';
import { clearSolveCache, clearlyBetter, solve, stateKey, type SolveOptions, type SolveStep } from '../../core/prison/solver/solve.js';
import type { Step } from '../../core/prison/adapter.js';
import { OFFER_KIND, OFFER_TOOL, PHASE, P_PICK, State } from '../../core/prison/engine/state.js';
import type { PrisonShotMessage, PrisonWorkerReply } from './protocol.js';

/** Столько решатель ищет ответ до первого показа. */
export const QUICK_MS = 300;
/**
 * Выбор орудий (старт и награда за цель) решает забег больше любого хода,
 * бывает 2–3 раза за забег, а окно выбора открыто долго: досчёт до этого
 * срока и не меньше PICK_ROUNDS раундов до остановки.
 */
export const PICK_BUDGET_MS = 4000;
export const PICK_ROUNDS = 1500;

const TREASURE_ASK = 'Подарок: нажми «Посмотреть состояние тюрьмы» и вернись — подскажу, какой взять';
/** Выбор орудий, где узнано меньше двух карт: совет не дать, но и не молчать. */
const PICK_UNKNOWN = 'Не узнал карты выбора — выбери сам';

export function isGeometry(x: unknown): x is Geometry {
  const g = x as Geometry | null;
  return !!g && typeof g === 'object' && [g.width, g.height, g.s, g.tx, g.ty].every((v) => typeof v === 'number');
}

function seedOf(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * Причина хода от стратегии — хвост её подписи («Камера 4: новый узник» →
 * «новый узник»). Только там, где она что-то добавляет к самому ходу: у
 * обхода, «Отменить» и «Обновить».
 */
function shortReason(text: string, code: number): string {
  const kind = decode(code).type;
  if (kind !== 'patrol' && kind !== 'stopchain' && kind !== 'reroll') return '';
  const i = text.indexOf(': ');
  return i >= 0 ? text.slice(i + 2) : '';
}

const defaultSleep = () => new Promise<void>((r) => setImmediate(r));

export interface OwnAdvisorOptions {
  /** Пауза между кусками расчёта: дать дойти новому кадру. */
  sleep?: () => Promise<void>;
  quickMs?: number;
  /** Распознавание (подменяется в тестах). */
  read?: typeof read;
  /** Правило остановки решателя (по умолчанию — STOP_DEFAULTS). */
  stop?: Omit<SolveOptions, 'seed'>;
}

export class OwnAdvisor {
  private adapter = new PrisonAdapter();
  private geo: Geometry | null = null;
  private current = 0;
  /** Доска, увиденная сразу после окна сокровищницы: по ней советуется подарок. */
  private boardBehindTreasure = false;
  /** Показанный ход текущего решения: держится, пока другой не станет заметно лучше. */
  private held: { key: string; state: State; code: number; step: Step; warden: number; day: number } | null = null;
  /** Варианты последней проверки (для сравнения на кадрах). */
  lastOptions: { action: Action; mean: number }[] = [];
  private readonly sleep: () => Promise<void>;
  private readonly quickMs: number;
  private readonly readFrame: typeof read;
  private readonly stop: Omit<SolveOptions, 'seed'>;

  constructor(private readonly reply: (m: PrisonWorkerReply) => void, opts: OwnAdvisorOptions = {}) {
    this.sleep = opts.sleep ?? defaultSleep;
    this.quickMs = opts.quickMs ?? QUICK_MS;
    this.readFrame = opts.read ?? read;
    this.stop = opts.stop ?? {};
  }

  init(state: unknown, near: unknown): void {
    this.adapter = new PrisonAdapter(state);
    this.geo = isGeometry(near) ? near : null;
  }

  reset(): void {
    this.held = null;
    this.adapter.reset();
    this.boardBehindTreasure = false;
    clearSolveCache();
    this.saveState();
  }

  /** Память забега (для сохранения и тестов). */
  get memory(): unknown {
    return this.adapter.mem;
  }

  private saveState(): void {
    this.reply({ type: 'state', id: 0, model: this.adapter.mem });
  }

  /** Кадр: frame — RGBA (null — окно подарков без снимка). */
  async handle(msg: PrisonShotMessage, frame: Frame | null): Promise<void> {
    this.current = msg.id;
    this.lastOptions = [];
    // Начало забега по логу — сброс памяти, даже если карты выбора на этом
    // кадре не читаются (анимация появления): дальше выбор может идти по
    // хоткею без пометки начала, и память прошлой партии осталась бы.
    if (msg.kind === 'instruments' && msg.fresh) this.adapter.startRun();
    // День — по логу (главный источник), экран — запасной.
    this.adapter.logDay(msg.day);
    const size = { w: msg.width, h: msg.height };
    const ctx: HintContext = { warden: null };
    // Неузнанная карта на выборе орудий: «Обновить» не советуем — вслепую
    // решатель считает её пустой, и обновление выглядит выгоднее, чем есть
    // (аудит 19.10: так советовал «Обновить» вместо карты лучше на 0,5 призм).
    let blindPick = false;
    const plainGeo = () => this.geo && this.geo.width === msg.width && this.geo.height === msg.height ? this.geo : defaultGeometry({ width: msg.width, height: msg.height, data: new Uint8ClampedArray(0) });
    let kind: string = msg.kind;
    let seen = frame ? this.read(frame) : null;

    if (msg.asTreasure && seen) {
      // Доска снята, а окно подарков уже открыто: обновить по ней доску,
      // совет — по подаркам.
      if (seen.screen === 'board') {
        this.adapter.board(seen.board);
        if (msg.treasureClosed) this.boardBehindTreasure = true;
      }
      kind = 'treasure';
      seen = null;
    }
    if (seen?.screen === 'treasure') {
      kind = 'treasure';
      ctx.gifts = seen.gifts;
    }

    if (kind === 'treasure') {
      ctx.gifts ??= treasureBoxes(plainGeo());
      if (this.boardBehindTreasure) {
        this.adapter.treasure('view');
      } else {
        this.adapter.treasure(msg.after);
        this.saveState();
        this.reply({ type: 'hint', id: msg.id, phase: 'final', frame: size, text: TREASURE_ASK, marks: [], live: false });
        return;
      }
    } else if (kind === 'theme') {
      // Окно темы забега: тема — по номеру озвучки из лога (картинку окна
      // пока не читаем: эталонов заголовков нет).
      this.adapter.theme(msg.theme);
      this.saveState();
      this.reply({ type: 'clear', id: msg.id });
      return;
    } else if ((kind === 'objective' && seen?.screen !== 'pick') || !seen) {
      // Окно цели и темы забега своё распознавание пока не читает.
      this.reply({ type: 'clear', id: msg.id });
      return;
    } else if (seen.screen === 'board' && kind !== 'instruments') {
      const b = seen.board;
      // Доска без дверей, ряда решений и цепочки — экран между состояниями
      // (карточки выезжают) или доска после взятого подарка: не совет.
      // После подарка её только запомнить — по ней советуется следующий.
      if (!msg.treasureView && !b.doors.length && !b.decision && !b.chain) {
        if (msg.treasureClosed) {
          this.adapter.board(b);
          this.boardBehindTreasure = true;
          this.saveState();
        }
        this.reply({ type: 'clear', id: msg.id });
        return;
      }
      this.adapter.board(b);
      this.boardBehindTreasure = !!msg.treasureClosed;
      // Просмотр доски из сокровищницы: совет по подарку сразу (текстом).
      if (msg.treasureView) this.adapter.treasure('view');
      ctx.board = b;
    } else if (seen.screen === 'pick' && kind !== 'board') {
      const p = seen.pick;
      // Неузнанная карта не глушит совет по двум остальным и по «Обновить».
      const known = p.cards.filter((c) => c !== null).length;
      if (known < 2) {
        // Не молчать: без подсказки выбор выглядит зависшим (18.10 20:48 — новые карты Молота и Клещей).
        this.reply({ type: 'hint', id: msg.id, phase: 'final', frame: size, text: PICK_UNKNOWN, marks: [], live: false });
        return;
      }
      // Хоткей на стартовом выборе (день 0 по логу) — тоже начало забега: иначе
      // совет считался бы с памятью прошлого забега.
      const fresh = msg.fresh || ((msg.kind === 'manual' || msg.kind === 'objective') && msg.day?.cur === 0 && !p.reward);
      this.adapter.pick(p, fresh, msg.rerolled, msg.after);
      ctx.pick = p;
      ctx.reroll = rerollBox(plainGeo());
      if (known < p.cards.length) {
        ctx.reason = 'одну карту не узнал';
        blindPick = true;
      }
    } else {
      this.reply({ type: 'clear', id: msg.id });
      return;
    }
    // Новый забег с выбора орудий сбрасывает память — день из лога ещё раз.
    this.adapter.logDay(msg.day);
    this.saveState();
    ctx.warden = this.adapter.mem.warden;
    ctx.ratway = this.adapter.mem.step === 'ratway';
    ctx.cancelFirst = this.adapter.mem.step === 'chain' && this.adapter.mem.firstBite;

    const pos = this.adapter.position();
    if (!pos.ok) {
      if (pos.fallback) {
        console.log(`[тюрьма] кадр ${msg.id}: ${pos.problem}, совет по подсвеченным целям`);
        this.reply({ type: 'hint', id: msg.id, phase: 'final', frame: size, live: false, ...hint(pos.fallback, ctx) });
      } else {
        console.log(`[тюрьма] кадр ${msg.id}: нет совета (${pos.problem})`);
        this.reply({ type: 'clear', id: msg.id });
      }
      return;
    }
    // Выбор цели до первого укуса — то же решение, что ряд решений перед
    // ним (тот же день и надзиратель): считаем ту же позицию дальше.
    const mem = this.adapter.mem;
    const held = this.held;
    const state = mem.step === 'chain' && mem.firstBite && held && held.step === 'manage' && held.warden === mem.warden && held.day === mem.day ? held.state : pos.state;
    const allowed = blindPick ? (code: number) => pos.allowed(code) && decode(code).type !== 'reroll' : pos.allowed;
    await this.advise(msg, { ...pos, state, allowed }, ctx, size);
  }

  private read(frame: Frame): ReturnType<typeof read>['view'] {
    const r = this.readFrame(frame, this.geo);
    if (r.geo && r.geo !== this.geo) {
      const moved = !this.geo || this.geo.width !== r.geo.width || this.geo.height !== r.geo.height || Math.abs(this.geo.s - r.geo.s) > 0.002 || Math.abs(this.geo.tx - r.geo.tx) > 2 || Math.abs(this.geo.ty - r.geo.ty) > 2;
      this.geo = r.geo;
      if (moved) this.reply({ type: 'near', id: 0, near: r.geo });
    }
    return r.view;
  }

  /** Лучший ход решателя среди видимых на экране. */
  private pickBest(res: SolveStep, allowed: (code: number) => boolean): number | null {
    this.lastOptions = res.options.filter((o) => allowed(encode(o.action))).map((o) => ({ action: o.action, mean: o.mean }));
    const ranked = res.options.map((o) => ({ code: encode(o.action), mean: o.mean })).sort((a, b) => b.mean - a.mean);
    const leader = encode(res.best);
    if (allowed(leader)) return leader;
    return ranked.find((o) => allowed(o.code))?.code ?? null;
  }

  private async advise(msg: PrisonShotMessage, pos: Extract<Position, { ok: true }>, ctx: HintContext, size: { w: number; h: number }): Promise<void> {
    const t0 = Date.now();
    // Зерно — от самой позиции: тот же кадр снова продолжает накопленный поиск.
    const key = stateKey(pos.state);
    const toolPick = pos.state.m[PHASE] === P_PICK && pos.state.m[OFFER_KIND] === OFFER_TOOL;
    const search = solve(pos.state, { ...(toolPick ? { minRounds: PICK_ROUNDS } : {}), ...this.stop, seed: seedOf(key) });
    const mem = this.adapter.mem;
    const incumbent = this.held && this.held.key === key && pos.allowed(this.held.code) ? this.held.code : null;
    const hold = (code: number) => {
      this.held = { key, state: this.held?.key === key ? this.held.state : copyOf(pos.state), code, step: mem.step, warden: mem.warden, day: mem.day };
    };
    const instant = policyAdvise(pos.state);
    const instantCode = encode(instant.action);
    const show = (code: number, phase: 'instant' | 'final', live: boolean, note = '') => {
      const a = decode(code);
      if (a.type === 'choose' && (TOOL_IDS as readonly string[]).includes(a.id)) {
        this.adapter.advised(a.id as ToolId);
        this.saveState();
      }
      const reason = code === instantCode ? shortReason(instant.text, code) : '';
      const h = hint(decode(code), { ...ctx, reason: [ctx.reason, reason, note].filter(Boolean).join(' · ') });
      this.reply({ type: 'hint', id: msg.id, phase, frame: size, live, ...h });
    };

    // Первый совет — не позже quickMs: решатель обычно успевает остановиться сам.
    let res = search.step(Math.min(50, this.quickMs));
    while (!res.done && Date.now() - t0 < this.quickMs) {
      await this.sleep();
      if (this.current !== msg.id) return;
      res = search.step(50);
    }
    const leader = this.pickBest(res, pos.allowed);
    if (leader === null) {
      this.reply({ type: 'clear', id: msg.id });
      return;
    }
    // Тот же ход, что уже показан для этого решения, — пока лидер не стал заметно лучше.
    const shown = incumbent !== null && incumbent !== leader && !clearlyBetter(search, leader, incumbent) ? incumbent : leader;
    hold(shown);
    if (res.done) {
      show(shown, 'final', res.rounds > 0);
      console.log(`[тюрьма] кадр ${msg.id}: совет через ${Date.now() - t0} мс (${res.rounds} раундов)`);
      return;
    }
    show(shown, 'instant', false);
    // Досчёт, пока этот кадр на экране и ход не сделан. Стрелка меняется,
    // только если новый лидер заметно лучше показанного хода — иначе
    // прыжки на почти равных ходах.
    const until = t0 + Math.max(this.quickMs, toolPick ? Math.max(PICK_BUDGET_MS, msg.budgetMs) : msg.budgetMs);
    while (!res.done && Date.now() < until) {
      await this.sleep();
      if (this.current !== msg.id) return;
      res = search.step(100);
    }
    if (this.current !== msg.id) return;
    const best = this.pickBest(res, pos.allowed);
    if (best !== null && best !== shown && clearlyBetter(search, best, shown)) {
      hold(best);
      show(best, 'final', true, 'уточнено');
      console.log(`[тюрьма] кадр ${msg.id}: совет уточнён через ${Date.now() - t0} мс (${res.rounds} раундов)`);
    } else {
      this.reply({ type: 'settled', id: msg.id, live: true });
    }
  }

}

function copyOf(s: State): State {
  const t = new State();
  t.m.set(s.m);
  return t;
}

