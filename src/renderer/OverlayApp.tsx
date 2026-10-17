import { useEffect, useRef, useState } from 'react';

import { tr } from '../core/i18n.js';
import { RUN, pluralize } from '../core/plural.js';
import type { Snapshot } from '../main/engine.js';
import type { OverlayMode } from '../main/settings.js';
import { Fe, FeIcon } from './components/Fe.js';
import { clock, NBSP, num } from './format.js';

type Mode = OverlayMode;

/** Оценка «ещё столько-то» для цели сессии — грубая, поэтому округлённая. */
const roughEta = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return tr(`${m}${NBSP}м`, `${m}m`);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest > 0
    ? tr(`${h}${NBSP}ч ${rest}${NBSP}м`, `${h}h${NBSP}${rest}m`)
    : tr(`${h}${NBSP}ч`, `${h}h`);
};

/** Порог, до которого темп забега не показывается: знаменатель слишком мал. */
const WARMUP_MS = 60_000;

export function OverlayApp() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [mode, setMode] = useState<Mode>('compact');
  const [locked, setLocked] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [prefs, setPrefs] = useState<GornOverlayPrefs>({
    popups: true,
    sound: true,
    volume: 0.5,
    soundImportantOnly: false,
    jackpotFe: 50,
    whistleFe: 10,
    fontScale: 1,
    goalFe: 0,
  });
  // Автоуклонение: закреплённый оверлей получает mousemove даже с
  // пропуском кликов (forward: true) — при наведении панель гаснет
  // и не мешает целиться, а через полсекунды возвращается.
  const [dodge, setDodge] = useState(false);
  const dodgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return () => {
      if (dodgeTimer.current) clearTimeout(dodgeTimer.current);
    };
  }, []);

  const onDodgeMove = () => {
    setDodge(true);
    if (dodgeTimer.current) clearTimeout(dodgeTimer.current);
    dodgeTimer.current = setTimeout(() => setDodge(false), 500);
  };

  // Окно подгоняется под содержимое: лишняя прозрачная площадь дорого
  // обходится композитору, а высота меняется по ходу забега — строк дропа
  // становится больше.
  useEffect(() => {
    const el = root.current;
    if (!el || !window.gorn) return;
    const observer = new ResizeObserver(() => {
      window.gorn.overlay.reportHeight(el.getBoundingClientRect().height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // В браузере main-процесса нет — показываем демо, чтобы вёрстку оверлея
    // можно было проверять без запуска игры. Подборы имитируются таймером:
    // без изменяющегося среза всплывашки и звук иначе не проверить.
    if (!window.gorn) {
      if (import.meta.env.DEV) {
        let timer: ReturnType<typeof setInterval> | undefined;
        void import('./demo.js').then((m) => {
          let current = m.demoSnapshot;
          setSnapshot(current);
          timer = setInterval(() => {
            const gained = Math.random() < 0.15 ? 55 + Math.random() * 40 : Math.random() * 6;
            const cur = current.current;
            if (!cur) return;
            current = {
              ...current,
              current: {
                ...cur,
                netFe: cur.netFe + gained,
                valueFe: cur.valueFe + gained,
                drops: cur.drops.map((d, i) =>
                  i === (gained > 50 ? 0 : 3)
                    ? {
                        ...d,
                        qty: d.qty + 1,
                        totalFe: (d.totalFe ?? 0) + gained,
                        unitFe: gained,
                      }
                    : d,
                ),
              },
            };
            setSnapshot(current);
          }, 2500);
        });
        setLocked(false);
        return () => timer && clearInterval(timer);
      }
      return;
    }

    void window.gorn.getSnapshot().then((s) => s && setSnapshot(s));
    void window.gorn.overlay.getState().then((s) => {
      setMode(s.mode);
      setLocked(s.locked);
      setPrefs({
        popups: s.popups ?? true,
        sound: s.sound ?? true,
        volume: s.volume ?? 0.5,
        soundImportantOnly: s.soundImportantOnly ?? false,
        jackpotFe: s.jackpotFe ?? 50,
        whistleFe: s.whistleFe ?? 10,
        fontScale: s.fontScale ?? 1,
        goalFe: s.goalFe ?? 0,
      });
    });
    const offSnapshot = window.gorn.onSnapshot(setSnapshot);
    const offMode = window.gorn.overlay.onMode((m) => setMode(m));
    const offLocked = window.gorn.overlay.onLocked(setLocked);
    const offPrefs = window.gorn.overlay.onPrefs(setPrefs);
    return () => {
      offSnapshot();
      offMode();
      offLocked();
      offPrefs();
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const run = snapshot?.current ?? null;
  const previous = snapshot?.recent[0] ?? null;
  const shown = run ?? previous;
  const elapsed = run ? now - run.startedAt : (previous?.durationMs ?? 0);
  const median = snapshot?.rate.median ?? 0;

  const pace = run && elapsed >= WARMUP_MS ? (run.netFe / elapsed) * 3_600_000 : null;
  const delta = pace !== null && median > 0 ? Math.round(((pace - median) / median) * 100) : null;

  // «Тень» прошлого забега: сколько он имел к этой же секунде. Оценка
  // грубая — по его среднему темпу, дроп на деле сыплется рывками, —
  // поэтому подана с тильдой и как справка, а не как метрика.
  const ghost =
    run && previous && previous.durationMs != null && previous.durationMs > 0
      ? previous.netFe * Math.min(1, elapsed / previous.durationMs)
      : null;

  return (
    // Масштаб — через zoom: он растягивает и кегль, и отступы разом,
    // а окну main-процесс даёт пропорциональную ширину.
    <div
      ref={root}
      className={`ov ov-${mode} ${locked ? 'ov-locked' : 'ov-free'} ${
        locked && dodge ? 'ov-dodge' : ''
      }`}
      style={{ zoom: prefs.fontScale }}
      onMouseMove={locked ? onDodgeMove : undefined}
    >
      {/* Полоска для перетаскивания видна только в разблокированном режиме:
          в заблокированном клики всё равно уходят в игру. */}
      {!locked && (
        <div className="ov-grip">
          <span>{tr('Горн', 'Gorn')}</span>
          <div className="ov-actions">
            <button
              onClick={() => window.gorn?.overlay.setPrefs({ popups: !prefs.popups })}
              title={
                prefs.popups
                  ? tr('Выключить всплывашки', 'Turn off popups')
                  : tr('Включить всплывашки', 'Turn on popups')
              }
              className={prefs.popups ? '' : 'ov-off'}
            >
              ✦
            </button>
            <button
              onClick={() => window.gorn?.overlay.setPrefs({ sound: !prefs.sound })}
              title={
                prefs.sound
                  ? tr('Выключить звук', 'Mute sound')
                  : tr('Включить звук', 'Unmute sound')
              }
              className={prefs.sound ? '' : 'ov-off'}
            >
              ♪
            </button>
            <button onClick={() => window.gorn?.overlay.cycleMode()} title={tr('Режим', 'Mode')}>
              ⇱
            </button>
            <button
              onClick={() => window.gorn?.overlay.toggleLock()}
              title={tr('Закрепить', 'Lock')}
            >
              ⌖
            </button>
            <button onClick={() => window.gorn?.overlay.close()} title={tr('Закрыть', 'Close')}>
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Шпаргалка видна ровно тогда, когда оверлей настраивают. */}
      {!locked && (
        <div className="ov-hint">
          {tr(
            'перетащите за полоску · ⌖ или Ctrl+Alt+L — закрепить · Ctrl+Alt+M — режим',
            'drag by the strip · ⌖ or Ctrl+Alt+L — lock · Ctrl+Alt+M — mode',
          )}
        </div>
      )}

      <div className="ov-line">
        <span className="ov-rate">
          <Fe value={median} />
          <em>{tr('/час', '/h')}</em>
        </span>
        {run ? (
          <span className="ov-timer">{clock(elapsed)}</span>
        ) : (
          <span className="ov-timer ov-idle">{tr('не на карте', 'not in a map')}</span>
        )}
      </div>

      {/* Цель сессии: тонкий прогресс с ETA по накопительному темпу.
          Работает и в минимальном режиме — ради него и затевалась. */}
      {prefs.goalFe > 0 && snapshot && (
        <GoalProgress goalFe={prefs.goalFe} snapshot={snapshot} />
      )}

      {mode !== 'minimal' && shown && (
        <>
          <div className="ov-run">
            <span className="ov-map">{shown.name}</span>
            <span className="ov-net">
              {ghost !== null && (
                <em
                  className="ov-ghost"
                  title={tr(
                    'Прошлый забег к этой же секунде — грубо, по его среднему темпу',
                    'The previous run at this same second — rough, based on its average pace',
                  )}
                >
                  {tr('тень', 'ghost')} ~{num(ghost)}
                </em>
              )}
              <Fe value={shown.netFe} />
              {delta !== null && (
                <em className={delta >= 0 ? 'up' : 'down'}>
                  {delta >= 0 ? '+' : '−'}
                  {Math.abs(delta)}%
                </em>
              )}
            </span>
          </div>

          {shown.drops.length > 0 && (
            <ul className="ov-drops">
              {shown.drops.slice(0, mode === 'full' ? 10 : 4).map((d) => (
                <li key={d.configBaseId}>
                  <span className="ov-drop-name">{d.name}</span>
                  <span className="ov-drop-qty">×{num(d.qty)}</span>
                  {d.totalFe !== null && (
                    <span className="ov-drop-fe">
                      <Fe value={d.totalFe} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {mode === 'full' && snapshot && (
        <div className="ov-footer">
          <span>
            {pluralize(snapshot.totals.runs, RUN)}{' '}
            · <FeIcon />
            {NBSP}
            {num(snapshot.totals.valueFe - snapshot.totals.costFe)}
          </span>
          <span className="ov-conf">{confidence(snapshot)}</span>
        </div>
      )}
    </div>
  );
}

function GoalProgress({ goalFe, snapshot }: { goalFe: number; snapshot: Snapshot }) {
  const net = snapshot.totals.valueFe - snapshot.totals.costFe;
  const share = Math.max(0, Math.min(1, net / goalFe));
  const remaining = goalFe - net;
  const etaMs =
    remaining > 0 && snapshot.liveRate > 0 ? (remaining / snapshot.liveRate) * 3_600_000 : null;

  return (
    <div className="ov-goal">
      <div className="ov-goal-bar">
        <i style={{ width: `${share * 100}%` }} />
      </div>
      <span className={`ov-goal-text ${remaining <= 0 ? 'up' : ''}`}>
        {remaining <= 0
          ? tr('цель взята ✓', 'goal reached ✓')
          : `${num(net)} / ${num(goalFe)}${
              etaMs !== null
                ? tr(` · ещё ~${roughEta(etaMs)}`, ` · ~${roughEta(etaMs)} left`)
                : ''
            }`}
      </span>
    </div>
  );
}

function confidence(snapshot: Snapshot): string {
  switch (snapshot.rate.confidence) {
    case 'insufficient':
      return tr('данных мало', 'not enough data');
    case 'emerging':
      return tr('есть картина', 'taking shape');
    default:
      return tr('надёжно', 'reliable');
  }
}
