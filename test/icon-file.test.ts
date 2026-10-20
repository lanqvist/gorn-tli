import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isWebp, readCachedIcon, writeFileAtomic } from '../src/main/iconFile.js';

const webp = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([4, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
]);

describe('кэш иконок на диске', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gorn-icons-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('узнаёт WebP по сигнатуре RIFF/WEBP', () => {
    expect(isWebp(webp)).toBe(true);
    expect(isWebp(Buffer.from('<!doctype html><html>'))).toBe(false);
    expect(isWebp(Buffer.from('RIFF\0\0\0\0WAVE'))).toBe(false);
    expect(isWebp(webp.subarray(0, 8))).toBe(false);
  });

  it('пишет через временный файл и не оставляет его', async () => {
    const file = join(dir, '100300.webp');
    await writeFileAtomic(file, webp);
    expect(readFileSync(file).equals(webp)).toBe(true);
    // Перезапись поверх существующего тоже проходит.
    await writeFileAtomic(file, webp);
    expect(readdirSync(dir)).toEqual(['100300.webp']);
  });

  it('битый файл в кэше не отдаётся и убирается', async () => {
    const file = join(dir, '1.webp');
    writeFileSync(file, '<html>');
    expect(await readCachedIcon(file)).toBeNull();
    expect(existsSync(file)).toBe(false);

    writeFileSync(file, webp);
    expect((await readCachedIcon(file))?.equals(webp)).toBe(true);
    expect(await readCachedIcon(join(dir, 'нет.webp'))).toBeNull();
  });
});
