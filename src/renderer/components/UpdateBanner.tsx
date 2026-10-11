import { useEffect, useState } from 'react';

import type { UpdateState } from '../../main/updater.js';

/**
 * Полоса обновления.
 *
 * Показывается только когда есть что сообщить. Загрузка начинается
 * по кнопке, а не сама: трафик игрока — его дело. Установка тоже по кнопке,
 * потому что перезапуск посреди фарма недопустим.
 */
export function UpdateBanner() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!window.gorn) return;
    void window.gorn.update.get().then(setState);
    return window.gorn.update.onState(setState);
  }, []);

  // «Скрыть» относится к конкретному сообщению: сменился статус — полоса
  // имеет право показаться снова.
  useEffect(() => {
    setDismissed(false);
  }, [state?.status]);

  if (!state || state.status === 'idle' || state.status === 'checking') return null;
  if (dismissed) return null;

  // Неудачная проверка обновлений — не событие для игрока: приложение
  // работает и без неё. Одна приглушённая строка; техножаргон ошибки —
  // только в подсказке, для любопытных.
  if (state.status === 'error') {
    return (
      <div className="update update-quiet">
        <span title={state.error ?? undefined}>
          Обновления не проверились — нет сети? Приложение работает как обычно.
        </span>
        <button className="update-close" title="Скрыть" onClick={() => setDismissed(true)}>
          ✕
        </button>
      </div>
    );
  }

  if (state.status === 'downloading') {
    return (
      <div className="update">
        <span>Загружаю версию {state.version}…</span>
        <div className="update-bar">
          <i style={{ width: `${Math.round(state.progress * 100)}%` }} />
        </div>
        <span className="muted">{Math.round(state.progress * 100)}%</span>
      </div>
    );
  }

  if (state.status === 'ready') {
    return (
      <div className="update">
        <span>Версия {state.version} готова к установке.</span>
        <button onClick={() => window.gorn.update.install()}>Перезапустить</button>
        <span className="muted small">Или просто закройте приложение — обновится само.</span>
      </div>
    );
  }

  // available
  return (
    <div className="update">
      <span>Вышла версия {state.version}.</span>
      {state.supported ? (
        <button onClick={() => void window.gorn.update.download()}>Загрузить</button>
      ) : (
        <>
          <span className="muted small">
            Портативная версия не обновляется сама —{' '}
            <a
              href="https://github.com/lanqvist/gorn-tli/releases/latest"
              target="_blank"
              rel="noreferrer"
            >
              скачайте новую с GitHub
            </a>
            .
          </span>
          {/* Внутри приложения с этой новостью сделать нечего — полосе нужен способ уйти. */}
          <button className="update-close" title="Скрыть" onClick={() => setDismissed(true)}>
            ✕
          </button>
        </>
      )}
    </div>
  );
}
