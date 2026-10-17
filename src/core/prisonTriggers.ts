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

export type PrisonFrameKind = 'board' | 'instruments' | 'objective' | 'treasure';
type RuleKind = PrisonFrameKind | 'skip' | 'speed';

interface Rule {
  kind: RuleKind;
  re: RegExp;
  settleMs: number;
}

/** Игра зовёт тюрьму S16. Задержки — в миллисекундах на обычной скорости. */
export const PRISON_RULES: readonly Rule[] = [
  { kind: 'objective', re: /S16BoardTaskPop Run/i, settleMs: 1500 },
  { kind: 'instruments', re: /S16BoardRelicPop Run/i, settleMs: 1500 },
  { kind: 'instruments', re: /Btn_S16Board_RelicPop_Reroll/i, settleMs: 2000 },
  // День начался: баннер закрылся, игра пишет номер дня (на итогах — max=0).
  { kind: 'board', re: /\[S16LastDay\] check cur=\d+ max=[1-9]/i, settleMs: 1500 },
  { kind: 'board', re: /UI_S16_Card_Up/i, settleMs: 1500 },
  { kind: 'board', re: /Btn_S16Board_ActionCell/i, settleMs: 2000 },
  { kind: 'board', re: /UI_S16_Click_Eat/i, settleMs: 2500 },
  { kind: 'skip', re: /S16BoardNewDayPop Run/i, settleMs: 0 },
  { kind: 'treasure', re: /S16BoardColoredPop Run/i, settleMs: 1500 },
  // «Destory» — так в самой игре.
  { kind: 'board', re: /S16BoardColoredPop Destory/i, settleMs: 600 },
  { kind: 'speed', re: /Btn_S16Board_Top_Speed/i, settleMs: 0 },
  { kind: 'board', re: /UI_S16_Click_Cancel/i, settleMs: 1500 },
  { kind: 'board', re: /Btn_S16Board_EventPop_Confirm/i, settleMs: 1500 },
];

const RANK: Record<PrisonFrameKind, number> = { board: 1, instruments: 2, objective: 3, treasure: 3 };

/** Кадр, который пора снять, и то, что о нём известно из лога. */
export interface PrisonShot {
  kind: PrisonFrameKind;
  /** Выбор орудий открывает новый забег (рядом строка дня 0). */
  fresh: boolean;
  /** Для сокровищницы: что к ней привело — замена или пожирание. */
  after: '' | 'swap' | 'consume';
  /** Доска, открытая из сокровищницы кнопкой «Посмотреть состояние тюрьмы». */
  treasureView: boolean;
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

  constructor(
    private readonly onShot: (shot: PrisonShot) => void,
    private readonly timer: Scheduler = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as NodeJS.Timeout) },
  ) {}

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
    if (/Btn_S16Board_ActionCell/.test(line)) this.lastAction = at;
    if (/ColoredPop_Confirm/.test(line)) this.lastGift = at;
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
    let after: PrisonShot['after'] = '';
    if (b.kind === 'treasure') {
      const pop = stampMs(b.lines.find((l) => /S16BoardColoredPop Run/i.test(l)) ?? '') ?? 0;
      if (pop && this.lastAction && pop >= this.lastAction && pop - this.lastAction <= 6000) {
        after = this.lastEat >= this.lastAction - 500 ? 'consume' : 'swap';
      }
    }
    let treasureView = false;
    const shut = stampMs(b.lines.find((l) => /ColoredPop Destory/i.test(l)) ?? '');
    if (shut) treasureView = !(this.lastGift && shut >= this.lastGift && shut - this.lastGift < 3000);
    this.onShot({ kind: b.kind, fresh, after, treasureView, lines: b.lines });
  }
}
