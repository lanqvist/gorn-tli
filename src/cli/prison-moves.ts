/**
 * Ходы по тексту подсказок — общий ключ для повтора и аудита забегов.
 */

/** Ход из текста подсказки — общий ключ для прежнего и своего пути. */
export function moveKey(text: string | undefined): string {
  if (!text) return '';
  const t = text.split(' · ')[0]!.trim();
  const cell = (s: string) => (s === 'допросную' ? '0' : s.replace('№', ''));
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^Иди в (допросную|№\d+)/))) return `обход ${cell(m[1]!)}`;
  if ((m = t.match(/^Выбери (№\d+)/))) return `тропа ${cell(m[1]!)}`;
  if ((m = t.match(/^Пожирание: съесть (№\d+)/))) return `съесть ${cell(m[1]!)}`;
  // На экране выбора цели прежний путь писал «Пожирание» и до первого укуса, и после.
  if ((m = t.match(/^Цепочка: съесть (№\d+)/))) return `съесть ${cell(m[1]!)}`;
  if ((m = t.match(/^Метка добычи: (№\d+)/))) return `метка ${cell(m[1]!)}`;
  if (/^Остановить цепочку/.test(t) || /^Отменить/.test(t)) return 'отменить';
  if (/^Заменить/.test(t)) return 'заменить';
  if (/^Завершить день/.test(t)) return 'конец дня';
  if (/^Наградить/.test(t)) return 'наградить';
  if (/^Подстрекнуть/.test(t)) return 'подстрекнуть';
  if (/^Обновить/.test(t)) return 'обновить';
  if (/нажми «Посмотреть состояние тюрьмы»/.test(t)) return 'показать доску';
  if ((m = t.match(/^Взять: (.+)$/))) return `взять ${m[1]!.split(' ').slice(0, 2).join(' ').toLowerCase()}`;
  return t;
}

/** Последняя показанная подсказка (окончательная, иначе мгновенная). */
export function lastHint(replies: { type: string; phase?: string; text?: string }[]): string {
  let text = '';
  for (const r of replies) {
    if (r.type === 'hint') text = r.text ?? '';
    else if (r.type === 'clear' && !text) text = '';
  }
  return text;
}
