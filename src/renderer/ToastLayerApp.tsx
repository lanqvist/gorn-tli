import { useEffect, useRef, useState } from 'react';

import type { Snapshot } from '../main/engine.js';
import { ToastList, useIncomeToasts } from './overlay/toasts.js';

/**
 * Слой всплывающего дохода — отдельное прозрачное окно у центра экрана,
 * поверх игры, всегда пропускающее клики.
 *
 * Почему не внутри оверлея: оверлей — приборная панель в углу, на неё
 * смотрят изредка и специально. Момент «что сейчас упало» должен ловиться
 * боковым зрением у персонажа, как floating combat text в самой игре.
 *
 * Окно живёт скрытым и показывается только пока есть плашки: прозрачное
 * окно стоит композитору дорого, а этот слой большую часть времени пуст.
 */
export function ToastLayerApp() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [prefs, setPrefs] = useState<GornOverlayPrefs>({
    popups: true,
    sound: true,
    volume: 0.5,
    divineFe: 20,
    jackpotFe: 50,
    exaltedFe: 5,
    fontScale: 1,
    goalFe: 0,
  });
  const root = useRef<HTMLDivElement>(null);

  const toasts = useIncomeToasts(snapshot, prefs);

  // Главному процессу сообщается и высота, и «есть ли что показывать»:
  // по второму он прячет окно целиком.
  useEffect(() => {
    window.gorn?.toasts.reportActive(toasts.length > 0);
  }, [toasts.length]);

  useEffect(() => {
    const el = root.current;
    if (!el || !window.gorn) return;
    const observer = new ResizeObserver(() => {
      window.gorn.toasts.reportHeight(el.getBoundingClientRect().height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // В браузере имитируем подборы — вёрстку и звук видно без игры.
    if (!window.gorn) {
      if (import.meta.env.DEV) {
        let timer: ReturnType<typeof setInterval> | undefined;
        void import('./demo.js').then((m) => {
          let current = m.demoSnapshot;
          setSnapshot(current);
          timer = setInterval(() => {
            const gained = Math.random() < 0.18 ? 55 + Math.random() * 60 : Math.random() * 7;
            const cur = current.current;
            if (!cur) return;
            current = {
              ...current,
              current: {
                ...cur,
                netFe: cur.netFe + gained,
                valueFe: cur.valueFe + gained,
                drops: cur.drops.map((d, i) =>
                  i === (gained > 50 ? 0 : 3)
                    ? { ...d, qty: d.qty + 1, totalFe: (d.totalFe ?? 0) + gained, unitFe: gained }
                    : d,
                ),
              },
            };
            setSnapshot(current);
          }, 2200);
        });
        return () => timer && clearInterval(timer);
      }
      return;
    }

    void window.gorn.getSnapshot().then((s) => s && setSnapshot(s));
    void window.gorn.overlay.getState().then((s) => {
      setPrefs({
        popups: s.popups ?? true,
        sound: s.sound ?? true,
        volume: s.volume ?? 0.5,
        divineFe: s.divineFe ?? 20,
        jackpotFe: s.jackpotFe ?? 50,
        exaltedFe: s.exaltedFe ?? 5,
        fontScale: s.fontScale ?? 1,
        goalFe: s.goalFe ?? 0,
      });
    });
    const offSnapshot = window.gorn.onSnapshot(setSnapshot);
    const offPrefs = window.gorn.overlay.onPrefs(setPrefs);
    return () => {
      offSnapshot();
      offPrefs();
    };
  }, []);

  return (
    <div ref={root} className="tl">
      <ToastList toasts={toasts} />
    </div>
  );
}
