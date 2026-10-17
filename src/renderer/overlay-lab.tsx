import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { tr, uiLanguage } from '../core/i18n.js';
import { initLanguage } from './language.js';
import './overlay-lab.css';

/**
 * Стенд оверлея — дев-страница для проверки «на глаз», как звуковая
 * лаборатория для звука. Настоящий overlay.html во фреймах: все места
 * (карта, город, нет игры) и режимы сразу, поверх фонов, имитирующих
 * игру, — тёмное подземелье, яркая пустыня (худший случай для светлого
 * текста) и пёстрый бой.
 */

type Place = 'map' | 'town' | 'offline';
type Mode = 'minimal' | 'compact' | 'full';

/** Ширины окна по режимам — копия WIDTHS из main/overlay.ts (там electron). */
const WIDTHS: Record<Mode, number> = { minimal: 250, compact: 290, full: 330 };

const BGS = ['dungeon', 'desert', 'battle'] as const;

function Frame({
  place,
  mode,
  scale,
  goal,
  free,
}: {
  place: Place;
  mode: Mode;
  scale: number;
  goal: boolean;
  free: boolean;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(64);
  const src = `overlay.html?lang=${uiLanguage()}&place=${place}&mode=${mode}&scale=${scale}${
    goal ? '&goal=1000' : ''
  }${free ? '' : '&locked=1'}`;

  // Высоту фрейм берёт по содержимому — так же, как окно в приложении.
  // Опросом, а не ResizeObserver: при смене адреса документ во фрейме
  // подменяется, и наблюдатель остался бы на старом.
  useEffect(() => {
    const t = setInterval(() => {
      const body = ref.current?.contentDocument?.body;
      if (body) setHeight(Math.ceil(body.getBoundingClientRect().height) || 64);
    }, 300);
    return () => clearInterval(t);
  }, []);

  return (
    <iframe
      ref={ref}
      src={src}
      title={`${place}-${mode}`}
      style={{ width: Math.round(WIDTHS[mode] * scale), height }}
    />
  );
}

function Lab() {
  const [bg, setBg] = useState<(typeof BGS)[number]>('battle');
  const [scale, setScale] = useState(1);
  const [goal, setGoal] = useState(true);
  const [free, setFree] = useState(false);

  useEffect(() => {
    document.title = tr('Стенд оверлея', 'Overlay bench');
  }, []);

  const places: Array<[Place, string]> = [
    ['map', tr('на карте', 'in a map')],
    ['town', tr('в городе', 'in town')],
    ['offline', tr('нет игры', 'no game')],
  ];
  const modes: Array<[Mode, string]> = [
    ['minimal', tr('минимум', 'minimal')],
    ['compact', tr('компакт', 'compact')],
    ['full', tr('полный', 'full')],
  ];
  const bgLabel = (b: string) =>
    b === 'dungeon'
      ? tr('подземелье', 'dungeon')
      : b === 'desert'
        ? tr('яркая пустыня', 'bright desert')
        : tr('пёстрый бой', 'busy fight');

  return (
    <div className="lab">
      <h1>{tr('Стенд оверлея', 'Overlay bench')}</h1>
      <p className="lab-sub">
        {tr(
          'Настоящий оверлей на демо-данных: строки — место игрока, столбцы — режимы. Яркий фон — худший случай для читаемости.',
          'The real overlay on demo data: rows are where the player is, columns are modes. The bright background is the worst case for legibility.',
        )}
      </p>
      <div className="lab-ctl">
        <Seg label={tr('Фон', 'Background')} value={bg} set={setBg} opts={BGS.map((b) => [b, bgLabel(b)])} />
        <Seg
          label={tr('Масштаб', 'Scale')}
          value={String(scale)}
          set={(v) => setScale(Number(v))}
          opts={[
            ['0.8', '80%'],
            ['1', '100%'],
            ['1.25', '125%'],
            ['1.6', '160%'],
          ]}
        />
        <Seg
          label={tr('Цель', 'Goal')}
          value={goal ? 'on' : 'off'}
          set={(v) => setGoal(v === 'on')}
          opts={[
            ['on', tr('есть', 'on')],
            ['off', tr('нет', 'off')],
          ]}
        />
        <Seg
          label={tr('Оверлей', 'Overlay')}
          value={free ? 'free' : 'locked'}
          set={(v) => setFree(v === 'free')}
          opts={[
            ['locked', tr('закреплён', 'locked')],
            ['free', tr('настройка', 'unlocked')],
          ]}
        />
        <Seg
          label={tr('Язык', 'Language')}
          value={uiLanguage()}
          set={(v) => (location.search = `?lang=${v}`)}
          opts={[
            ['ru', 'RU'],
            ['en', 'EN'],
          ]}
        />
      </div>

      {places.map(([place, label]) => (
        <section key={place} className="lab-place">
          <h2>{label}</h2>
          <div className={`scene bg-${bg}`}>
            {modes.map(([mode, modeLabel]) => (
              <figure key={mode}>
                <Frame place={place} mode={mode} scale={scale} goal={goal} free={free} />
                <figcaption>{modeLabel}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Seg<T extends string>({
  label,
  value,
  set,
  opts,
}: {
  label: string;
  value: T;
  set: (v: T) => void;
  opts: Array<[T, string]>;
}) {
  return (
    <div className="seg">
      <span>{label}</span>
      {opts.map(([v, l]) => (
        <button key={v} className={v === value ? 'on' : ''} onClick={() => set(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

const root = document.getElementById('root')!;
void initLanguage().then(() => {
  createRoot(root).render(
    <StrictMode>
      <Lab />
    </StrictMode>,
  );
});
