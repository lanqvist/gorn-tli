import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SnapshotGate, type GateTarget } from '../src/main/snapshotGate.js';

/**
 * Цена окон лут-трекера (замер 19.10): сам движок — ~0,15% ядра, а окна —
 * ~5%: главное окно ~3,5% даже свёрнутым (секундный таймер перерисовывал
 * всё дерево, снимки шли и в скрытое окно), оверлей ~1,7%.
 */
function target(visible: boolean) {
  const sent: number[] = [];
  const t: GateTarget<number> & { sent: number[]; show(v: boolean): void } = {
    sent,
    visible: () => visible,
    send: (s) => sent.push(s),
    show(v) {
      visible = v;
    },
  };
  return t;
}

describe('снимки в главное окно', () => {
  it('видимому окну — каждый снимок', () => {
    const t = target(true);
    const gate = new SnapshotGate(() => t);
    gate.push(1);
    gate.push(2);
    expect(t.sent).toEqual([1, 2]);
  });

  it('скрытому — ничего, при показе — только последний и один раз', () => {
    const t = target(false);
    const gate = new SnapshotGate(() => t);
    gate.push(1);
    gate.push(2);
    gate.push(3);
    expect(t.sent).toEqual([]);
    t.show(true);
    gate.shown();
    gate.shown();
    expect(t.sent).toEqual([3]);
    gate.push(4);
    expect(t.sent).toEqual([3, 4]);
  });

  it('показ без пропущенного — ничего не шлёт; окна нет — не падает', () => {
    const t = target(true);
    const gate = new SnapshotGate(() => t);
    gate.push(1);
    gate.shown();
    expect(t.sent).toEqual([1]);
    const none = new SnapshotGate<number>(() => null);
    none.push(1);
    none.shown();
  });

  it('свернули снова до показа — последний уходит после разворота', () => {
    const t = target(true);
    const gate = new SnapshotGate(() => t);
    gate.push(1);
    t.show(false);
    gate.push(2);
    gate.shown(); // событие пришло, а окно ещё не видно
    expect(t.sent).toEqual([1]);
    t.show(true);
    gate.shown();
    expect(t.sent).toEqual([1, 2]);
  });
});

const src = (p: string) => readFileSync(join(__dirname, '../src/renderer', p), 'utf8');

describe('секундный таймер — только у часов', () => {
  it('App не тикает: время спрашивают часы забега, статус лога и «обновлены N назад»', () => {
    expect(src('App.tsx')).not.toMatch(/setInterval|setNow/);
    expect(src('components/Header.tsx')).toMatch(/function LogStatus[\s\S]*useNow\(1000\)/);
    expect(src('components/CurrentRun.tsx')).toMatch(/function RunTimer[\s\S]*useNow\(1000\)/);
    expect(src('components/Diagnostics.tsx')).toMatch(/function UpdatedAgo[\s\S]*useNow\(30_000\)/);
  });

  it('в оверлее полосы дропа и цель не перерисовываются от тика', () => {
    const ov = src('OverlayApp.tsx');
    expect(ov).toMatch(/const DropBars = memo\(/);
    expect(ov).toMatch(/const GoalProgress = memo\(/);
  });

  it('бесконечные анимации в дашборде — только спиннер загрузки', () => {
    const css = src('styles.css');
    const infinite = [...css.matchAll(/animation:\s*([\w-]+)[^;]*\binfinite\b/g)].map((m) => m[1]);
    expect(infinite).toEqual(['spin']);
    expect(css).toMatch(/\.status-pulse i \{\s*animation: status-pulse 1\.4s ease-out 2;/);
  });
});
