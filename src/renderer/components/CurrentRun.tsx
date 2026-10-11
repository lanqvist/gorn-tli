import { useState } from 'react';

import type { RunView, Snapshot } from '../../main/engine.js';
import { clock, duration, num } from '../format.js';
import { DropList } from './DropList.js';
import { Fe } from './Fe.js';

/**
 * Сколько карта должна идти, прежде чем показывать сравнение темпа
 * с обычным. Меньше минуты знаменатель слишком мал: одна находка
 * даёт скачок в сотни процентов.
 */
const WARMUP_MS = 60_000;

export function CurrentRun({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const run = snapshot.current;

  // Карта закончилась — показываем прошлый забег, а не пустую карточку.
  // Иначе добыча исчезает с экрана ровно в тот момент, когда её хотят
  // рассмотреть: сразу после выхода из карты.
  if (!run) {
    const previous = snapshot.recent[0];
    if (!previous) {
      // Совсем без данных — это первый запуск: человеку нужны шаги,
      // а не констатация «ждём карту».
      if (snapshot.status === 'searching') return <GameNotFound />;
      return <Onboarding snapshot={snapshot} />;
    }
    return <FinishedRun run={previous} minFe={snapshot.minDropFe} />;
  }

  const elapsed = now - run.startedAt;
  const median = snapshot.rate.median;

  // Пока карта только началась, темп считается по крошечному знаменателю
  // и скачет на сотни процентов от одной находки. Показывать такое число —
  // значит врать: сравнение появляется только после разогрева.
  const warm = elapsed >= WARMUP_MS;
  const pace = warm ? (run.netFe / elapsed) * 3_600_000 : 0;
  const delta = pace - median;
  const pct = median > 0 ? Math.round((delta / median) * 100) : 0;

  return (
    <section className="card current">
      <div className="current-head">
        <h2>{run.name}</h2>
        <span className="timer">{clock(elapsed)}</span>
      </div>

      <div className="current-value">
        <Fe value={run.netFe} />
        {median > 0 &&
          (warm ? (
            <span className={`delta ${delta >= 0 ? 'up' : 'down'}`}>
              {delta >= 0 ? '↑' : '↓'} {Math.abs(pct)}% к обычному темпу
            </span>
          ) : (
            <span className="delta muted">темп считается…</span>
          ))}
      </div>

      <DropList drops={run.drops} minFe={snapshot.minDropFe} />
    </section>
  );
}

/**
 * «Игра не найдена» — раньше это был тупик без единого действия.
 * Автопоиск повторяется сам, а кнопка спасает не-Steam установки.
 */
function GameNotFound() {
  const [note, setNote] = useState<string | null>(null);
  return (
    <section className="card current empty onboarding">
      <h2>Игра не найдена</h2>
      <p className="muted">
        Steam-установка находится сама, поиск повторяется автоматически. Если игра
        стоит в другом месте или у вас не-Steam версия — укажите её папку.
      </p>
      <div className="set-actions">
        <button
          className="set-btn"
          onClick={() => {
            void window.gorn?.settings.chooseLogDir().then((r) => {
              if (r.status === 'invalid') {
                setNote('В выбранной папке нет логов игры — нужен корень установки или …\\Saved\\Logs.');
              } else {
                setNote(null);
              }
            });
          }}
        >
          Указать папку с игрой…
        </button>
      </div>
      {note && <p className="note warn">{note}</p>}
    </section>
  );
}

/** Первый запуск без истории: три шага вместо пустого «ждём карту». */
function Onboarding({ snapshot }: { snapshot: Snapshot }) {
  return (
    <section className="card current empty onboarding">
      <h2>Всё готово к первому забегу</h2>
      <ol className="steps">
        <li>Запустите Torchlight: Infinite</li>
        <li>Зайдите на любую карту</li>
        <li>Дальше я сам: посчитаю добычу, вложения и честный темп</li>
      </ol>
      {snapshot.hint && <p className="muted small">{snapshot.hint}</p>}
      {snapshot.logDir && <p className="muted small set-path">Лог найден: {snapshot.logDir}</p>}
      <p className="muted small">
        Оверлей поверх игры — кнопка в шапке или Ctrl+Alt+G. Игре нужен безрамочный
        или оконный полноэкранный режим: эксклюзивный полный экран перекрыть нельзя.
      </p>
    </section>
  );
}

/** Последний завершённый забег: держим его на экране, пока не начнётся новый. */
function FinishedRun({ run, minFe }: { run: RunView; minFe: number }) {
  return (
    <section className="card current">
      <div className="current-head">
        <h2>
          {run.name} <span className="muted small">· прошлый забег</span>
        </h2>
        <span className="timer">{duration(run.durationMs ?? 0)}</span>
      </div>

      <div className="current-value">
        <Fe value={run.netFe} />
        <span className="delta muted">{num(run.perHour)} в час</span>
      </div>

      <DropList drops={run.drops} minFe={minFe} />
    </section>
  );
}
