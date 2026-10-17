/** Сообщения между main-процессом и потоком подсказок в тюрьме. */
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
  width: number;
  height: number;
  /** Пиксели BGRA, как их отдаёт NativeImage.toBitmap() на Windows. */
  buffer: ArrayBuffer;
  /** Сколько мс решатель проигрывает варианты после мгновенного совета. */
  budgetMs: number;
}

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
  | { type: 'error'; id: number; message: string };
