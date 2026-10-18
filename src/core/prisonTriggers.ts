/**
 * Когда снимать кадр сезонной тюрьмы (SS14, «Тюрьма Талоса»).
 *
 * Игра пишет в лог строки своего интерфейса: открылось окно цели, выбор
 * орудий, начался день, сыграла карточка действия. По ним понятно, что
 * экран сменился и через полторы-две секунды анимации осядут. Правила и
 * задержки перенесены из «Tartarus Simulator» (follow.js, capture.js):
 * строки идут пачкой, кадр снимается, когда лог затих на самую долгую
 * задержку из пачки. Пачка получает самый «старший» вид кадра.
 *
 * Модуль чистый: время — из меток в строках, таймер подставляет вызывающий.
 */

export type PrisonFrameKind = 'board' | 'instruments' | 'objective' | 'treasure' | 'theme';
type RuleKind = PrisonFrameKind | 'skip' | 'speed';

/**
 * Что привело к сокровищнице или выбору орудия в награду: Замена, Пожирание,
 * утро (день начался, на доске ещё ничего не нажато — например, «Монета»
 * сделала узника Призматическим) или иное ('' — обход, событие).
 */
export type ShotCause = '' | 'swap' | 'consume' | 'morning';

interface Rule {
  kind: RuleKind;
  re: RegExp;
  settleMs: number;
}

/**
 * Игра зовёт тюрьму S16. Задержки — в миллисекундах на обычной скорости:
 * минимум, после которого кадр вообще имеет смысл. Дальше Горн сам ждёт,
 * пока картинка перестанет меняться (поток экрана), поэтому паузы короткие.
 */
export const PRISON_RULES: readonly Rule[] = [
  { kind: 'objective', re: /S16BoardTaskPop Run/i, settleMs: 600 },
  // Окно особой темы забега в начале (за ним — озвучка Special_0N с номером темы).
  { kind: 'theme', re: /S16BoardThemePop Run/i, settleMs: 600 },
  // Карты орудий влетают дольше прочего.
  { kind: 'instruments', re: /S16BoardRelicPop Run/i, settleMs: 900 },
  { kind: 'instruments', re: /Btn_S16Board_RelicPop_Reroll/i, settleMs: 900 },
  // День начался: баннер закрылся, игра пишет номер дня (на итогах — max=0).
  { kind: 'board', re: /\[S16LastDay\] check cur=\d+ max=[1-9]/i, settleMs: 500 },
  { kind: 'board', re: /UI_S16_Card_Up/i, settleMs: 400 },
  { kind: 'board', re: /Btn_S16Board_ActionCell/i, settleMs: 600 },
  // Выбрана дверь: надзиратель идёт. Обычно следом UI_S16_Card_Up или окно
  // события, но не всегда — тогда кадр по самому выбору, после прохода.
  { kind: 'board', re: /Btn_S16Board_RouteCell/i, settleMs: 800 },
  { kind: 'board', re: /UI_S16_Click_Eat/i, settleMs: 800 },
  { kind: 'skip', re: /S16BoardNewDayPop Run/i, settleMs: 0 },
  // Подарки рисуются по месту карточек, картинка не нужна: ждать анимацию
  // незачем, только собрать соседние строки.
  { kind: 'treasure', re: /S16BoardColoredPop Run/i, settleMs: 250 },
  // «Destory» — так в самой игре.
  { kind: 'board', re: /S16BoardColoredPop Destory/i, settleMs: 300 },
  { kind: 'speed', re: /Btn_S16Board_Top_Speed/i, settleMs: 0 },
  { kind: 'board', re: /UI_S16_Click_Cancel/i, settleMs: 500 },
  { kind: 'board', re: /Btn_S16Board_EventPop_Confirm/i, settleMs: 500 },
];

const RANK: Record<PrisonFrameKind, number> = { board: 1, instruments: 2, objective: 3, treasure: 3, theme: 3 };

/** Кадр, который пора снять, и то, что о нём известно из лога. */
export interface PrisonShot {
  kind: PrisonFrameKind;
  /** Выбор орудий открывает новый забег (рядом строка дня 0). */
  fresh: boolean;
  /** Для сокровищницы и выбора орудия в награду: что к ним привело. */
  after: ShotCause;
  /** Доска, открытая из сокровищницы кнопкой «Посмотреть состояние тюрьмы». */
  treasureView: boolean;
  /** Выбор орудий после «Обновить»: обновление потрачено. */
  rerolled: boolean;
  /** Доска сразу после окна сокровищницы (подарок взят или просмотр доски). */
  treasureClosed: boolean;
  /**
   * Окно темы: номер озвучки «Play_VO_Story_S16_Special_0N» рядом с ним
   * (null — не было). Какая это тема — решает память забега.
   */
  theme: number | null;
  /**
   * День по логу: последняя строка «[S16LastDay] check cur=N max=M» (cur с
   * единицы, 0 — выбор перед первым днём). null — строки ещё не было.
   */
  day: { cur: number; max: number } | null;
  lines: string[];
}

export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const STAMP_RE = /^\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\]/;

/** Метка времени строки лога в мс, или null. */
export function stampMs(line: string): number | null {
  const m = STAMP_RE.exec(line);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m.map(Number) as number[];
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!, ms!);
}

export class PrisonTriggers {
  private burst: { kind: PrisonFrameKind; settle: number; lines: string[]; handle: unknown } | null = null;
  private pace = 1;
  private lastAction = 0;
  private lastEat = 0;
  private lastGift = 0;
  /** Начало дня (баннер нового дня) и последнее нажатие на доске. */
  private dayStart = 0;
  private lastBoardClick = 0;
  /** Обход или событие (выбор двери, «Подтвердить» события) — они тоже делают Призматических. */
  private lastRoute = 0;
  private lastSpecial: { n: number; at: number } | null = null;
  private day: { cur: number; max: number } | null = null;

