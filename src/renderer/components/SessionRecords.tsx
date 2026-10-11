import { RUN, pluralize } from '../../core/plural.js';
import type { Snapshot } from '../../main/engine.js';
import { num } from '../format.js';
import { Fe } from './Fe.js';

/**
 * Рекорды по последним забегам: дешёвая радость без гринд-давления.
 * Всё считается из среза на клиенте — движку эта полоска не стоит ничего.
 */
export function SessionRecords({ snapshot }: { snapshot: Snapshot }) {
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
