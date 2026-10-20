import { describe, expect, it } from 'vitest';

import type { Snapshot } from '../src/main/engine.js';
import { ToastFeed, toastSnapshot } from '../src/main/toastFeed.js';
import { demoSnapshot } from '../src/renderer/demo.js';

const withCurrent = (s: Snapshot, patch: Partial<NonNullable<Snapshot['current']>>): Snapshot => ({
  ...s,
  current: { ...s.current!, ...patch },
});

describe('срез для слоя всплывашек', () => {
  it('несёт только поля плашек', () => {
    const slim = toastSnapshot(demoSnapshot);
    expect(Object.keys(slim).sort()).toEqual(['current', 'jackpotAutoFe', 'norm', 'recent']);
    expect(JSON.stringify(slim).length).toBeLessThan(JSON.stringify(demoSnapshot).length);
  });

  it('неизменившийся для плашек срез не шлётся повторно', () => {
    expect(demoSnapshot.current).not.toBeNull();
    const feed = new ToastFeed();
    expect(feed.next(demoSnapshot)).not.toBeNull();
    expect(feed.next({ ...demoSnapshot })).toBeNull();

    // Темп открытого забега тикает от часов — плашкам он не нужен.
    const ticking = withCurrent(demoSnapshot, { perHour: demoSnapshot.current!.perHour + 1 });
    expect(feed.next(ticking)).toBeNull();
    // Сменились счётчики главного окна — тоже не повод.
    expect(feed.next({ ...ticking, liveRate: ticking.liveRate + 5 })).toBeNull();

    // Подбор: выросла добыча забега.
    const cur = demoSnapshot.current!;
    const picked = withCurrent(demoSnapshot, {
      netFe: cur.netFe + 3,
      drops: cur.drops.map((d, i) => (i === 0 ? { ...d, qty: d.qty + 1 } : d)),
    });
    expect(feed.next(picked)?.current?.netFe).toBe(cur.netFe + 3);

    // Карта закрыта.
    expect(feed.next({ ...picked, current: null })).not.toBeNull();
    // Новое окно получает срез, даже если он не менялся.
    feed.reset();
    expect(feed.next({ ...picked, current: null })).not.toBeNull();
  });

  it('смена нормы или авто-порога — изменение', () => {
    const feed = new ToastFeed();
    feed.next(demoSnapshot);
    expect(feed.next({ ...demoSnapshot, norm: demoSnapshot.norm + 1 })).not.toBeNull();
    expect(feed.next({ ...demoSnapshot, norm: demoSnapshot.norm + 1, jackpotAutoFe: 999 })).not.toBeNull();
  });
});
