import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

/**
 * Файлы кэша иконок — отдельно от IconCache, чтобы проверялись без Electron.
 */

/** Настоящая WebP: контейнер RIFF с формой WEBP. CDN за прокси или
 *  с заглушкой отдаёт HTML с кодом 200 — такое в кэш класть нельзя. */
export function isWebp(data: Uint8Array): boolean {
  if (data.length < 12) return false;
  const tag = (from: number) => String.fromCharCode(...data.subarray(from, from + 4));
  return tag(0) === 'RIFF' && tag(8) === 'WEBP';
}

/** Иконка с диска или null: нет файла, не читается или это не WebP. */
export async function readCachedIcon(file: string): Promise<Buffer | null> {
  try {
    const data = await readFile(file);
    if (isWebp(data)) return data;
    // Битый файл (оборванная запись старых версий, HTML вместо картинки) —
    // убираем, чтобы следующая загрузка положила нормальный.
    await unlink(file).catch(() => {});
    return null;
  } catch {
    return null;
  }
}

/**
 * Запись через временный файл и rename: оборванная на середине запись
 * (выход, сбой диска) не оставляет в кэше полфайла под настоящим именем.
 */
export async function writeFileAtomic(file: string, data: Uint8Array): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
