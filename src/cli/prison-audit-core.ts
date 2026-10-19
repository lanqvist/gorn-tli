/**
 * Аудит забега тюрьмы: разбивка кадров Горна на забеги и находки по записям
 * повтора — то, что раньше искали руками: подсказка молчала, карта или
 * иконка не узнана, ожидание скачет без хода, хранилище откатилось, день
 * разошёлся с логом, живой совет заметно хуже нынешнего, обрыв связи.
 * Чистые функции: кадры и повтор — в prison-audit.ts.
 */

/** Кадр Горна для разбивки на забеги. */
export interface FrameHead {
  file: string;
  kind: string;
  fresh?: boolean;
}

/**
 * Забеги по кадрам одного дня (имена по времени). Забег начинается с выбора
 * орудий в начале забега (fresh) вместе с окнами цели и темы прямо перед ним.
 * Кадры до первого начала — хвост прошлого забега (start = false).
 */
export function splitRuns(frames: readonly FrameHead[]): { from: number; to: number; start: boolean }[] {
  const starts: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    if (frames[i]!.kind !== 'instruments' || !frames[i]!.fresh) continue;
    let s = i;
    while (s > 0 && (frames[s - 1]!.kind === 'objective' || frames[s - 1]!.kind === 'theme')) s--;
    // Повторный кадр того же выбора (после «Обновить») — тот же забег.
    if (starts.length && i - starts[starts.length - 1]! <= 3 && frames.slice(starts[starts.length - 1]!, i).every((f) => f.kind !== 'board')) continue;
    starts.push(s);
  }
  const runs: { from: number; to: number; start: boolean }[] = [];
  if (frames.length && (starts.length === 0 || starts[0]! > 0)) runs.push({ from: 0, to: (starts[0] ?? frames.length) - 1, start: false });
  starts.forEach((s, k) => runs.push({ from: s, to: (starts[k + 1] ?? frames.length) - 1, start: true }));
  return runs;
}

/** Запись повтора по одному кадру. */
export interface FrameRec {
  file: string;
  /** ЧЧММСС из имени файла. */
  time: string;
  kind: string;
  hasPng: boolean;
  /** День по логу (cur с единицы), если строка check cur была. */
  logDay: { cur: number; max: number } | null;
  /** Последняя живая подсказка ('' — только «clear» или ответа не было). */
  live: string;
  /** Горн ответил на кадр (иначе расчёт прервал следующий кадр — не зависание). */
  answered: boolean;
  /** Что на кадре по распознаванию: patrol, manage, chain, ratway, office, pick, treasure, board, other. */
  screen: string;
  /** На кадре есть ход (двери, ряд решений, выбор, цепочка). */
  actionable: boolean;
  /** Неузнанных карт на выборе орудий. */
  pickUnknown: number;
  /** Совет повтора и лучшее ожидание (null — без расчёта). */
  mine: string;
  best: number | null;
  /** На сколько живой ход хуже лучшего по повтору (null — не оценён). */
  liveGap: number | null;
  /** В логе кадра подтверждено событие («!»): исход случаен, смена ожидания — не скачок. */
  event?: boolean;
  mem: { day: number; dayLimit: number; storage: number; tools: string[]; assumed: string[]; step: string; start: string };
}

export interface Finding {
  kind: 'зависание' | 'карта' | 'иконка' | 'скачок' | 'расхождение' | 'хранилище' | 'день' | 'кадры' | 'связь';
  time: string;
  text: string;
  /** Та же находка на соседних кадрах подряд. */
  count?: number;
}

/** Пороги находок. */
export const AUDIT = {
  /** Ожидание сменилось без хода (тот же экран, тот же день) — призм. */
  jumpSame: 1,
  /** Ожидание сменилось за один шаг дня (кроме окон выбора) — призм. */
  jumpAny: 1.5,
  /** Живой совет хуже нынешнего — призм. */
  gap: 0.15,
} as const;

