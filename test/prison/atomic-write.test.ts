import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeAtomic } from '../../src/main/prison/atomicWrite.js';

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('запись состояния тюрьмы', () => {
  it('заменяет файл целиком и не оставляет временных', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gorn-atomic-'));
    const file = join(dir, 'prison-state-own.json');
    writeFileSync(file, '{"старое":1}');
    // Несколько записей разом: по очереди, последней остаётся последняя.
    await Promise.all([1, 2, 3].map((n) => writeAtomic(file, JSON.stringify({ n, pad: 'x'.repeat(100_000) }))));
    const got = JSON.parse(readFileSync(file, 'utf8')) as { n: number; pad: string };
    expect([got.n, got.pad.length]).toEqual([3, 100_000]);
    expect(readdirSync(dir)).toEqual(['prison-state-own.json']);
  });

  it('сбой записи не трогает прежний файл', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gorn-atomic-'));
    const file = join(dir, 'нет-папки', 'prison-display.json');
    await expect(writeAtomic(file, '{}')).rejects.toThrow();
    const ok = join(dir, 'prison-display.json');
    writeFileSync(ok, '{"id":1}');
    // Переименовать поверх папки нельзя: прежний файл цел, временного нет.
    const blocked = join(dir, 'папка');
    mkdirSync(blocked);
    await expect(writeAtomic(blocked, '{}')).rejects.toThrow();
    expect(readFileSync(ok, 'utf8')).toBe('{"id":1}');
    expect(readdirSync(dir).sort()).toEqual(['prison-display.json', 'папка'].sort());
  });
});
