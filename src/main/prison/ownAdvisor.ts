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
 * лидер заметно лучше показанного и больше чем на TIE (worthSwitch,
 * «уточнено»). То же между кадрами одного решения (ряд решений → выбор
 * цели того же Пожирания, тот же кадр снова): поиск продолжается, а
 * показанный ход остаётся, пока другой не станет заметно лучше.
 * Равноценный ход (разница не больше TIE) называется второй строкой
 * подписи: «или „Обновить выбор“ — равноценно».
 */
import { advise as policyAdvise } from '../../core/prison/policy/instant.js';
import { PrisonAdapter, type Position } from '../../core/prison/adapter.js';
import { decode, encode } from '../../core/prison/engine/actions.js';
import { DEFAULT_PARAMS, type Action } from '../../core/prison/model.js';
import { hint, type HintContext } from '../../core/prison/hint.js';
import { defaultGeometry, read, rerollBox, treasureBoxes, type Frame, type Geometry } from '../../core/prison/recognize/index.js';
import { clearSolveCache, clearlyBetter, solve, stateKey, type Search, type SolveOptions, type SolveStep } from '../../core/prison/solver/solve.js';
import type { Step } from '../../core/prison/adapter.js';
import { STORAGE, State } from '../../core/prison/engine/state.js';
import type { PrisonShotMessage, PrisonWorkerReply } from './protocol.js';

/** Столько решатель ищет ответ до первого показа. */
export const QUICK_MS = 300;

const TREASURE_ASK = 'Подарок: нажми «Посмотреть состояние тюрьмы» и вернись — подскажу, какой взять';

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

/** Второй ход называем в подписи, если он хуже показанного не больше чем на столько призм. за забег… */
const TIE = 0.1;
/** …и погрешность разницы уже не больше этой (иначе это ещё шум первых раундов). */
const TIE_SE = 0.03;
/** Ход, отстающий не больше чем на столько, — кандидат в ничью: его досчитываем до конца бюджета. */
const TIE_LOOK = 0.15;

/**
 * Равноценный показанному ход среди видимых на экране: разница не больше
 * TIE при погрешности не больше TIE_SE, ход не отсечён. Обычно это
 * становится ясно к концу досчёта. Игроку — «или …»: на ничьей выбор за ним
 * (например, взять орудие или обновить выбор).
 */
function equalAlternative(state: State, search: Search, res: SolveStep, shown: number, allowed: (code: number) => boolean): number | null {
  // Хранилище полное — радуг уже не прибавить, равноценно почти всё: подпись была бы шумом.
  if (res.rounds <= 0 || state.m[STORAGE]! >= DEFAULT_PARAMS.storage) return null;
  let best: { code: number; mean: number } | null = null;
  for (const o of res.options) {
    const code = encode(o.action);
    if (o.pruned || code === shown || !allowed(code)) continue;
    const { d, se } = search.compare(shown, code);
    if (Math.abs(d) > TIE || se > TIE_SE) continue;
    // «Обновить» среди равноценных — его и называть: это отдельное решение
    // (меняются все три карты), а не ещё одна карта на выбор.
    const rank = o.action.type === 'reroll' ? Infinity : o.mean;
    if (!best || rank > best.mean) best = { code, mean: rank };
  }
  return best ? best.code : null;
}

/**
 * Сменить показанный ход: новый не только заметно лучше (clearlyBetter), но и
 * лучше больше чем на TIE. Иначе ходы равноценны — стрелка остаётся, второй
 * ход уходит в подпись «или … — равноценно».
 */
function worthSwitch(search: Search, next: number, shown: number): boolean {
  return clearlyBetter(search, next, shown) && search.compare(next, shown).d > TIE;
}

