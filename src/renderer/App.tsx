import { useEffect, useState } from 'react';

import type { RetroScanProgress } from '../core/retroScan.js';
import type { RunView, Snapshot } from '../main/engine.js';
import type { UpdateState } from '../main/updater.js';
import { Fe, FeIcon } from './components/Fe.js';
import { playTest } from './overlay/sound.js';
import { pluralize, RUN, RUN_IN } from '../core/plural.js';

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

const cacheDate = (ts: number) =>
  new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));

/** Возраст события человеческим языком. */
function ago(ms: number): string {
  if (ms < 8_000) return 'только что';
  if (ms < 60_000) return `${Math.round(ms / 1000)} с назад`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} мин назад`;
  return `${Math.round(ms / 3_600_000)} ч назад`;
}

/**
 * Свой тултип вместо нативного title: тот появляется с секундной задержкой,
 * невидим, пока не догадаешься навести, и не работает с клавиатуры.
 */
function Tip({ tip, children }: { tip: string; children: React.ReactNode }) {
  return (
    <span className="tip" tabIndex={0}>
      {children}
      <span className="tip-pop" role="tooltip">
        {tip}
      </span>
    </span>
  );
}

/**
 * Сколько карта должна идти, прежде чем показывать сравнение темпа
 * с обычным. Меньше минуты знаменатель слишком мал: одна находка
 * даёт скачок в сотни процентов.
 */
const WARMUP_MS = 60_000;

const CONFIDENCE = {
  insufficient: {
    label: 'данных мало',
    tone: 'weak',
    tip: 'Меньше 15 забегов — цифра ещё гуляет от каждой находки.',
  },
  emerging: {
    label: 'есть картина',
    tone: 'mid',
    tip: 'От 15 забегов — картина складывается, но редкие дорогие находки ещё недооценены.',
  },
  solid: { label: 'надёжно', tone: 'good', tip: 'От 50 забегов — медиане можно верить.' },
} as const;

function ConfidenceBadge({ level }: { level: keyof typeof CONFIDENCE }) {
  const conf = CONFIDENCE[level];
  return (
    <Tip tip={conf.tip}>
      <span className={`badge badge-${conf.tone}`}>{conf.label}</span>
    </Tip>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [scanProgress, setScanProgress] = useState<RetroScanProgress | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
    const offSnapshot = window.gorn.onSnapshot(setSnapshot);
    const offScan = window.gorn.onScanProgress(setScanProgress);
    return () => {
      offSnapshot();
      offScan();
    };
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
        {/* На большой пачке логов без живой цифры заглушка неотличима
            от зависания. */}
        {scanProgress && (
          <p className="muted small">
            Файл {scanProgress.index + 1} из {scanProgress.total}
            {scanProgress.runsFound > 0 && (
              <> · найдено {pluralize(scanProgress.runsFound, RUN)}</>
            )}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <UpdateBanner />
      <Header snapshot={snapshot} now={now} onOpenSettings={() => setSettingsOpen(true)} />
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      <Hero snapshot={snapshot} />
      <SessionRecords snapshot={snapshot} />
      <div className="columns">
        <CurrentRun snapshot={snapshot} now={now} />
        <Sidebar snapshot={snapshot} />
      </div>
      <Strategies snapshot={snapshot} />
      <RecentRuns snapshot={snapshot} />
      <MissingPrices snapshot={snapshot} />
      <Diagnostics snapshot={snapshot} now={now} />
    </div>
  );
}

/**
 * Полоса обновления.
 *
 * Показывается только когда есть что сообщить. Загрузка начинается
 * по кнопке, а не сама: трафик игрока — его дело. Установка тоже по кнопке,
 * потому что перезапуск посреди фарма недопустим.
 */
function UpdateBanner() {
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

function Header({
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
 * Язык названий предметов.
 *
 * Русские покрывают 96% справочника, но часть игроков привыкла к английским
 * — по ним ищут на бирже и в гайдах. Режим «оба» показывает и то и другое.
 */
function NameLanguageSwitch() {
  const [language, setLanguage] = useState<NameLanguage>('ru');

  useEffect(() => {
    if (!window.gorn) return;
    void window.gorn.getItemNames().then(setLanguage);
  }, []);

  const options: Array<[NameLanguage, string, string]> = [
    ['ru', 'Рус', 'Русские названия предметов'],
    ['en', 'Eng', 'Английские названия — как в гайдах и на бирже'],
    ['both', 'Оба', 'Русское и английское рядом'],
  ];

  return (
    <div className="lang-switch" role="group" aria-label="Язык названий предметов">
      {options.map(([value, label, hint]) => (
        <button
          key={value}
          className={language === value ? 'on' : ''}
          title={hint}
          onClick={() => {
            if (!window.gorn) return setLanguage(value);
            void window.gorn.setItemNames(value).then(setLanguage);
          }}
        >
          {label}
        </button>
      ))}
    </div>
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

/**
 * Рекорды по последним забегам: дешёвая радость без гринд-давления.
 * Всё считается из среза на клиенте — движку эта полоска не стоит ничего.
 */
function SessionRecords({ snapshot }: { snapshot: Snapshot }) {
  const runs = snapshot.recent;
  if (runs.length < 5) return null;

  const best = runs.reduce((a, r) => (r.perHour > a.perHour ? r : a));

  // Стрик: сколько свежих забегов подряд держатся выше нормы.
  let streak = 0;
  if (snapshot.norm > 0) {
    for (const r of runs) {
      if (r.perHour >= snapshot.norm) streak++;
      else break;
    }
  }

  let find: { name: string; fe: number } | null = null;
  for (const r of runs) {
    for (const d of r.drops) {
      if (d.unitFe !== null && (find === null || d.unitFe > find.fe)) {
        find = { name: d.name, fe: d.unitFe };
      }
    }
  }

  return (
    <div className="records">
      <span className="records-item">
        <span className="records-label">лучший забег</span>
        {num(best.perHour)} ФЕ/час · {best.name}
      </span>
      {find && (
        <span className="records-item">
          <span className="records-label">дорогая находка</span>
          {find.name} · <Fe value={find.fe} />
        </span>
      )}
      {streak >= 2 && (
        <span className="records-item records-streak">
          <span className="records-label">стрик выше нормы</span>
          {pluralize(streak, RUN)} подряд
        </span>
      )}
    </div>
  );
}

/**
 * Спарклайн темпа: последние забеги в хронологии. Полоса — P25–P75
 * («обычный разброс»), пунктир — медиана, точка — самый свежий забег.
 * Один взгляд отвечает на «расту я или проседаю» лучше таблицы.
 */
function RateSparkline({ snapshot }: { snapshot: Snapshot }) {
  const runs = [...snapshot.recent].reverse();
  if (runs.length < 5) return null;

  const values = runs.map((r) => r.perHour);
  const { p25, p75, median } = snapshot.rate;
  const w = 300;
  const h = 54;
  const pad = 5;
  const max = Math.max(...values, p75);
  const min = Math.min(...values, p25, 0);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (values.length - 1)) * (w - pad * 2);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - pad * 2);
  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const last = values.length - 1;

  return (
    <div className="spark">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        width={w}
        height={h}
        role="img"
        aria-label={`Темп последних ${values.length} забегов, ФЕ в час`}
      >
        {/* Обычный разброс: половина забегов внутри этой полосы. */}
        <rect
          x={pad}
          y={y(p75)}
          width={w - pad * 2}
          height={Math.max(2, y(p25) - y(p75))}
          className="spark-band"
        />
        <line x1={pad} x2={w - pad} y1={y(median)} y2={y(median)} className="spark-median" />
        <polyline points={points} className="spark-line" />
        <circle cx={x(last)} cy={y(values[last]!)} r={3} className="spark-dot" />
        {/* Невидимые увеличенные цели наведения: подсказка на каждую точку. */}
        {values.map((v, i) => (
          <circle key={i} cx={x(i)} cy={y(v)} r={7} fill="transparent">
            <title>{`${time(runs[i]!.startedAt)} · ${runs[i]!.name}: ${num(v)} ФЕ/час`}</title>
          </circle>
        ))}
      </svg>
      <span className="spark-caption muted small">
        темп последних {pluralize(values.length, RUN)}
      </span>
    </div>
  );
}

/**
 * Мини-распределение темпа по забегам: текст «разброс шире медианы»
 * становится картинкой. Пунктир — медиана; корзина с самым удачным
 * забегом горит акцентом, когда на нём держится заметная доля дохода.
 */
function RateHistogram({ snapshot }: { snapshot: Snapshot }) {
  const rates = snapshot.recent.map((r) => r.perHour);
  if (rates.length < 8) return null;

  const BIN_COUNT = 12;
  const max = Math.max(...rates);
  const min = Math.min(...rates, 0);
  const span = max - min || 1;
  const bins = new Array<number>(BIN_COUNT).fill(0);
  for (const v of rates) {
    const idx = Math.min(BIN_COUNT - 1, Math.floor(((v - min) / span) * BIN_COUNT));
    bins[idx] = (bins[idx] ?? 0) + 1;
  }
  const top = Math.max(...bins);
  const bestBin = Math.min(BIN_COUNT - 1, Math.floor(((max - min) / span) * BIN_COUNT));
  const highlightBest = snapshot.rate.topShare > 0.3;
  const medianX = ((snapshot.rate.median - min) / span) * 100;

  const w = 160;
  const h = 40;
  const gap = 2;
  const barW = (w - gap * (BIN_COUNT - 1)) / BIN_COUNT;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      className="hist"
      role="img"
      aria-label="Распределение темпа по забегам"
    >
      {bins.map((count, i) => {
        const barH = count === 0 ? 0 : Math.max(3, (count / top) * (h - 4));
        const lo = min + (span * i) / BIN_COUNT;
        const hi = min + (span * (i + 1)) / BIN_COUNT;
        return (
          <rect
            key={i}
            x={i * (barW + gap)}
            y={h - barH}
            width={barW}
            height={barH}
            rx={1.5}
            className={
              highlightBest && i === bestBin && count > 0 ? 'hist-bar hist-bar-top' : 'hist-bar'
            }
          >
            <title>{`${num(lo)}–${num(hi)} ФЕ/час: ${pluralize(count, RUN)}`}</title>
          </rect>
        );
      })}
      <line
        x1={`${medianX}%`}
        x2={`${medianX}%`}
        y1={0}
        y2={h}
        className="hist-median"
      >
        <title>{`медиана ${num(snapshot.rate.median)} ФЕ/час`}</title>
      </line>
    </svg>
  );
}

/**
 * Панель настроек — единственное место, где собраны все ручки.
 *
 * До неё настройки были размазаны: язык в шапке, цены сообщества
 * в самодиагностике, звук и плашки — на полоске откреплённого оверлея,
 * а громкость и прозрачность не имели контролов вовсе. Игрок, который
 * хочет «сделать потише», должен находить это за один клик.
 */
function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [prefs, setPrefs] = useState({
    popups: true,
    sound: true,
    volume: 0.5,
    soundImportantOnly: false,
    jackpotFe: 50,
    fontScale: 1,
    opacity: 0.9,
    goalFe: 0,
  });
  const [sys, setSys] = useState<GornAppSettings | null>(null);
  const [community, setCommunity] = useState(true);
  const [logDirNote, setLogDirNote] = useState<string | null>(null);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [updState, setUpdState] = useState<UpdateState | null>(null);
  const [updChecked, setUpdChecked] = useState(false);

  const refreshSys = () => {
    void window.gorn?.settings.get().then(setSys);
  };

  useEffect(() => {
    if (!window.gorn) return;
    void window.gorn.overlay.getState().then((s) => {
      setPrefs({
        popups: s.popups ?? true,
        sound: s.sound ?? true,
        volume: s.volume ?? 0.5,
        soundImportantOnly: s.soundImportantOnly ?? false,
        jackpotFe: s.jackpotFe ?? 50,
        fontScale: s.fontScale ?? 1,
        opacity: s.opacity ?? 0.9,
        goalFe: s.goalFe ?? 0,
      });
    });
    refreshSys();
    void window.gorn.getCommunityPrices().then(setCommunity);
    return window.gorn.update.onState(setUpdState);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Прозрачность идёт своим каналом, остальное — общим patchPrefs. */
  const patch = (p: Partial<typeof prefs>) => {
    setPrefs((s) => ({ ...s, ...p }));
    const { opacity, ...rest } = p;
    if (Object.keys(rest).length > 0) window.gorn?.overlay.setPrefs(rest);
    if (opacity !== undefined) window.gorn?.overlay.setOpacity(opacity);
  };

  const soundMode = !prefs.sound ? 'off' : prefs.soundImportantOnly ? 'important' : 'all';
  const setSoundMode = (mode: 'all' | 'important' | 'off') =>
    patch({ sound: mode !== 'off', soundImportantOnly: mode === 'important' });

  const chooseDir = () => {
    void window.gorn?.settings.chooseLogDir().then((r) => {
      if (r.status === 'invalid') {
        setLogDirNote('В выбранной папке нет логов игры — нужна …\\Saved\\Logs или корень установки.');
        return;
      }
      setLogDirNote(null);
      if (r.status === 'needsRestart') setNeedsRestart(true);
      if (r.status !== 'cancelled') refreshSys();
    });
  };

  const resetDir = () => {
    void window.gorn?.settings.resetLogDir().then((r) => {
      setLogDirNote(null);
      if (r.status === 'needsRestart') setNeedsRestart(true);
      refreshSys();
    });
  };

  const updateNote = !updChecked
    ? null
    : updState === null || updState.status === 'checking'
      ? 'проверяю…'
      : updState.status === 'idle'
        ? 'у вас последняя версия'
        : updState.status === 'error'
          ? `не получилось: ${updState.error ?? 'ошибка'}`
          : 'вышла новая версия — смотрите полосу сверху';

  return (
    <>
      <div className="settings-backdrop" onClick={onClose} />
      <aside className="settings-panel" role="dialog" aria-label="Настройки">
        <div className="settings-head">
          <h2>Настройки</h2>
          <button className="update-close" title="Закрыть" onClick={onClose}>
            ✕
          </button>
        </div>

        <section className="set-section">
          <h3>Звук</h3>
          <div className="lang-switch set-seg" role="group" aria-label="Режим звука">
            <button className={soundMode === 'all' ? 'on' : ''} onClick={() => setSoundMode('all')}>
              Все находки
            </button>
            <button
              className={soundMode === 'important' ? 'on' : ''}
              title="Удар молота на золотую находку и итог карты; обычные подборы молчат"
              onClick={() => setSoundMode('important')}
            >
              Только важное
            </button>
            <button className={soundMode === 'off' ? 'on' : ''} onClick={() => setSoundMode('off')}>
              Без звука
            </button>
          </div>
          <label className={`set-row ${prefs.sound ? '' : 'set-disabled'}`}>
            <span>Громкость</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(prefs.volume * 100)}
              disabled={!prefs.sound}
              onChange={(e) => patch({ volume: Number(e.target.value) / 100 })}
              onPointerUp={() => playTest(prefs.volume)}
            />
          </label>
        </section>

        <section className="set-section">
          <h3>Плашки поверх игры</h3>
          <label className="set-row">
            <span>Всплывающий доход у центра экрана</span>
            <input
              type="checkbox"
              checked={prefs.popups}
              onChange={(e) => patch({ popups: e.target.checked })}
            />
          </label>
          <label className="set-row">
            <span>Золотая плашка и удар молота</span>
            <select
              value={String(prefs.jackpotFe)}
              onChange={(e) => patch({ jackpotFe: Number(e.target.value) })}
            >
              <option value="0">авто — дорогое для сезона</option>
              <option value="10">от 10 ФЕ — почти на всё</option>
              <option value="50">от 50 ФЕ</option>
              <option value="200">от 200 ФЕ — только дорогое</option>
              {![0, 10, 50, 200].includes(prefs.jackpotFe) && (
                <option value={String(prefs.jackpotFe)}>от {prefs.jackpotFe} ФЕ</option>
              )}
            </select>
          </label>
        </section>

        <section className="set-section">
          <h3>Оверлей</h3>
          <label className="set-row">
            <span>Прозрачность</span>
            <input
              type="range"
              min={25}
              max={100}
              value={Math.round(prefs.opacity * 100)}
              onChange={(e) => patch({ opacity: Number(e.target.value) / 100 })}
            />
          </label>
          <label className="set-row">
            <span>Масштаб</span>
            <input
              type="range"
              min={80}
              max={160}
              step={10}
              value={Math.round(prefs.fontScale * 100)}
              onChange={(e) => patch({ fontScale: Number(e.target.value) / 100 })}
            />
          </label>
          <label className="set-row">
            <span title="Оверлей покажет полосу прогресса и оценку, сколько ещё фармить при текущем темпе. 0 — выключено.">
              Цель сессии, ФЕ
            </span>
            <input
              type="number"
              min={0}
              step={100}
              className="set-num"
              value={prefs.goalFe}
              onChange={(e) => patch({ goalFe: Math.max(0, Number(e.target.value) || 0) })}
            />
          </label>
          <p className="muted small">
            Ctrl+Alt+G — показать · Ctrl+Alt+L — закрепить · Ctrl+Alt+M — режим
          </p>
          {sys && sys.busyHotkeys.length > 0 && (
            <p className="note warn">
              {sys.busyHotkeys.join(', ')} — занято другой программой, сочетание
              не сработает. Управляйте оверлеем кнопками из этого окна.
            </p>
          )}
          <p className="muted small">
            Не видно оверлея в игре? Переключите её в безрамочный режим —
            эксклюзивный полный экран перекрыть нельзя.
          </p>
        </section>

        <section className="set-section">
          <h3>Названия предметов</h3>
          <div className="set-row">
            <span>Язык</span>
            <NameLanguageSwitch />
          </div>
          <label className="set-row">
            <span title="Первичные цены из базы сообщества TITrack (titrack.ninja). Свои пробивки всегда в приоритете.">
              Цены сообщества
            </span>
            <input
              type="checkbox"
              checked={community}
              onChange={(e) => {
                setCommunity(e.target.checked);
                void window.gorn?.setCommunityPrices(e.target.checked);
              }}
            />
          </label>
        </section>

        <section className="set-section">
          <h3>Данные</h3>
          <div className="set-dir">
            <span className="muted small">Папка логов:</span>
            <span className="set-path" title={sys?.resolvedLogDir ?? undefined}>
              {sys?.logDir ?? sys?.resolvedLogDir ?? 'не найдена'}
              {!sys?.logDir && sys?.resolvedLogDir && (
                <span className="muted"> · найдена автоматически</span>
              )}
            </span>
          </div>
          <div className="set-actions">
            <button className="set-btn" onClick={chooseDir}>
              Указать папку…
            </button>
            {sys?.logDir && (
              <button className="set-btn" onClick={resetDir}>
                Вернуть автопоиск
              </button>
            )}
          </div>
          {logDirNote && <p className="note warn">{logDirNote}</p>}
          {needsRestart && (
            <p className="note warn">
              Папка сменится после перезапуска.{' '}
              <button className="set-btn" onClick={() => window.gorn?.settings.relaunch()}>
                Перезапустить сейчас
              </button>
            </p>
          )}
        </section>

        <section className="set-section">
          <h3>Система</h3>
          <label className="set-row">
            <span>Запускать вместе с Windows</span>
            <input
              type="checkbox"
              checked={sys?.autoStart ?? false}
              onChange={(e) => {
                void window.gorn?.settings.setAutoStart(e.target.checked).then(refreshSys);
              }}
            />
          </label>
          <label className="set-row">
            <span title="Закрытие окна сворачивает трекер в трей — оверлей и подсчёт продолжают работать">
              Закрывать в трей
            </span>
            <input
              type="checkbox"
              checked={sys?.closeToTray ?? false}
              onChange={(e) => {
                void window.gorn?.settings.setCloseToTray(e.target.checked).then(refreshSys);
              }}
            />
          </label>
          <div className="set-row">
            <span className="muted">Горн {sys?.version ? `v${sys.version}` : ''}</span>
            <span className="set-update">
              {updateNote && <span className="muted small">{updateNote}</span>}
              <button
                className="set-btn"
                onClick={() => {
                  setUpdChecked(true);
                  void window.gorn?.update.check();
                }}
              >
                Проверить обновления
              </button>
            </span>
          </div>
        </section>
      </aside>
    </>
  );
}

/**
 * Главный блок. Медиана крупно, среднее рядом мелко — сознательно:
 * среднее в ARPG задирается одной редкой находкой и описывает забег,
 * которого не бывает. Под числом всегда видно, насколько ему верить.
 */
function Hero({ snapshot }: { snapshot: Snapshot }) {
  const { rate, feRate, totals } = snapshot;
  const spread = rate.p75 - rate.p25;
  // «Вложено 0» при потраченном маяке выглядит как поломка. Причина обычно
  // одна: у расходника нет цены, и вычесть нечего.
  const unpricedCost = snapshot.missing.find((m) => m.isCost);

  return (
    <section className="hero">
      <div className="hero-main">
        <div className="hero-label">
          <Tip tip="Оценка всей добычи по ценам (свои пробивки + база сообщества) минус вложения в карты. Медиана по забегам: устойчива к одной редкой дорогой находке.">
            Добыча в час, за вычетом вложений
          </Tip>
        </div>
        <div className="hero-value">
          <Fe value={rate.median} />
        </div>
        <div className="hero-sub">
          <ConfidenceBadge level={rate.confidence} />
          <span>{pluralize(rate.sampleSize, RUN)}</span>
          <Tip tip="P25–P75: половина забегов укладывается в эти границы.">
            <span className="muted">
              обычный разброс {num(rate.p25)}–{num(rate.p75)}
            </span>
          </Tip>
          <Tip tip="Среднее задирается одной редкой находкой и описывает забег, которого не бывает. Решения принимайте по медиане.">
            <span className="muted">среднее {num(rate.mean)}</span>
          </Tip>
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
        <RateSparkline snapshot={snapshot} />
      </div>

      <div className="hero-tiles">
        {/* Накопительный темп: двигается при подборе, медиана — намеренно нет.
            Подпись «за сессию» важна, иначе медленное сползание между
            подборами выглядит как ошибка, а не как рост знаменателя. */}
        <Tile
          label="За сессию, в час"
          tip="Накопительный темп: вся добыча сессии ÷ активное время в картах. Двигается при каждом подборе, между подборами медленно сползает — это рост знаменателя, не поломка."
          value={<Fe value={snapshot.liveRate} />}
          live
        />
        <Tile
          label="Чистый ФЕ в час"
          tip="Только сама валюта ФЕ, упавшая в сумку, — без оценки предметов по ценам."
          value={<Fe value={feRate.median} />}
        />
        <Tile
          label="На картах"
          tip="Активное время: паузы дольше трёх минут не идут в зачёт."
          value={duration(totals.inMapMs)}
        />
        <Tile
          label="Вложено"
          tip="Стоимость всего, чем открывались карты: компасы, маяки и прочие расходники."
          value={<Fe value={totals.costFe} />}
          {...(unpricedCost ? { warn: `${unpricedCost.name} без цены` } : {})}
        />
      </div>
    </section>
  );
}

/**
 * Копия в буфер с запасным путём: Clipboard API может быть запрещён
 * политикой окружения, execCommand работает и там.
 */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

/**
 * Имя предмета, копируемое кликом. Цену пробивают поиском на бирже,
 * и перепечатывать «Voidlands Beacon (Timemark 8)» руками — мучение.
 * Подтверждение показывается на месте имени: взгляд уже там.
 */
function CopyName({ name }: { name: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1100);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      className={`drop-name copy-name ${copied ? 'copied' : ''}`}
      title="Скопировать название"
      onClick={() => void copyText(name).then(() => setCopied(true))}
    >
      {copied ? 'Скопировано ✓' : name}
    </button>
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
  warn,
  tip,
}: {
  label: string;
  value: React.ReactNode;
  live?: boolean;
  /** Пояснение, почему цифре нельзя верить как есть. */
  warn?: string;
  /** Что это за метрика — почти одинаковые подписи «в час» требуют слов. */
  tip?: string;
}) {
  const caption = tip ? <Tip tip={tip}>{label}</Tip> : label;
  return (
    <div className={`tile ${live ? 'tile-live' : ''} ${warn ? 'tile-warn' : ''}`}>
      <div className="tile-label">
        {caption}
        {warn && (
          <span className="tile-warn-mark" title={warn}>
            !
          </span>
        )}
      </div>
      <div className="tile-value">{value}</div>
      {warn && <div className="tile-note">{warn}</div>}
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
      // Совсем без данных — это первый запуск: человеку нужны шаги,
      // а не констатация «ждём карту».
      if (snapshot.status === 'searching') return <GameNotFound />;
      return <Onboarding snapshot={snapshot} />;
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
          <CopyName name={d.name} />
          <span className="drop-qty">×{num(d.qty)}</span>
          <span className="drop-value">
            {d.totalFe === null ? (
              <span className="muted" title="Цена неизвестна — пробей предмет в Торговом доме">
                без цены
              </span>
            ) : (
              <span
                {...(d.priceSource === 'community'
                  ? {
                      className: 'price-community',
                      title:
                        'Цена из базы сообщества (titrack.ninja). Пробей предмет сам — своя пробивка точнее и заменит её.',
                    }
                  : {})}
              >
                <Fe value={d.totalFe} />
              </span>
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

      {/* Больше 100% бывает законно: выплаты приходят за лоты, выставленные
          до того, как трекер начал наблюдать. Это не ошибка, но выглядит
          как она, поэтому объясняем прямо. */}
      {realizationRatio !== null && realizationRatio > 1.2 && (
        <p className="muted small">
          Пришло больше, чем оценено выставленное: часть выплат — за лоты,
          выставленные до начала наблюдения. Коэффициент станет осмысленным
          после нескольких полных сделок.
        </p>
      )}

      {realizationRatio !== null && realizationRatio <= 1.2 && (
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

function RecentRuns({ snapshot }: { snapshot: Snapshot }) {
  const runs = snapshot.recent;
  const median = snapshot.norm;
  if (runs.length === 0) return null;

  return (
    <section className="card">
      <div className="runs-head">
        <h2>Забеги</h2>
        <RateHistogram snapshot={snapshot} />
      </div>
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
            <th className="r">
              <Tip tip="Отклонение темпа забега от «нормы» — медианы последних забегов.">
                К норме
              </Tip>
            </th>
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
 * Сравнение стратегий.
 *
 * Стратегия определяется автоматически — по тому, чем открывалась карта.
 * Вложения известны поштучно из лога, поэтому размечать забеги руками
 * не нужно. Рядом с каждой цифрой стоит размер выборки: две стратегии
 * по три забега сравнивать бессмысленно, и это должно быть видно.
 */
function Strategies({ snapshot }: { snapshot: Snapshot }) {
  const { strategies } = snapshot;
  if (strategies.length < 2) return null;

  // Лучшую отмечаем только среди тех, у кого выборка уже что-то значит.
  // Подсвечивать «1 136 в час» на двух забегах — ровно та ошибка,
  // против которой построен весь остальной интерфейс.
  const trustworthy = strategies.filter((s) => s.rate.confidence !== 'insufficient');
  const best = trustworthy.length > 1 ? Math.max(...trustworthy.map((s) => s.rate.median)) : null;

  return (
    <section className="card">
      <h2>Стратегии</h2>
      <div className="strategies">
        {strategies.map((s) => {
          return (
            <div
              key={s.key}
              className={`strategy ${best !== null && s.rate.median === best ? 'best' : ''}`}
            >
              <div className="strategy-head">
                {s.costItems.length > 0 && (
                  <div className="strategy-icons">
                    {s.costItems.map((c) => (
                      <ItemIcon key={c.configBaseId} src={c.icon} />
                    ))}
                  </div>
                )}
                <span className="strategy-title" title={s.title}>
                  {s.title}
                </span>
              </div>

              <div className="strategy-rate">
                <Fe value={s.rate.median} />
                <span className="muted small">в час</span>
              </div>

              <div className="strategy-meta">
                <ConfidenceBadge level={s.rate.confidence} />
                <span className="muted">{pluralize(s.runs, RUN)}</span>
                <span className="muted">
                  разброс {num(s.rate.p25)}–{num(s.rate.p75)}
                </span>
              </div>

              <div className="strategy-money">
                <span>
                  вложено <Fe value={s.costPerRun} /> · чистыми <Fe value={s.netPerRun} />
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <p className="muted small">
        {best === null
          ? 'Стратегия определяется автоматически по тому, чем открыта карта. Пока ни по одной не набралось данных для сравнения — нужно хотя бы 15 забегов.'
          : 'Стратегия определяется автоматически по тому, чем открыта карта. Сравнивайте только при сопоставимом числе забегов.'}
      </p>
    </section>
  );
}

/**
 * Что пробить следующим.
 *
 * Цена берётся из твоих собственных пробивок в Торговом доме, и каждая
 * стоит одного клика. Поэтому важно не количество предметов без цены,
 * а какие из них реально портят оценку.
 */
function MissingPrices({ snapshot }: { snapshot: Snapshot }) {
  const { missing } = snapshot;
  if (missing.length === 0) return null;

  return (
    <section className="card">
      <h2>Пробить цену</h2>
      <p className="muted small">
        Эти предметы падают, но стоимость неизвестна — на них оценка добычи занижена.
        Порядок по влиянию: сверху то, чего выпало больше всего.
      </p>
      <ul className="missing">
        {missing.map((m) => (
          <li key={m.configBaseId}>
            <ItemIcon src={m.icon} />
            <CopyName name={m.name} />
            <span className="drop-qty">{num(m.qty)} шт</span>
            <span className="muted small">в {pluralize(m.runs, RUN_IN)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Самодиагностика. Формат лога меняется каждый сезон, и трекер должен
 * говорить, что ослеп, а не показывать нули как ни в чём не бывало.
 */
function Diagnostics({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const {
    unknownProtos,
    pricedItems,
    communityPrices,
    communityEnabled,
    communityFetchedAt,
    communityStale,
  } = snapshot.diagnostics;

  // Свежесть цен: счётчик «2 154 цены» ничего не говорит о том, не лежат ли
  // они в кэше третий день без сети.
  const freshness = !communityEnabled
    ? null
    : communityStale
      ? ` · нет сети — кэш${communityFetchedAt ? ` от ${cacheDate(communityFetchedAt)}` : ''}`
      : communityFetchedAt
        ? ` · обновлены ${ago(Math.max(0, now - communityFetchedAt))}`
        : null;

  return (
    <section className="card diag">
      <h2>Самодиагностика</h2>
      {/* Маркер относится к своей строке, а не к общему состоянию:
          иначе справочная строка выглядит как проблема. */}
      <div className="diag-row">
        <span className="ok">✓</span>
        <span>Своих пробивок: {num(pricedItems)}</span>
      </div>
      {/* Только факты: ручка включения живёт в настройках. */}
      <div className="diag-row">
        <span className={communityEnabled ? 'ok' : 'muted'}>
          {communityEnabled ? '✓' : '·'}
        </span>
        <span>
          {communityEnabled
            ? `Цен из базы сообщества: ${num(communityPrices)}`
            : 'Цены сообщества выключены — только свои пробивки.'}
          {freshness && <span className="muted">{freshness}</span>}
        </span>
      </div>
      {unknownProtos.length > 0 && (
        <div className="diag-row">
          <span className="warn">!</span>
          <span>
            Незнакомые операции: {unknownProtos.map(([p, n]) => `${p} ×${n}`).join(', ')}.
            Возможно, игра обновилась —{' '}
            <a
              href="https://github.com/lanqvist/gorn-tli/issues"
              target="_blank"
              rel="noreferrer"
            >
              сообщите
            </a>
            , чтобы я их учёл.
          </span>
          <CopyProtosReport snapshot={snapshot} />
        </div>
      )}
    </section>
  );
}

/**
 * Готовый текст для баг-репорта: игроку достаточно вставить его в issue,
 * не переписывая имена протоколов руками.
 */
function CopyProtosReport({ snapshot }: { snapshot: Snapshot }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1100);
    return () => clearTimeout(t);
  }, [copied]);

  const report = [
    `Незнакомые операции в логе (сезон ${snapshot.seasonId ?? '?'}):`,
    ...snapshot.diagnostics.unknownProtos.map(([p, n]) => `- ${p} ×${n}`),
  ].join('\n');

  return (
    <button
      className="diag-toggle"
      title="Скопировать список для баг-репорта"
      onClick={() => void copyText(report).then(() => setCopied(true))}
    >
      {copied ? 'скопировано ✓' : 'скопировать отчёт'}
    </button>
  );
}

