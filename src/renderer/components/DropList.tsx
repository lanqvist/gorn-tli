import type { RunView } from '../../main/engine.js';
import { num } from '../format.js';
import { Fe } from './Fe.js';
import { CopyName, ItemIcon } from './ui.js';

export function DropList({ drops }: { drops: RunView['drops'] }) {
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
