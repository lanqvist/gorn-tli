import { net, protocol } from 'electron';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ConfigBaseId } from '../core/types.js';
import { isWebp, readCachedIcon, writeFileAtomic } from './iconFile.js';

/**
 * Локальный кэш иконок предметов.
 *
 * Справочник хранит ссылки на cdn.tlidb.com. Тянуть их при каждой отрисовке
 * плохо по трём причинам: приложение перестаёт работать без интернета,
 * мы создаём постоянную нагрузку на чужой хобби-проект и зависим от того,
 * что он останется жив.
 *
 * Поэтому иконка скачивается один раз, кладётся в папку приложения
 * и дальше отдаётся с диска через собственную схему `gorn-icon://<id>`.
 */

const SCHEME = 'gorn-icon';

/** Вызывать ДО app.whenReady: схему нужно объявить привилегированной заранее. */
export function registerIconScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}

export class IconCache {
  private dir: string;
  /** Ссылка на исходник по id предмета. */
  private sources = new Map<ConfigBaseId, string>();
  /** Уже идущие загрузки, чтобы не качать одну иконку десять раз сразу. */
  private inFlight = new Map<ConfigBaseId, Promise<Buffer | null>>();
  /** Предметы, для которых загрузка уже провалилась — не долбимся повторно. */
  private failed = new Set<ConfigBaseId>();

  constructor(userDataDir: string, items: Array<{ id: number; icon: string | null }>) {
    this.dir = join(userDataDir, 'icons');
    mkdirSync(this.dir, { recursive: true });
    for (const item of items) {
      if (item.icon) this.sources.set(item.id, item.icon);
    }
  }

  /** Регистрирует обработчик схемы. Вызывать после app.whenReady. */
  install(): void {
    protocol.handle(SCHEME, async (request) => {
      // Идентификатор берём из пути, а не из хоста. Схема зарегистрирована
      // как standard, и Chromium разбирает числовой хост как IPv4-адрес:
      // gorn-icon://100300 превращается в gorn-icon://0.1.135.204 и запрос
      // до нас доходит уже неузнаваемым.
      const id = Number(new URL(request.url).pathname.replace(/^\/|\.webp$/g, ''));
      if (!Number.isFinite(id) || id <= 0) return new Response(null, { status: 400 });

      const data = await this.get(id);
      if (!data) return new Response(null, { status: 404 });

      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': 'image/webp',
          // Иконки не меняются — пусть renderer держит их у себя.
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    });
  }

  private async get(id: ConfigBaseId): Promise<Buffer | null> {
    const file = join(this.dir, `${id}.webp`);
    // Чтение асинхронное: обработчик схемы живёт в главном потоке main,
    // и синхронный диск на десятках иконок списка подвешивал бы IPC.
    // Нет файла или он битый — перекачаем.
    const cached = await readCachedIcon(file);
    if (cached) return cached;
    if (this.failed.has(id)) return null;

    const pending = this.inFlight.get(id);
    if (pending) return pending;

    const task = this.download(id, file).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, task);
    return task;
  }

  private async download(id: ConfigBaseId, file: string): Promise<Buffer | null> {
    const url = this.sources.get(id);
    if (!url) {
      this.failed.add(id);
      return null;
    }
    try {
      // net.fetch идёт через сетевой стек Chromium: прокси и системные
      // настройки пользователя учитываются автоматически.
      const response = await net.fetch(url);
      if (!response.ok) {
        // Безнадёжным считаем только отсутствие файла. Ответы 403 и 429
        // у этого CDN приходят при частых запросах — после массовой
        // предзагрузки иконка «пропадала» навсегда, хотя через минуту
        // тот же адрес отдавал 200.
        if (response.status === 404 || response.status === 410) this.failed.add(id);
        return null;
      }
      const data = Buffer.from(await response.arrayBuffer());
      // Не картинка (страница-заглушка, обрыв) — не кэшируем и не отдаём;
      // попробуем в следующий раз.
      if (!isWebp(data)) return null;
      // Не записалось — иконку всё равно отдаём, кэш просто не пополнится.
      await writeFileAtomic(file, data).catch(() => {});
      return data;
    } catch {
      // Нет интернета — не помечаем как безнадёжную, попробуем в следующий раз.
      return null;
    }
  }

  /** Есть ли у предмета иконка в принципе. */
  has(id: ConfigBaseId): boolean {
    return this.sources.has(id);
  }

  /**
   * Заранее скачивает иконки предметов, которые игроку уже падали.
   *
   * Список ограничен виденным, а не всеми 1935 предметами: качать весь
   * справочник ради того, что никогда не выпадет, — лишняя нагрузка
   * и на чужой CDN, и на диск.
   */
  async prefetch(ids: Iterable<ConfigBaseId>, concurrency = 2): Promise<number> {
    const queue = [...new Set(ids)].filter(
      (id) => this.sources.has(id) && !existsSync(join(this.dir, `${id}.webp`)),
    );
    let done = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const id = queue.pop();
        if (id === undefined) return;
        const data = await this.get(id);
        if (data) done++;
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    return done;
  }
}

/**
 * Адрес иконки для интерфейса.
 *
 * Хост фиксированный, идентификатор — в пути: числовой хост Chromium
 * трактует как IPv4-адрес.
 */
export function iconUrl(id: ConfigBaseId): string {
  return `${SCHEME}://item/${id}.webp`;
}
