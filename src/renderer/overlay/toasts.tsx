import { useEffect, useRef, useState } from 'react';

import type { Snapshot } from '../../main/engine.js';
import { Fe } from '../components/Fe.js';
import { playJackpot, playPickup, playRunEnd } from './sound.js';

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
}

/** Порог «золотой» находки, в ФЕ. */
export const JACKPOT_FE = 50;
/** Окно схлопывания подборов подряд. */
const MERGE_WINDOW_MS = 900;
/** Сколько всплывашка живёт на экране. */
const TTL_MS: Record<ToastKind, number> = { pickup: 2400, jackpot: 4200, runEnd: 4200 };
/** Больше трёх плашек — уже стена текста поверх игры. */
const MAX_VISIBLE = 3;

export interface ToastOptions {
  /** Показывать плашки. Звук от них независим: можно слушать без визуала. */
  popups: boolean;
  sound: boolean;
  volume: number;
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

    const { popups, sound, volume } = optsRef.current;
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
    if (before && (!current || current.startedAt !== before.startedAt)) {
      const finished = snapshot?.recent.find((r) => r.startedAt === before.startedAt);
      if (finished) {
        push({
          id: nextId++,
          kind: 'runEnd',
          fe: finished.netFe,
          durationMs: finished.durationMs ?? 0,
        });
        if (sound) playRunEnd(finished.netFe, volume);
      }
    }

    if (!current || !before || current.startedAt !== before.startedAt) return;

    const gained = current.netFe - before.netFe;
    // Отрицательная дельта — пересчёт цен или расход, не подбор.
    if (gained <= 0.005) return;

    // Дорогая находка определяется по конкретному предмету, а не по сумме
    // дельты: пачка мелочи на 60 ФЕ — обычный подбор, а не джекпот.
    let jackpot: { name: string; icon: string | null; fe: number } | null = null;
    for (const d of current.drops) {
      const gainedQty = d.qty - (before.qtyByItem.get(d.configBaseId) ?? 0);
      if (gainedQty <= 0 || d.unitFe === null) continue;
      const value = gainedQty * d.unitFe;
      if (value >= JACKPOT_FE && (jackpot === null || value > jackpot.fe)) {
        jackpot = { name: d.name, icon: d.icon, fe: value };
      }
    }

    if (jackpot) {
      push({ id: nextId++, kind: 'jackpot', fe: jackpot.fe, name: jackpot.name, icon: jackpot.icon });
      if (sound) playJackpot(volume);
      return;
    }

    const now = Date.now();
    const merged = now - lastPickupAt.current < MERGE_WINDOW_MS;
    lastPickupAt.current = now;

    if (merged) {
      // Продлеваем и наращиваем последнюю плашку подбора, а не плодим новые.
      if (popups) {
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
      }
      if (sound) playPickup(gained, volume * 0.5);
      return;
    }

    push({ id: nextId++, kind: 'pickup', fe: gained });
    if (sound) playPickup(gained, volume);
  }, [snapshot]);

  return toasts;
}

const clock = (ms: number) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

export function ToastList({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className="ov-toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`ov-toast ov-toast-${t.kind}`}>
          {t.kind === 'jackpot' && (
            <>
              {t.icon && <img className="ov-toast-icon" src={t.icon} alt="" draggable={false} />}
              <span className="ov-toast-name">{t.name}</span>
            </>
          )}
          {t.kind === 'runEnd' && <span className="ov-toast-label">карта закрыта</span>}
          <Fe value={t.fe} signed className="ov-toast-fe" />
          {t.kind === 'runEnd' && t.durationMs !== undefined && (
            <span className="ov-toast-time">{clock(t.durationMs)}</span>
          )}
        </div>
      ))}
    </div>
  );
}
