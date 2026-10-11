import { useEffect, useState } from 'react';

import { RUN, pluralize } from '../../core/plural.js';
import type { Snapshot } from '../../main/engine.js';
import { ago } from '../format.js';
import { FeIcon } from './Fe.js';
import { Tip } from './ui.js';

export function Header({
  snapshot,
  now,
  onOpenSettings,
}: {
  snapshot: Snapshot;
  now: number;
  onOpenSettings: () => void;
}) {
  const dot =
    snapshot.status === 'running' ? 'live' : snapshot.status === 'idle' ? 'idle' : 'lost';

  // «Трекер жив»: возраст последнего распознанного события лога.
  // Считается на клиенте от тикающего now — снапшоту не нужно тикать самому.
  const age = snapshot.lastActivityAt > 0 ? Math.max(0, now - snapshot.lastActivityAt) : null;
  const showAge = age !== null && (snapshot.status === 'running' || age < 600_000);
  const ageTone =
    age === null ? '' : age < 15_000 ? 'fresh' : age < 60_000 ? 'ok' : 'stale';

  return (
    <header className="header">
      <div className="brand">
        <FeIcon />
        <span>Горн</span>
      </div>
      <div
        className={`status status-${dot} ${age !== null && age < 3_000 ? 'status-pulse' : ''}`}
      >
        <i />
        {snapshot.status === 'running'
          ? 'На карте'
          : snapshot.status === 'idle'
            ? 'Ожидание'
            : 'Игра не найдена'}
        {showAge && <span className={`log-age log-age-${ageTone}`}>лог {ago(age)}</span>}
        {snapshot.hint && <span className="hint">{snapshot.hint}</span>}
      </div>
      <PlayerChip player={snapshot.player} />
      <PlayerFilter snapshot={snapshot} />
      <div className="header-right">
        <OverlayButton />
        <button className="overlay-toggle" title="Настройки" onClick={onOpenSettings}>
          ⚙ Настройки
        </button>
        {snapshot.seasonId && <span className="season">Сезон {snapshot.seasonId}</span>}
      </div>
    </header>
  );
}

/**
 * Кем зашли в игру: ник, класс и уровень.
 *
 * После перезапуска игры персонаж неизвестен до следующего входа —
 * тогда чип просто не показывается, а не врёт прошлым значением.
 */
function PlayerChip({ player }: { player: Snapshot['player'] }) {
  if (!player) return null;
  const parts = [
    player.heroName,
    player.level !== null ? `${player.level} ур.` : null,
  ].filter(Boolean);
  return (
    <Tip tip="Персонаж, которым зашли в игру, — из лога. Новые забеги записываются на него.">
      <span className="player-chip">
        <span className="player-chip-name">{player.name ?? 'Персонаж'}</span>
        {parts.length > 0 && <span className="player-chip-meta">{parts.join(' · ')}</span>}
      </span>
    </Tip>
  );
}

/**
 * Фильтр по персонажу: медиана, стратегии и история — только его забеги.
 *
 * У разных героев разные билды и дроп; смешивать их медианы — то самое
 * «среднее по больнице», против которого весь проект. Показывается только
 * когда персонажей больше одного: единственному фильтровать нечего.
 */
function PlayerFilter({ snapshot }: { snapshot: Snapshot }) {
  const { players, playerFilter } = snapshot;
  if (players.length < 2 && playerFilter === null) return null;

  // У персонажа из оборванного лога может не быть профиля — только id.
  // Голое 18-значное число в выпадашке нечитаемо, показываем хвост.
  const label = (p: Snapshot['players'][number]) =>
    [
      p.heroName ?? p.name ?? `Персонаж …${p.playerId.slice(-5)}`,
      p.level !== null ? `${p.level} ур.` : null,
    ]
      .filter(Boolean)
      .join(' · ');

  return (
    <select
      className="player-filter"
      value={playerFilter ?? ''}
      title="Чьи забеги показывать. Влияет на все цифры, кроме Торгового дома. Забеги из логов до этой версии видны только в «Все персонажи»."
      onChange={(e) => {
        const value = e.target.value === '' ? null : e.target.value;
        void window.gorn?.setPlayerFilter(value);
      }}
    >
      <option value="">Все персонажи</option>
      {players.map((p) => (
        <option key={p.playerId} value={p.playerId}>
          {label(p)} — {pluralize(p.runs, RUN)}
        </option>
      ))}
    </select>
  );
}

function OverlayButton() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!window.gorn) return;
    void window.gorn.overlay.getState().then((s) => setOpen(s.enabled));
    // Оверлей переключается и хоткеем, и собственным крестиком — кнопка
    // обязана узнавать об этом, а не помнить только свой последний клик.
    return window.gorn.overlay.onEnabled(setOpen);
  }, []);

  if (!window.gorn) return null;

  return (
    <button
      className={`overlay-toggle ${open ? 'on' : ''}`}
      onClick={() => void window.gorn.overlay.toggle().then(setOpen)}
      title="Ctrl+Alt+G — показать или убрать оверлей поверх игры"
    >
      {open ? 'Оверлей включён' : 'Оверлей'}
    </button>
  );
}
