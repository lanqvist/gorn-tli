import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Автопоиск папки с логами игры.
 *
 * Установка пути вручную — одно из трёх мест, где игрок спотыкается при
 * настройке подобных трекеров. Ищем сами и спрашиваем только если не нашли.
 */

const LOG_SUBPATH = join('UE_game', 'TorchLight', 'Saved', 'Logs');

/** Папки Steam-библиотек из libraryfolders.vdf. */
function steamLibraries(): string[] {
  const roots = [
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Steam'),
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Steam'),
  ];

  const libs: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    libs.push(root);

    const vdf = join(root, 'steamapps', 'libraryfolders.vdf');
    if (!existsSync(vdf)) continue;
    try {
      const text = readFileSync(vdf, 'utf8');
      // В vdf интересны только строки вида  "path"  "D:\\SteamLibrary"
      for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) {
        libs.push(m[1]!.replace(/\\\\/g, '\\'));
      }
    } catch {
      // Нечитаемый vdf не должен ломать поиск.
    }
  }
  return [...new Set(libs)];
}

/** Возможные названия папки игры: глобальная и китайская версии. */
const GAME_DIRS = ['Torchlight Infinite', 'Torchlight Infinite CN'];

/** Возвращает путь к папке Logs или null. */
export function findLogDirectory(): string | null {
  for (const lib of steamLibraries()) {
    for (const game of GAME_DIRS) {
      const dir = join(lib, 'steamapps', 'common', game, LOG_SUBPATH);
      if (existsSync(dir)) return dir;
    }
  }
  return null;
}

export interface LogFile {
  path: string;
  /** Время последней записи — по нему упорядочиваем сессии. */
  mtime: number;
  size: number;
  /** Текущий лог, в который игра пишет прямо сейчас. */
  isCurrent: boolean;
}

/**
 * Все логи в папке, от старых к новым.
 *
 * Игра ротирует логи: UE_game.log — текущий, остальные получают имя вида
 * UE_game-backup-2026.08.10-10.19.04.log. Старые бэкапы игра удаляет,
 * поэтому разобранную историю нужно сохранять у себя, а не полагаться на файлы.
 */
export function listLogFiles(dir: string): LogFile[] {
  const files: LogFile[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('UE_game') || !name.endsWith('.log')) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.size === 0) continue;
    files.push({
      path,
      mtime: st.mtimeMs,
      size: st.size,
      isCurrent: name === 'UE_game.log',
    });
  }
  // Текущий лог всегда последний: он ещё дописывается.
  return files.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? 1 : -1;
    return a.mtime - b.mtime;
  });
}
