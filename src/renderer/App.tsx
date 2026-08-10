import { useEffect, useState } from 'react';

import type { RetroScanProgress } from '../core/retroScan.js';
import type { RunView, Snapshot } from '../main/engine.js';
import type { UpdateState } from '../main/updater.js';
import { Fe, FeIcon } from './components/Fe.js';
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
  const [scanProgress, setScanProgress] = useState<RetroScanProgress | null>(null);
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
      <Header snapshot={snapshot} />
      <Hero snapshot={snapshot} />
      <div className="columns">
        <CurrentRun snapshot={snapshot} now={now} />
        <Sidebar snapshot={snapshot} />
      </div>
      <Strategies snapshot={snapshot} />
      <RecentRuns runs={snapshot.recent} median={snapshot.norm} />
      <MissingPrices snapshot={snapshot} />
      <Diagnostics snapshot={snapshot} />
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
          ? 'На карте'
          : snapshot.status === 'idle'
            ? 'Ожидание'
            : 'Игра не найдена'}
        {snapshot.hint && <span className="hint">{snapshot.hint}</span>}
      </div>
      <div className="header-right">
        <NameLanguageSwitch />
        <OverlayButton />
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

  if (!window.gorn) return null;

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
          onClick={() => void window.gorn.setItemNames(value).then(setLanguage)}
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
 * Главный блок. Медиана крупно, среднее рядом мелко — сознательно:
 * среднее в ARPG задирается одной редкой находкой и описывает забег,
 * которого не бывает. Под числом всегда видно, насколько ему верить.
 */
function Hero({ snapshot }: { snapshot: Snapshot }) {
  const { rate, feRate, totals } = snapshot;
  const conf = CONFIDENCE[rate.confidence];
  const spread = rate.p75 - rate.p25;
  // «Вложено 0» при потраченном маяке выглядит как поломка. Причина обычно
  // одна: у расходника нет цены, и вычесть нечего.
  const unpricedCost = snapshot.missing.find((m) => m.isCost);

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
        {/* Накопительный темп: двигается при подборе, медиана — намеренно нет.
            Подпись «за сессию» важна, иначе медленное сползание между
            подборами выглядит как ошибка, а не как рост знаменателя. */}
        <Tile label="За сессию, в час" value={<Fe value={snapshot.liveRate} />} live />
        <Tile label="Чистый ФЕ в час" value={<Fe value={feRate.median} />} />
        <Tile label="На картах" value={duration(totals.inMapMs)} />
        <Tile
          label="Вложено"
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
}: {
  label: string;
  value: React.ReactNode;
  live?: boolean;
  /** Пояснение, почему цифре нельзя верить как есть. */
  warn?: string;
}) {
  return (
    <div className={`tile ${live ? 'tile-live' : ''} ${warn ? 'tile-warn' : ''}`}>
      <div className="tile-label">
        {label}
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
      return (
        <section className="card current empty">
          <h2>Текущий забег</h2>
          <p className="muted">{snapshot.hint ?? 'Ждём вход на карту.'}</p>
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
          const conf = CONFIDENCE[s.rate.confidence];
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
                <span className={`badge badge-${conf.tone}`}>{conf.label}</span>
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
function Diagnostics({ snapshot }: { snapshot: Snapshot }) {
  const { unknownProtos, pricedItems, communityPrices, communityEnabled } =
    snapshot.diagnostics;

  return (
    <section className="card diag">
      <h2>Самодиагностика</h2>
      {/* Маркер относится к своей строке, а не к общему состоянию:
          иначе справочная строка выглядит как проблема. */}
      <div className="diag-row">
        <span className="ok">✓</span>
        <span>Своих пробивок: {num(pricedItems)}</span>
      </div>
      <div className="diag-row">
        <span className={communityEnabled ? 'ok' : 'muted'}>
          {communityEnabled ? '✓' : '·'}
        </span>
        <span>
          {communityEnabled
            ? `Цен из базы сообщества: ${num(communityPrices)}`
            : 'Цены сообщества выключены — только свои пробивки.'}
        </span>
        <CommunityPricesToggle enabled={communityEnabled} />
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

/**
 * Первичные цены — из краудсорс-базы TITrack. Свои пробивки в приоритете.
 * Отключение — для тех, кто хочет полностью офлайновый трекер.
 */
function CommunityPricesToggle({ enabled }: { enabled: boolean }) {
  if (!window.gorn) return null;
  return (
    <button
      className="diag-toggle"
      title={
        enabled
          ? 'Отключить загрузку цен сообщества (titrack.ninja). Останутся только ваши пробивки.'
          : 'Включить первичные цены из базы сообщества (titrack.ninja).'
      }
      onClick={() => void window.gorn.setCommunityPrices(!enabled)}
    >
      {enabled ? 'выключить' : 'включить'}
    </button>
  );
}
