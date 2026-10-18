/** Сообщения между main-процессом и потоком подсказок в тюрьме. */
import type { Geometry } from '../../core/prison/recognize/types.js';
import type { PrisonFrameKind } from '../../core/prisonTriggers.js';

export type PrisonMark =
  | { kind: 'arrow'; from: number[]; to: number[] }
  | { kind: 'ring'; at: number[]; r: number }
  | { kind: 'box'; box: number[] };

export interface PrisonShotMessage {
  type: 'shot';
  id: number;
  kind: PrisonFrameKind | 'manual';
  fresh: boolean;
  after: '' | 'swap' | 'consume';
  treasureView: boolean;
  rerolled: boolean;
  treasureClosed: boolean;
  /** Окно темы забега: номер озвучки Special_0N из лога (null — нет). */
  theme: number | null;
  /**
   * Доска, снятая, пока уже открылось окно подарков: обновить по ней
   * доску, а совет дать по подаркам.
   */
  asTreasure: boolean;
  width: number;
  height: number;
  /** Пиксели: BGRA от NativeImage.toBitmap(), RGBA из потока экрана; пусто — кадр без картинки (подарки). */
  buffer: ArrayBuffer;
  format: 'bgra' | 'rgba';
  /** Сколько мс решатель проигрывает варианты после мгновенного совета. */
  budgetMs: number;
  /** Куда сохранить кадр PNG (null — не сохранять). */
  savePath: string | null;
}

/** Положение доски на кадре такого размера (масштаб и сдвиг) — прежний путь (vendor). */
export interface BoardNear {
  s: number;
  tx: number;
  ty: number;
  size: string;
}

/** Где доска: у прежнего пути — BoardNear, у своего — Geometry распознавания. */
export type SavedNear = BoardNear | Geometry;

/** Подсказка в пикселях кадра: окно стрелок само переводит их в экран. */
export interface PrisonHint {
  text: string;
  marks: PrisonMark[];
  frame: { w: number; h: number };
  /** true — совет проверен проигрыванием вариантов, а не только стратегией. */
  live: boolean;
}

export type PrisonWorkerReply =
  | ({ type: 'hint'; id: number; phase: 'instant' | 'final' } & PrisonHint)
  | { type: 'settled'; id: number; live: boolean }
  | { type: 'clear'; id: number }
  | { type: 'error'; id: number; message: string }
  /** Модель доски после кадра — сохранить на диск (id всегда 0). */
  | { type: 'state'; id: number; model: unknown }
  /** Где доска на кадре: сохраняется, чтобы первый кадр после запуска не искал её по всему экрану. */
  | { type: 'near'; id: number; near: SavedNear };
