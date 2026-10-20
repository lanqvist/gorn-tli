/** Запись файла целиком или никак — для памяти забега и геометрии доски. */
import { rename, rm, writeFile } from 'node:fs/promises';

let tmpSeq = 0;
/** Последняя запись по каждому файлу: следующая ждёт её (Windows не даёт переименовать два раза разом). */
const queue = new Map<string, Promise<void>>();

async function writeOnce(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Записать файл через временный рядом и переименование. Обрыв посреди
 * записи (выход Горна, сбой) оставлял полфайла — память забега и геометрия
 * доски тогда не читались и терялись. Записи одного файла идут по очереди:
 * последней остаётся последняя.
 */
export function writeAtomic(file: string, data: string): Promise<void> {
  const prev = queue.get(file) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => writeOnce(file, data));
  queue.set(file, next);
  void next.finally(() => {
    if (queue.get(file) === next) queue.delete(file);
  }).catch(() => undefined);
  return next;
}
