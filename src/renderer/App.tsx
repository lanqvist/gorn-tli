import { useEffect, useState } from 'react';

import type { RunView, Snapshot } from '../main/engine.js';
import { Fe, FeIcon } from './components/Fe.js';
import { FIND, pluralize, RUN } from '../core/plural.js';

const NBSP = ' ';

const num = (v: number, digits = 0) =>
  new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
    .format(v)
    .replace(/\s/g, NBSP);

function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}${NBSP}ч ${m}${NBSP}м` : `${h}${NBSP}ч`;
  if (m > 0) return s > 0 ? `${m}${NBSP}м ${s}${NBSP}с` : `${m}${NBSP}м`;
  return `${s}${NBSP}с`;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const time = (ts: number) =>
  new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));

/**
 * Сколько карта должна идти, прежде чем показывать сравнение темпа
 * с обычным. Меньше минуты знаменатель слишком мал: одна находка
 * даёт скачок в сотни процентов.
 */
const WARMUP_MS = 60_000;

const CONFIDENCE = {
  insufficient: { label: 'данных мало', tone: 'weak' },
  emerging: { label: 'есть картина', tone: 'mid' },
  solid: { label: 'надёжно', tone: 'good' },
} as const;

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    // В браузере main-процесса нет — показываем демо-данные, чтобы вёрстку
    // можно было проверять без запуска Electron.
    if (!window.gorn) {
      if (import.meta.env.DEV) {
        void import('./demo.js').then((m) => setSnapshot(m.demoSnapshot));
      }
      return;
    }
    void window.gorn.getSnapshot().then((s) => s && setSnapshot(s));
    return window.gorn.onSnapshot(setSnapshot);
  }, []);

  // Таймер текущего забега должен идти, даже когда в лог ничего не падает.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!snapshot) {
    return (
      <div className="boot">
        <div className="boot-spark" />
        <p>Разбираю логи…</p>
      </div>
    );
  }

  return (
    <div className="app">
      <Header snapshot={snapshot} />
      <Hero snapshot={snapshot} />
      <div className="columns">
        <CurrentRun snapshot={snapshot} now={now} />
        <Sidebar snapshot={snapshot} />
      </div>
      <RecentRuns runs={snapshot.recent} median={snapshot.rate.median} />
      <Diagnostics snapshot={snapshot} />
    </div>
  );
}

function Header({ snapshot }: { snapshot: Snapshot }) {
  const dot =
    snapshot.status === 'running' ? 'live' : snapshot.status === 'idle' ? 'idle' : 'lost';
  return (
    <header className="header">
      <div className="brand">
        <FeIcon />
        <span>Горн</span>
      </div>
      <div className={`status status-${dot}`}>
        <i />
        {snapshot.status === 'running'
          ? 'В карте'
          : snapshot.status === 'idle'
            ? 'Ожидание'
            : 'Игра не найдена'}
        {snapshot.hint && <span className="hint">{snapshot.hint}</span>}
      </div>
      <div className="header-right">
        <OverlayButton />
        {snapshot.seasonId && <span className="season">Сезон {snapshot.seasonId}</span>}
      </div>
    </header>
  );
}

function OverlayButton() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!window.gorn) return;
    void window.gorn.overlay.getState().then((s) => setOpen(s.enabled));
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

/**
 * Главный блок. Медиана крупно, среднее рядом мелко — сознательно:
 * среднее в ARPG задирается одной редкой находкой и описывает забег,
 * которого не бывает. Под числом всегда видно, насколько ему верить.
 */
function Hero({ snapshot }: { snapshot: Snapshot }) {
  const { rate, feRate, totals } = snapshot;
  const conf = CONFIDENCE[rate.confidence];
  const spread = rate.p75 - rate.p25;

  return (
    <section className="hero">
      <div className="hero-main">
        <div className="hero-label">Добыча в час, за вычетом вложений</div>
        <div className="hero-value">
          <Fe value={rate.median} />
        </div>
        <div className="hero-sub">
          <span className={`badge badge-${conf.tone}`}>{conf.label}</span>
          <span>{pluralize(rate.sampleSize, RUN)}</span>
          <span className="muted">
            обычный разброс {num(rate.p25)}–{num(rate.p75)}
          </span>
          <span className="muted">среднее {num(rate.mean)}</span>
        </div>
        {rate.sampleSize > 0 && spread > rate.median * 0.8 && (
          <p className="note">
            Забеги сильно различаются: разброс шире самой медианы. Цифра станет
            устойчивой после {pluralize(rate.sampleSize < 15 ? 15 : 50, RUN)}.
          </p>
        )}
        {rate.topShare > 0.3 && rate.sampleSize > 1 && (
          <p className="note warn">
            Один забег дал {Math.round(rate.topShare * 100)}% всей добычи — среднее держится
            на нём, медиана нет.
          </p>
        )}
      </div>

      <div className="hero-tiles">
        {/* «Сейчас» двигается при каждом подборе, медиана — намеренно нет. */}
        <Tile label="Сейчас, в час" value={<Fe value={snapshot.liveRate} />} live />
        <Tile label="Чистый ФЕ в час" value={<Fe value={feRate.median} />} />
        <Tile label="В картах" value={duration(totals.inMapMs)} />
        <Tile label="Вложено" value={<Fe value={totals.costFe} />} />
      </div>
    </section>
  );
}

/**
 * Иконка предмета. Загрузка может не удаться: нет интернета при первом показе
 * либо предмета нет в справочнике. Тогда остаётся пустое место того же
 * размера — строка не съезжает.
 */
function ItemIcon({ src }: { src: string | null }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <span className="no-icon" />;
  return <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} />;
}

function Tile({
  label,
  value,
  live = false,
}: {
  label: string;
  value: React.ReactNode;
  live?: boolean;
}) {
  return (
    <div className={`tile ${live ? 'tile-live' : ''}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
    </div>
  );
}

