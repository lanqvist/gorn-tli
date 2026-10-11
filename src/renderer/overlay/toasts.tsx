import { useEffect, useRef, useState } from 'react';

import type { Snapshot } from '../../main/engine.js';
import { Fe, FeIcon } from '../components/Fe.js';
import { clock } from '../format.js';
import { playCoinRain, playJackpot, playPickup, playRunEnd } from './sound.js';

/**
 * Всплывающий доход в оверлее.
 *
 * Событий «подобран предмет» в срезе нет — есть только состояния. Поэтому
 * всплывашки вычисляются диффом соседних срезов текущего забега:
 * вырос netFe — значит, что-то подобрано; пропал current — забег закрыт.
 *
 * Дизайн-решения:
 *  - подборы в пределах короткого окна СХЛОПЫВАЮТСЯ в одну всплывашку
 *    с растущей суммой: лут-пылесос после босса даёт десятки изменений
 *    в секунду, и очередь из тридцати плашек — это спам, а не кайф;
 *  - дорогая находка (порог ниже) получает золотую плашку с именем
 *    предмета и отдельный звук — именно этот момент игрок хочет заметить;
 *  - закрытие карты подводит итог одной строкой; поражение не озвучивается
 *    фанфарами.
 */

export type ToastKind = 'pickup' | 'jackpot' | 'runEnd';

export interface Toast {
  id: number;
  kind: ToastKind;
  fe: number;
  /** Название предмета — только у золотых плашек. */
  name?: string;
  icon?: string | null;
  /** Длительность забега — только у итога карты. */
  durationMs?: number;
  /** Топ находок закрытой карты — только у итога. */
  topDrops?: Array<{ name: string; icon: string | null; fe: number }>;
  /** Отклонение темпа закрытой карты от медианы, в процентах. */
  deltaPct?: number | null;
  /** Стрик: не первый джекпот за короткое время — сессия «жаркая». */
  hot?: boolean;
  /** Лучший темп сессии — карта-рекорд, с монетным дождём. */
  record?: boolean;
}

/** Порог «золотой» находки по умолчанию, в ФЕ. Настраивается игроком. */
export const JACKPOT_FE = 50;
/** Окно схлопывания подборов подряд. */
const MERGE_WINDOW_MS = 900;
/** Два джекпота внутри этого окна — «жаркий» стрик с искрами. */
const HOT_STREAK_MS = 90_000;
/** Монетный дождь на рекорд — не чаще раза в час, иначе приестся. */
const RECORD_COOLDOWN_MS = 3_600_000;
/** Сколько всплывашка живёт на экране. Итог карты читают — ему дольше. */
const TTL_MS: Record<ToastKind, number> = { pickup: 2400, jackpot: 4200, runEnd: 5200 };
/** Больше трёх плашек — уже стена текста поверх игры. */
const MAX_VISIBLE = 3;

export interface ToastOptions {
  /** Показывать плашки. Звук от них независим: можно слушать без визуала. */
  popups: boolean;
  sound: boolean;
  volume: number;
  /** Озвучивать только золотые находки и итог карты — без «тук» на подбор. */
  soundImportantOnly: boolean;
  /** Порог «золотой» находки, в ФЕ. */
  jackpotFe: number;
}

interface RunFingerprint {
  startedAt: number;
  netFe: number;
  qtyByItem: Map<number, number>;
}

let nextId = 1;

