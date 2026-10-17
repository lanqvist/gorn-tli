/** Кадр: RGBA построчно, как ImageData. */
export interface Frame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Где интерфейс тюрьмы на кадре. Все места в `layout.ts` записаны в опорных
 * координатах кадра 1920×1080 при обычном масштабе интерфейса; на кадре
 * точка опорных координат (x, y) лежит в (s·x + tx, s·y + ty).
 */
export interface Geometry {
  width: number;
  height: number;
  s: number;
  tx: number;
  ty: number;
  /** Насколько уверенно найдена доска (0…1), для отладки. */
  score: number;
}
