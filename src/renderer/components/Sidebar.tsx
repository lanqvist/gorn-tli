import type { Snapshot } from '../../main/engine.js';
import { Fe } from './Fe.js';

export function Sidebar({ snapshot }: { snapshot: Snapshot }) {
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