export function useIncomeToasts(snapshot: Snapshot | null, opts: ToastOptions): Toast[] {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Список дублируется в ref: ветке схлопывания нужно синхронно знать,
  // жива ли ещё плашка подбора, а state к этому моменту может отставать.
  const listRef = useRef<Toast[]>([]);
  // Таймеры гашения по id плашки — чтобы при схлопывании продлевать жизнь,
  // а не давать плашке умереть по таймеру от самого первого подбора.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const prev = useRef<RunFingerprint | null>(null);
  const lastPickupAt = useRef(0);
  const lastJackpotAt = useRef(0);
  const lastRecordAt = useRef(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  useEffect(() => {
    const current = snapshot?.current ?? null;
    const before = prev.current;
    prev.current = current
      ? {
          startedAt: current.startedAt,
          netFe: current.netFe,
          qtyByItem: new Map(current.drops.map((d) => [d.configBaseId, d.qty])),
        }
      : null;

    const { popups, sound, volume, soundImportantOnly, jackpotFe } = optsRef.current;
    if (!popups && !sound) return;

    const commit = (list: Toast[]): void => {
      listRef.current = list;
      setToasts(list);
    };

    // (Пере)взводит таймер гашения: старый таймер той же плашки снимается.
    const scheduleExpiry = (id: number, kind: ToastKind): void => {
      const old = timers.current.get(id);
      if (old !== undefined) clearTimeout(old);
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          commit(listRef.current.filter((t) => t.id !== id));
        }, TTL_MS[kind]),
      );
    };

    const push = (toast: Toast): void => {
      if (!popups) return;
      commit([toast, ...listRef.current].slice(0, MAX_VISIBLE));
      scheduleExpiry(toast.id, toast.kind);
    };

    // Забег закрыт: current исчез или сменился новым стартом.
    // Момент закрытия карты — естественная пауза, игрок готов читать,
    // поэтому итог — карточка с топ-находками, а не одна строка.
    if (before && (!current || current.startedAt !== before.startedAt)) {
      const finished = snapshot?.recent.find((r) => r.startedAt === before.startedAt);
      if (finished) {
        const median = snapshot?.rate.median ?? 0;

        // Рекорд сессии: темп выше всех остальных недавних забегов.
        // Кулдаун держит его событием, а не ежечасным фоном.
        const others = (snapshot?.recent ?? []).filter(
          (r) => r.startedAt !== finished.startedAt,
        );
        const bestOther = others.reduce((a, r) => Math.max(a, r.perHour), 0);
        const record =
          others.length >= 4 &&
          finished.perHour > bestOther &&
          Date.now() - lastRecordAt.current > RECORD_COOLDOWN_MS;
        if (record) lastRecordAt.current = Date.now();

        push({
          id: nextId++,
          kind: 'runEnd',
          fe: finished.netFe,
          durationMs: finished.durationMs ?? 0,
          record,
          topDrops: [...finished.drops]
            .filter((d) => d.totalFe !== null && d.totalFe > 0)
            .sort((a, b) => b.totalFe! - a.totalFe!)
            .slice(0, 3)
            .map((d) => ({ name: d.name, icon: d.icon, fe: d.totalFe! })),
          deltaPct:
            median > 0 ? Math.round(((finished.perHour - median) / median) * 100) : null,
        });
        if (sound) {
          if (record) playCoinRain(volume);
          else playRunEnd(finished.netFe, volume);
        }
      }
    }

    if (!current || !before || current.startedAt !== before.startedAt) return;

    const gained = current.netFe - before.netFe;
    // Отрицательная дельта — пересчёт цен или расход, не подбор.
    if (gained <= 0.005) return;

    // Порог «золота»: явный из настроек либо «авто» — P95 цен сезона,
    // чтобы золотая плашка оставалась событием и в зрелой экономике.
    const goldFe = jackpotFe > 0 ? jackpotFe : (snapshot?.jackpotAutoFe ?? JACKPOT_FE);

    // Дорогая находка определяется по конкретному предмету, а не по сумме
    // дельты: пачка мелочи на 60 ФЕ — обычный подбор, а не джекпот.
    let jackpot: { name: string; icon: string | null; fe: number } | null = null;
    for (const d of current.drops) {
      const gainedQty = d.qty - (before.qtyByItem.get(d.configBaseId) ?? 0);
      if (gainedQty <= 0 || d.unitFe === null) continue;
      const value = gainedQty * d.unitFe;
      if (value >= goldFe && (jackpot === null || value > jackpot.fe)) {
        jackpot = { name: d.name, icon: d.icon, fe: value };
      }
    }

    if (jackpot) {
      // Стрик: второй джекпот подряд получает искры и звон закалки.
      const hot = Date.now() - lastJackpotAt.current < HOT_STREAK_MS;
      lastJackpotAt.current = Date.now();
      push({
        id: nextId++,
        kind: 'jackpot',
        fe: jackpot.fe,
        name: jackpot.name,
        icon: jackpot.icon,
        hot,
      });
      if (sound) playJackpot(volume, hot);
      return;
    }

    const now = Date.now();
    const merged = now - lastPickupAt.current < MERGE_WINDOW_MS;
    lastPickupAt.current = now;

    // Темп и громкость ударов сглаживает сам sound.ts (троттлинг
    // с накоплением) — дельта уходит туда как есть, без ослабления.
    // В режиме «только важное» обычные подборы молчат.
    if (sound && !soundImportantOnly) playPickup(gained, volume);
    if (!popups) return;

    if (merged) {
      // Продлеваем и наращиваем последнюю плашку подбора, а не плодим новые.
      const idx = listRef.current.findIndex((t) => t.kind === 'pickup');
      if (idx === -1) {
        // Плашка успела погаснуть — начинаем новую, дельту не теряем.
        push({ id: nextId++, kind: 'pickup', fe: gained });
      } else {
        const updated = [...listRef.current];
        updated[idx] = { ...updated[idx]!, fe: updated[idx]!.fe + gained };
        commit(updated);
        scheduleExpiry(updated[idx]!.id, 'pickup');
      }
      return;
    }

    push({ id: nextId++, kind: 'pickup', fe: gained });
  }, [snapshot]);

  return toasts;
}

