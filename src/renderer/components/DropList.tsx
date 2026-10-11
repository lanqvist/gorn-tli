import { ITEM, pluralize } from '../../core/plural.js';
import type { RunView } from '../../main/engine.js';
import { num } from '../format.js';
import { Fe } from './Fe.js';
import { CopyName, ItemIcon } from './ui.js';

const COMMUNITY_TIP =
  'Цена из базы сообщества (titrack.ninja): своей пробивки нет или ей больше трёх дней. Пробей предмет сам — свежая своя пробивка точнее и заменит её.';

/**
 * Список добычи. Дешевле порога `minFe` и исключённое из учёта
 * сворачивается в одну строку: двадцать строк песка по 0,01 ФЕ
 * прятали за собой то, что действительно выпало.
 */
export function DropList({
  drops,
  empty = 'Ничего не выпало.',
  minFe = 0,
}: {
  drops: RunView['drops'];
  empty?: string;
  minFe?: number;
}) {
  if (drops.length === 0) return <p className="muted">{empty}</p>;

  const excluded = drops.filter((d) => d.priceSource === 'excluded');
  const small = drops.filter(
    (d) => d.priceSource !== 'excluded' && d.totalFe !== null && d.totalFe < minFe,
  );
  const shown = drops.filter((d) => !excluded.includes(d) && !small.includes(d));
  const smallFe = small.reduce((a, d) => a + (d.totalFe ?? 0), 0);

  return (
    <ul className="drops">
      {shown.slice(0, 12).map((d) => (
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
                  ? { className: 'price-community', title: COMMUNITY_TIP }
                  : {})}
              >
                <Fe value={d.totalFe} />
              </span>
            )}
          </span>
        </li>
      ))}
      {small.length > 0 && (
        <li className="drops-folded">
          <span className="no-icon" />
          <span className="muted">
            ещё {pluralize(small.length, ITEM)} дешевле {num(minFe, minFe < 1 ? 1 : 0)} ФЕ
          </span>
          <span className="drop-qty" />
          <span className="drop-value muted">
            <Fe value={smallFe} />
          </span>
        </li>
      )}
      {excluded.length > 0 && (
        <li className="drops-folded">
          <span className="no-icon" />
          <span
            className="muted"
            title={`Исключено из учёта: ${excluded.map((d) => d.name).join(', ')}. Вернуть — в блоке «Цены».`}
          >
            не учитывается: {pluralize(excluded.length, ITEM)}
          </span>
        </li>
      )}
    </ul>
  );
}
