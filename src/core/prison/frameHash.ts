/**
 * Отпечаток кадра: размер и хеш 4096 точек сетки. Нужен, чтобы заметить
 * застывший поток экрана — он отдаёт тот же кадр, хотя игра уже показала
 * новое окно (18.10 22:51: окно темы, выбор орудий и цель пришли одной
 * пачкой, а поток полминуты отдавал доску до них).
 */
export function frameHash(frame: { width: number; height: number; buffer: ArrayBuffer }): string {
  const px = new Uint8Array(frame.buffer);
  const n = frame.width * frame.height;
  let h = 0x811c9dc5;
  if (n > 0 && px.length >= n * 4) {
    const step = Math.max(1, Math.floor(n / 4096));
    for (let i = 0; i < n; i += step) {
      const o = i * 4;
      h = Math.imul(h ^ px[o]!, 0x01000193);
      h = Math.imul(h ^ px[o + 1]!, 0x01000193);
      h = Math.imul(h ^ px[o + 2]!, 0x01000193);
    }
  }
  return `${frame.width}x${frame.height}:${(h >>> 0).toString(36)}`;
}

/** В пачке строк лога открылось новое окно (или начался день): экран точно сменился. */
export function screenChanged(lines: readonly string[]): boolean {
  return lines.some((l) => /S16Board\w*Pop Run|check cur=\d+/.test(l));
}
