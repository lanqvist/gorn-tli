import { useEffect, useRef, useState } from 'react';

import type { Snapshot } from '../main/engine.js';
import type { OverlayMode } from '../main/settings.js';
import { Fe, FeIcon } from './components/Fe.js';

type Mode = OverlayMode;

const NBSP = ' ';
const num = (v: number) =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(v).replace(/\s/g, NBSP);

const clock = (ms: number) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/** Порог, до которого темп забега не показывается: знаменатель слишком мал. */
const WARMUP_MS = 60_000;

export function OverlayApp() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [mode, setMode] = useState<Mode>('compact');
  const [locked, setLocked] = useState(true);
  const [now, setNow] = useState(Date.now());
  const root = useRef<HTMLDivElement>(null);

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
    // можно было проверять без запуска игры.
    if (!window.gorn) {
      if (import.meta.env.DEV) {
        void import('./demo.js').then((m) => setSnapshot(m.demoSnapshot));
        setLocked(false);
      }
      return;
    }

    void window.gorn.getSnapshot().then((s) => s && setSnapshot(s));
    void window.gorn.overlay.getState().then((s) => {
      setMode(s.mode);
      setLocked(s.locked);
    });
    const offSnapshot = window.gorn.onSnapshot(setSnapshot);
    const offMode = window.gorn.overlay.onMode((m) => setMode(m));
    const offLocked = window.gorn.overlay.onLocked(setLocked);
    return () => {
      offSnapshot();
      offMode();
      offLocked();
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

  return (
    <div ref={root} className={`ov ov-${mode} ${locked ? 'ov-locked' : 'ov-free'}`}>
      {/* Полоска для перетаскивания видна только в разблокированном режиме:
          в заблокированном клики всё равно уходят в игру. */}
      {!locked && (
        <div className="ov-grip">
          <span>Горн</span>
          <div className="ov-actions">
            <button onClick={() => window.gorn.overlay.cycleMode()} title="Режим">
              ⇱
            </button>
            <button onClick={() => window.gorn.overlay.toggleLock()} title="Закрепить">
              ⌖
            </button>
            <button onClick={() => window.gorn.overlay.close()} title="Закрыть">
              ✕
            </button>
          </div>
        </div>
      )}

      <div className="ov-line">
        <span className="ov-rate">
          <Fe value={median} />
          <em>/час</em>
        </span>
        {run ? (
          <span className="ov-timer">{clock(elapsed)}</span>
        ) : (
          <span className="ov-timer ov-idle">не в карте</span>
        )}
      </div>

      {mode !== 'minimal' && shown && (
        <>
          <div className="ov-run">
            <span className="ov-map">{shown.name}</span>
            <span className="ov-net">
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
            {snapshot.totals.runs} забегов · <FeIcon />
            {NBSP}
            {num(snapshot.totals.valueFe - snapshot.totals.costFe)}
          </span>
          <span className="ov-conf">{confidence(snapshot)}</span>
        </div>
      )}
    </div>
  );
}

function confidence(snapshot: Snapshot): string {
  switch (snapshot.rate.confidence) {
    case 'insufficient':
      return 'данных мало';
    case 'emerging':
      return 'есть картина';
    default:
      return 'надёжно';
  }
}
