import { RUN_IN, pluralize } from '../../core/plural.js';
import type { Snapshot } from '../../main/engine.js';
import { num } from '../format.js';
import { CopyName, ItemIcon } from './ui.js';

/**
 * Что пробить следующим.
 *
 * Цена берётся из твоих собственных пробивок в Торговом доме, и каждая
 * стоит одного клика. Поэтому важно не количество предметов без цены,
 * а какие из них реально портят оценку.
 */
export function MissingPrices({ snapshot }: { snapshot: Snapshot }) {
  const { missing } = snapshot;
  if (missing.length === 0) return null;

  return (
    <section className="card">
      <h2>Пробить цену</h2>
      <p className="muted small">
        Эти предметы падают, но стоимость неизвестна — на них оценка добычи занижена.
        Порядок по влиянию: сверху то, чего выпало больше всего. Мусор, который не продаётся,
        можно не учитывать — он перестанет сюда попадать.
      </p>
      <ul className="missing">
        {missing.map((m) => (
          <li key={m.configBaseId}>
            <ItemIcon src={m.icon} />
            <CopyName name={m.name} />
            <span className="drop-qty">{num(m.qty)} шт</span>
            <span className="muted small">в {pluralize(m.runs, RUN_IN)}</span>
            <button
              className="link-button"
              disabled={!window.gorn}
              title="Считать предмет бесплатным во всех цифрах. Вернуть можно в блоке «Цены»."
              onClick={() => void window.gorn?.prices.setExcluded(m.configBaseId, true)}
            >
              не учитывать
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