const NO_JUMP = new Set(['pick', 'treasure', 'board']);
/** Подтверждение окна события в логе игры. */
export const EVENT_RE = /Btn_S16Board_EventPop_Confirm\b/;
const hhmmss = (t: string) => `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
const seconds = (t: string) => (Number(t.slice(0, 2)) * 60 + Number(t.slice(2, 4))) * 60 + Number(t.slice(4, 6));
/** Совет на тот же экран пришёл со следующим кадром почти сразу (кадр снят чуть раньше окна). */
const ANSWER_SOON_S = 3;

/** Находки по записям одного забега. */
export function findings(recs: readonly FrameRec[]): Finding[] {
  const out: Finding[] = [];
  // Та же находка подряд (кадры одного экрана) — одна строка со счётчиком.
  const add = (kind: Finding['kind'], r: FrameRec, text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind && last.text === text) last.count = (last.count ?? 1) + 1;
    else out.push({ kind, time: hhmmss(r.time), text });
  };
  let maxStorage = -1;
  let prev: FrameRec | null = null;
  // Событие подтверждено после прошлого кадра с оценкой (клик бывает на кадре без расчёта).
  let event = false;
  recs.forEach((r, i) => {
    event ||= !!r.event;
    const next = recs[i + 1];
    const soon = !!next && next.screen === r.screen && !!next.live && seconds(next.time) - seconds(r.time) <= ANSWER_SOON_S;
    if (r.hasPng && r.actionable && !r.live && r.answered && !soon && r.kind !== 'manual') {
      add('зависание', r, `подсказки не было на экране «${r.screen}»${r.mine ? `; сейчас Горн советует «${r.mine}»` : '; Горн молчит и сейчас'}`);
    }
    if (r.pickUnknown > 0) add('карта', r, `на выборе орудий не узнано карт: ${r.pickUnknown}`);
    if (r.liveGap !== null && r.liveGap >= AUDIT.gap) add('расхождение', r, `живой совет «${r.live}» хуже нынешнего «${r.mine}» на ${r.liveGap.toFixed(2)} призм.`);
    if (r.screen !== 'other' && r.screen !== 'pick') {
      if (r.mem.storage < maxStorage) add('хранилище', r, `хранилище в памяти ${r.mem.storage}, а было ${maxStorage}`);
      maxStorage = Math.max(maxStorage, r.mem.storage);
    }
    if (r.logDay && r.logDay.cur > 0 && r.mem.day + 1 !== r.logDay.cur && r.kind === 'board') {
      add('день', r, `день в памяти ${r.mem.day + 1}, по логу ${r.logDay.cur}`);
    }
    if (prev && prev.best !== null && r.best !== null && prev.mem.day === r.mem.day && !event && !NO_JUMP.has(r.screen) && !NO_JUMP.has(prev.screen)) {
      const d = r.best - prev.best;
      const same = prev.screen === r.screen && prev.mine === r.mine;
      if (Math.abs(d) >= (same ? AUDIT.jumpSame : AUDIT.jumpAny)) {
        add('скачок', r, `ожидание ${prev.best.toFixed(2)} → ${r.best.toFixed(2)} (${hhmmss(prev.time)} «${prev.screen}» → «${r.screen}»)${same ? ' без хода' : ''}`);
      }
    }
    if (r.best !== null) {
      prev = r;
      event = false;
    }
  });
  const last = [...recs].reverse().find((r) => r.mem.tools.length || r.mem.assumed.length);
  if (last && last.mem.assumed.length) {
    out.push({ kind: 'иконка', time: hhmmss(last.time), text: `иконка на панели не узнаётся, орудие только «предположительно»: ${last.mem.assumed.join(', ')}` });
  }
  return out;
}

/** Сводка забега. */
export function summary(recs: readonly FrameRec[]): { start: number | null; prisms: number; days: string; tools: string[]; theme: string } {
  const firstPatrol = recs.find((r) => r.screen === 'patrol' && r.best !== null);
  const prisms = Math.max(0, ...recs.map((r) => r.mem.storage));
  const last = recs[recs.length - 1];
  const lastLog = [...recs].reverse().find((r) => r.logDay && r.logDay.cur > 0)?.logDay;
  return {
    start: firstPatrol?.best ?? null,
    prisms,
    days: lastLog ? `${lastLog.cur}/${lastLog.max}` : last ? `${last.mem.day + 1}/${last.mem.dayLimit}` : '—',
    tools: last ? [...last.mem.tools] : [],
    theme: last ? last.mem.start : 'none',
  };
}

/** Строки лога игры об обрыве связи. */
export const NET_RE = /NetGame DisConnect\b|ShowReconnect|Reconnect Fail|BackToLogin\(\)|MessageATimeout/;