export function ToastList({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className="ov-toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`ov-toast ov-toast-${t.kind} ${t.hot ? 'ov-toast-hot' : ''} ${
            t.record ? 'ov-toast-record' : ''
          }`}
        >
          {/* Искры стрика: чистый CSS, по спану на искру. */}
          {t.hot && (
            <span className="ov-sparks" aria-hidden="true">
              {Array.from({ length: 6 }, (_, i) => (
                <i key={i} />
              ))}
            </span>
          )}
          {/* Монетный дождь рекорда: те же иконки ФЕ, что и в числах. */}
          {t.record && (
            <span className="ov-coins" aria-hidden="true">
              {Array.from({ length: 7 }, (_, i) => (
                <i key={i}>
                  <FeIcon />
                </i>
              ))}
            </span>
          )}
          {t.kind === 'jackpot' && (
            <>
              {t.icon && <img className="ov-toast-icon" src={t.icon} alt="" draggable={false} />}
              <span className="ov-toast-name">{t.name}</span>
            </>
          )}
          {t.kind !== 'runEnd' && <Fe value={t.fe} signed className="ov-toast-fe" />}
          {t.kind === 'runEnd' && (
            <div className="ov-runend">
              <div className="ov-runend-head">
                <span className={`ov-toast-label ${t.record ? 'ov-record-label' : ''}`}>
                  {t.record ? 'рекорд сессии!' : 'карта закрыта'}
                </span>
                <Fe value={t.fe} signed className="ov-toast-fe" />
                {t.durationMs !== undefined && (
                  <span className="ov-toast-time">{clock(t.durationMs)}</span>
                )}
                {t.deltaPct != null && t.deltaPct !== 0 && (
                  <span className={`ov-runend-delta ${t.deltaPct > 0 ? 'up' : 'down'}`}>
                    {t.deltaPct > 0 ? '+' : '−'}
                    {Math.abs(t.deltaPct)}% к норме
                  </span>
                )}
              </div>
              {t.topDrops && t.topDrops.length > 0 && (
                <div className="ov-runend-drops">
                  {t.topDrops.map((d, i) => (
                    <span key={i} className="ov-runend-drop">
                      {d.icon && <img src={d.icon} alt="" draggable={false} />}
                      <span className="ov-runend-name">{d.name}</span>
                      <Fe value={d.fe} />
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
