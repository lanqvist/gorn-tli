import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Цена Горна в тюрьме (замер стендом 19.10, монитор 4K): бесконечная
 * пульсация стрелок — ~17% ядра у GPU-процесса, отпечаток кадра на холсте
 * в памяти процессора — ~20%, захват 15 кадров/с вместо 10 — ещё ~6%.
 * Кадр для подсказки на холсте в памяти процессора — 40 мс против 9,5 на
 * видеокарте (20.10).
 * Окна рендерера юнит-тестами не проверить; эти проверки не дают вернуть
 * дорогое обратно незаметно.
 */
const src = (p: string) => readFileSync(join(__dirname, '../../src/renderer', p), 'utf8');

describe('цена окон тюрьмы', () => {
  it('стрелки не пульсируют бесконечно (крутится только «смотрю…»)', () => {
    const css = src('prison.css');
    const infinite = [...css.matchAll(/animation:\s*([\w-]+)[^;]*\binfinite\b/g)].map((m) => m[1]);
    expect(infinite).toEqual(['prison-spin']);
    expect(css).toMatch(/animation:\s*prison-pulse[^;]*\s3;/);
  });

  it('новый ход — вспышки заново: метки перемонтируются по ходу', () => {
    expect(src('prison.tsx')).toMatch(/<svg key=\{`\$\{hint\.text\}\|\$\{JSON\.stringify\(hint\.marks\)\}`\}/);
  });

  it('отпечаток и кадр — на холсте видеокарты, поток не чаще 10 кадров/с, в простое реже', () => {
    const cap = src('capture.ts');
    expect(cap).toMatch(/const sigCtx = sigCanvas\.getContext\('2d', \{ willReadFrequently: false \}\);/);
    expect(cap).not.toMatch(/willReadFrequently: true/);
    expect(cap).toMatch(/const FPS = 10;/);
    expect(cap).toMatch(/maxFrameRate: FPS/);
    expect(cap).toMatch(/const IDLE_FPS = 2;/);
  });
});
