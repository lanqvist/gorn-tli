import { RUN, pluralize } from '../../core/plural.js';
import type { Snapshot } from '../../main/engine.js';
import { duration, num, time } from '../format.js';
import { Fe, FeIcon } from './Fe.js';
import { Tip } from './ui.js';

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

export function RecentRuns({ snapshot }: { snapshot: Snapshot }) {
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
