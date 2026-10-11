import { RUN, pluralize } from '../../core/plural.js';
import type { Snapshot } from '../../main/engine.js';
import { NBSP, cacheDate, duration, num, time } from '../format.js';
import { Fe } from './Fe.js';
import { ConfidenceBadge, Tile, Tip } from './ui.js';

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
 * Главный блок. Медиана крупно, среднее рядом мелко — сознательно:
 * среднее в ARPG задирается одной редкой находкой и описывает забег,
 * которого не бывает. Под числом всегда видно, насколько ему верить.
 */
export function Hero({ snapshot }: { snapshot: Snapshot }) {
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

      <div className="hero-side">
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
            tip="Активное время за сессию: паузы дольше трёх минут не идут в зачёт."
            value={duration(totals.inMapMs)}
          />
          <Tile
            label="Вложено"
            tip="Стоимость всего, чем открывались карты за сессию: компасы, маяки и прочие расходники."
            value={<Fe value={totals.costFe} />}
            {...(unpricedCost ? { warn: `${unpricedCost.name} без цены` } : {})}
          />
        </div>
        <SessionBar snapshot={snapshot} />
      </div>
    </section>
  );
}

/**
 * Границы сессии: с какого момента считают плитки, и кнопка начать заново.
 *
 * Сброс ничего не удаляет — прошлые забеги остаются в истории и медиане,
 * поэтому подтверждение не нужно. Итог прошлой сессии остаётся на экране:
 * без него сброс выглядит потерей цифр.
 */
function SessionBar({ snapshot }: { snapshot: Snapshot }) {
  const { startedAt, previous } = snapshot.session;
  // Вчерашняя сессия подписывается датой: «с 14:32» читается как сегодня.
  const started =
    new Date(startedAt).toDateString() === new Date().toDateString()
      ? time(startedAt)
      : cacheDate(startedAt);

  return (
    <div className="session-bar">
      <span className="muted small">
        {startedAt > 0 ? `сессия с ${started}` : 'сессия — вся история'}
        {previous && (
          <>
            {' '}
            · прошлая: {previous.netFe >= 0 ? '+' : ''}
            {num(previous.netFe)}{NBSP}ФЕ за {duration(previous.inMapMs)}
          </>
        )}
      </span>
      <button
        className="session-reset"
        title="Плитки и цель оверлея начнут отсчёт заново. История, медиана и стратегии никуда не денутся."
        onClick={() => window.gorn && void window.gorn.session.reset()}
      >
        ⟲ Новая сессия
      </button>
    </div>
  );
}