/** Есть ход, который может оказаться равноценным, но погрешность ещё велика. */
function tieUnresolved(search: Search, res: SolveStep, shown: number, allowed: (code: number) => boolean): boolean {
  return res.options.some((o) => {
    const code = encode(o.action);
    if (o.pruned || code === shown || !allowed(code)) return false;
    const { d, se } = search.compare(shown, code);
    return Math.abs(d) <= TIE_LOOK && se > TIE_SE;
  });
}

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
    const size = { w: msg.width, h: msg.height };
    const ctx: HintContext = { warden: null };
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
    } else if (kind === 'objective' || !seen) {
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
        this.reply({ type: 'clear', id: msg.id });
        return;
      }
      this.adapter.pick(p, msg.fresh, msg.rerolled);
      ctx.pick = p;
      ctx.reroll = rerollBox(plainGeo());
      if (known < p.cards.length) ctx.reason = 'одну карту не узнал';
    } else {
      this.reply({ type: 'clear', id: msg.id });
      return;
    }
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
    await this.advise(msg, { ...pos, state }, ctx, size);
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
    const search = solve(pos.state, { ...this.stop, seed: seedOf(key) });
    const mem = this.adapter.mem;
    const incumbent = this.held && this.held.key === key && pos.allowed(this.held.code) ? this.held.code : null;
    const hold = (code: number) => {
      this.held = { key, state: this.held?.key === key ? this.held.state : copyOf(pos.state), code, step: mem.step, warden: mem.warden, day: mem.day };
    };
    const instant = policyAdvise(pos.state);
    const instantCode = encode(instant.action);
    const show = (code: number, phase: 'instant' | 'final', live: boolean, note = '', res?: SolveStep) => {
      const reason = code === instantCode ? shortReason(instant.text, code) : '';
      const alt = res ? equalAlternative(pos.state, search, res, code, pos.allowed) : null;
      const h = hint(decode(code), { ...ctx, reason: [ctx.reason, reason, note].filter(Boolean).join(' · ') });
      // Вторая строка подписи: в основную длинное «или …» не влезает.
      const or = alt === null ? undefined : `или «${hint(decode(alt), { ...ctx, reason: '' }).text}» — равноценно`;
      this.reply({ type: 'hint', id: msg.id, phase, frame: size, live, ...h, ...(or ? { alt: or } : {}) });
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
    const shown = incumbent !== null && incumbent !== leader && !worthSwitch(search, leader, incumbent) ? incumbent : leader;
    hold(shown);
    if (res.done) {
      show(shown, 'final', res.rounds > 0, '', res);
      console.log(`[тюрьма] кадр ${msg.id}: совет через ${Date.now() - t0} мс (${res.rounds} раундов)`);
      return;
    }
    show(shown, 'instant', false, '', res);
    // Досчёт, пока этот кадр на экране и ход не сделан. Стрелка меняется,
    // только если новый лидер заметно лучше показанного хода — иначе
    // прыжки на почти равных ходах.
    const until = t0 + Math.max(this.quickMs, msg.budgetMs);
    while (!res.done && Date.now() < until) {
      await this.sleep();
      if (this.current !== msg.id) return;
      res = search.step(100);
    }
    if (this.current !== msg.id) return;
    // Почти равные ходы: решатель остановился (выбор надёжен), но равноценность
    // ещё не ясна — досчитать до конца бюджета, чтобы честно сказать «или …».
    while (Date.now() < until && tieUnresolved(search, res, shown, pos.allowed)) {
      await this.sleep();
      if (this.current !== msg.id) return;
      res = search.step(100, true);
    }
    if (this.current !== msg.id) return;
    const best = this.pickBest(res, pos.allowed);
    if (best !== null && best !== shown && worthSwitch(search, best, shown)) {
      hold(best);
      show(best, 'final', true, 'уточнено', res);
      console.log(`[тюрьма] кадр ${msg.id}: совет уточнён через ${Date.now() - t0} мс (${res.rounds} раундов)`);
    } else if (equalAlternative(pos.state, search, res, shown, pos.allowed) !== null) {
      // Ход тот же, но досчёт показал равноценный — дописать его второй строкой.
      show(shown, 'final', true, '', res);
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