function CurrentRun({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const run = snapshot.current;

  // Карта закончилась — показываем прошлый забег, а не пустую карточку.
  // Иначе добыча исчезает с экрана ровно в тот момент, когда её хотят
  // рассмотреть: сразу после выхода из карты.
  if (!run) {
    const previous = snapshot.recent[0];
    if (!previous) {
      return (
        <section className="card current empty">
          <h2>Текущий забег</h2>
          <p className="muted">{snapshot.hint ?? 'Ждём вход в карту.'}</p>
        </section>
      );
    }
    return <FinishedRun run={previous} />;
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

      <DropList drops={run.drops} />
    </section>
  );
}

/** Последний завершённый забег: держим его на экране, пока не начнётся новый. */
function FinishedRun({ run }: { run: RunView }) {
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

      <DropList drops={run.drops} />
    </section>
  );
}

function DropList({ drops }: { drops: RunView['drops'] }) {
  if (drops.length === 0) return <p className="muted">Ничего не выпало.</p>;
  return (
    <ul className="drops">
      {drops.slice(0, 12).map((d) => (
        <li key={d.configBaseId}>
          <ItemIcon src={d.icon} />
          <span className="drop-name">{d.name}</span>
          <span className="drop-qty">×{num(d.qty)}</span>
          <span className="drop-value">
            {d.totalFe === null ? (
              <span className="muted" title="Цена неизвестна — пробей предмет в Торговом доме">
                без цены
              </span>
            ) : (
              <Fe value={d.totalFe} />
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Блок биржи. Реализованная выручка против бумажной оценки. */
function Sidebar({ snapshot }: { snapshot: Snapshot }) {
  const { realizedFe, realizationRatio, listedPaperFe } = snapshot.totals;

  return (
    <aside className="card side">
      <h2>Торговый дом</h2>
      {/* Обе строки про одно и то же — про выставленный товар. Ставить сюда
          оценку всей добычи нельзя: это несравнимая величина, а рядом
          она читается как отношение. */}
      <div className="side-row">
        <span>Выставлено на сумму</span>
        <Fe value={listedPaperFe} />
      </div>
      <div className="side-row">
        <span>Реально пришло</span>
        <Fe value={realizedFe} />
      </div>

      {realizationRatio !== null && (
        <>
          <div className="ratio">
            <div className="ratio-bar">
              <i style={{ width: `${Math.min(100, realizationRatio * 100)}%` }} />
            </div>
            <div className="ratio-value">{Math.round(realizationRatio * 100)}%</div>
          </div>
          <p className="muted small">
            Столько реально дошло до кармана от того, во что оценивался выставленный товар.
            Разницу съедают комиссия биржи и продажа ниже референсной цены.
          </p>
        </>
      )}
      {realizationRatio === null && (
        <p className="muted small">
          Выстави что-нибудь на биржу и забери выручку — посчитаю, сколько реально доходит
          от бумажной оценки.
        </p>
      )}
    </aside>
  );
}

function RecentRuns({ runs, median }: { runs: RunView[]; median: number }) {
  if (runs.length === 0) return null;

  return (
    <section className="card">
      <h2>Забеги</h2>
      <table className="runs">
        <thead>
          <tr>
            <th>Время</th>
            <th>Карта</th>
            <th className="r">Длительность</th>
            <th className="r">
              Чистыми <FeIcon />
            </th>
            <th className="r">В час</th>
            <th className="r">К норме</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const delta = median > 0 ? Math.round(((r.perHour - median) / median) * 100) : 0;
            return (
              <tr key={`${r.startedAt}-${r.areaId}`}>
                <td className="muted">{time(r.startedAt)}</td>
                <td>{r.name}</td>
                <td className="r muted">{duration(r.durationMs ?? 0)}</td>
                <td className="r">
                  <Fe value={r.netFe} />
                </td>
                <td className="r muted">{num(r.perHour)}</td>
                <td className={`r ${delta >= 0 ? 'up' : 'down'}`}>
                  {median > 0 ? `${delta >= 0 ? '+' : '−'}${Math.abs(delta)}%` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/**
 * Самодиагностика. Формат лога меняется каждый сезон, и трекер должен
 * говорить, что ослеп, а не показывать нули как ни в чём не бывало.
 */
function Diagnostics({ snapshot }: { snapshot: Snapshot }) {
  const { unknownProtos, pricedItems, unpricedDrops } = snapshot.diagnostics;

  return (
    <section className="card diag">
      <h2>Самодиагностика</h2>
      {/* Маркер относится к своей строке, а не к общему состоянию:
          иначе справочная строка выглядит как проблема. */}
      <div className="diag-row">
        <span className="ok">✓</span>
        <span>Предметов с известной ценой: {num(pricedItems)}</span>
      </div>
      {unpricedDrops > 0 && (
        <div className="diag-row">
          <span className="warn">!</span>
          <span>
            {pluralize(unpricedDrops, FIND)} без цены — оценка добычи занижена. Пробей их
            в Торговом доме, цена подхватится сама.
          </span>
        </div>
      )}
      {unknownProtos.length > 0 && (
        <div className="diag-row">
          <span className="warn">!</span>
          <span>
            Незнакомые операции: {unknownProtos.map(([p, n]) => `${p} ×${n}`).join(', ')}.
            Возможно, игра обновилась — сообщи, чтобы я их учёл.
          </span>
        </div>
      )}
    </section>
  );
}