  constructor(
    private readonly onShot: (shot: PrisonShot) => void,
    private readonly timer: Scheduler = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as NodeJS.Timeout) },
  ) {}

  /** День забега по последней строке «check cur=N max=M» (null — не было). */
  get lastDay(): { cur: number; max: number } | null {
    return this.day;
  }

  /** Ускорение в игре включено: анимации короче, ждать меньше. */
  get speedUp(): boolean {
    return this.pace < 1;
  }

  feed(lines: readonly string[]): void {
    for (const line of lines) this.line(line);
  }

  /** Сбросить ожидание (модуль выключили, игра закрылась). */
  cancel(): void {
    if (this.burst) this.timer.clear(this.burst.handle);
    this.burst = null;
  }

  private line(line: string): void {
    // Красный экран пожирания пишется без «S16» — его ловим до отсева.
    if (/Eating_red_screen/.test(line)) this.lastEat = stampMs(line) ?? 0;
    if (!line.includes('S16')) return;
    const at = stampMs(line) ?? 0;
    // На итогах забега игра пишет max=0 — это не день.
    const day = /check cur=(\d+) max=(\d+)/.exec(line);
    if (day && Number(day[2]) > 0) this.day = { cur: Number(day[1]), max: Number(day[2]) };
    const special = /S16_Special_(\d+)/.exec(line);
    if (special) this.lastSpecial = { n: Number(special[1]), at };
    if (/Btn_S16Board_ActionCell/.test(line)) this.lastAction = at;
    if (/ColoredPop_Confirm/.test(line)) this.lastGift = at;
    if (/S16BoardNewDayPop Run/i.test(line)) this.dayStart = at;
    if (/Btn_S16Board_(?:RouteCell|ActionCell|Cell)\b/.test(line)) this.lastBoardClick = at;
    if (/Btn_S16Board_(?:RouteCell|EventPop_Confirm)\b|S16BoardNewDayPop Run/i.test(line)) this.lastRoute = at;
    const rule = PRISON_RULES.find((r) => r.re.test(line));
    if (!rule) return;
    if (rule.kind === 'skip') {
      this.cancel();
      return;
    }
    if (rule.kind === 'speed') {
      this.pace = this.pace < 1 ? 1 : 0.45;
      return;
    }
    // Доска после закрытия сокровищницы — свой кадр: ждущая сокровищница
    // уходит сразу, ей картинка не нужна.
    if (this.burst && this.burst.kind === 'treasure' && rule.kind === 'board') {
      this.timer.clear(this.burst.handle);
      this.fire();
    }
    if (!this.burst) this.burst = { kind: rule.kind, settle: 0, lines: [], handle: null };
    if (RANK[rule.kind] > RANK[this.burst.kind]) this.burst.kind = rule.kind;
    this.burst.settle = Math.max(this.burst.settle, Math.max(250, rule.settleMs * this.pace));
    if (this.burst.lines.length < 40) this.burst.lines.push(line);
    this.timer.clear(this.burst.handle);
    this.burst.handle = this.timer.set(() => this.fire(), this.burst.settle);
  }

  private fire(): void {
    const b = this.burst;
    this.burst = null;
    if (!b) return;
    const fresh = b.lines.some((l) => /check cur=0\b/.test(l));
    let after: ShotCause = '';
    if (b.kind === 'treasure' || (b.kind === 'instruments' && !fresh)) {
      const pop = stampMs(b.lines.find((l) => /S16Board(?:Colored|Relic)Pop Run/i.test(l)) ?? '') ?? 0;
      // Утро: окно открылось после баннера нового дня, а на доске с тех пор
      // ничего не нажимали. Последнее действие дня (Замена) тут ни при чём:
      // после подарка будет обход этого дня.
      const morning = !!pop && !!this.dayStart && pop >= this.dayStart && this.dayStart > this.lastBoardClick;
      if (morning) after = 'morning';
      // Замена или Пожирание — только если после карточки дня не было обхода,
      // события или нового дня (забег 18.10 17:40: «Завершить день», утро,
      // дверь с событием, подарок через 4,8 с — это не Замена).
      else if (b.kind === 'treasure' && pop && this.lastAction && pop >= this.lastAction && pop - this.lastAction <= 6000 && this.lastRoute < this.lastAction) {
        after = this.lastEat >= this.lastAction - 500 ? 'consume' : 'swap';
      }
    }
    let treasureView = false;
    const shut = stampMs(b.lines.find((l) => /ColoredPop Destory/i.test(l)) ?? '');
    if (shut) treasureView = !(this.lastGift && shut >= this.lastGift && shut - this.lastGift < 3000);
    const rerolled = b.kind === 'instruments' && b.lines.some((l) => /Btn_S16Board_RelicPop_Reroll/i.test(l));
    // Озвучка темы идёт сразу за окном (через десятки мс).
    let theme: number | null = null;
    if (b.kind === 'theme' && this.lastSpecial) {
      const pop = stampMs(b.lines.find((l) => /S16BoardThemePop Run/i.test(l)) ?? '') ?? 0;
      if (Math.abs(this.lastSpecial.at - pop) <= 3000) theme = this.lastSpecial.n;
    }
    this.onShot({ kind: b.kind, fresh, after, treasureView, rerolled, treasureClosed: !!shut, theme, day: this.day, lines: b.lines });
  }
}
