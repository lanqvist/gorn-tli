import { EventEmitter } from 'node:events';
import { app } from 'electron';

import electronUpdater from 'electron-updater';

// electron-updater — пакет CommonJS, а main собирается в ESM.
// Именованный импорт из такого пакета не работает, поэтому берём default.
const { autoUpdater } = electronUpdater;

export interface UpdateState {
  /** Обновления в принципе возможны: только для установленной версии. */
  supported: boolean;
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
  version: string | null;
  /** Доля загруженного, 0…1. */
  progress: number;
  error: string | null;
}

/**
 * Автообновление через релизы GitHub.
 *
 * Обновляется только установленная версия. Портативная лежит одним файлом
 * там, куда её положил игрок, и подменять этот файл у него под руками —
 * плохая идея: приложение может быть на флешке или в папке только для чтения.
 * Про новую версию портативной сборке всё равно сообщается, но скачивает
 * её игрок сам.
 *
 * Установка отложена до выхода из приложения: подменять файлы работающего
 * трекера посреди фарма нельзя.
 */
/**
 * Короткая причина вместо простыни.
 *
 * electron-updater кладёт в message весь ответ сервера вместе с заголовками
 * и стеком — на экране это полотно на треть окна, из которого игрок ничего
 * не поймёт. Оставляем первую строку и приводим частые случаи
 * к человеческому виду.
 */
function shortReason(err: Error): string {
  const raw = err.message ?? String(err);
  // Переводы строк внутри сообщения приходят экранированными как «\n»,
  // поэтому режем и по ним, а не только по настоящим переносам.
  const first = raw.split(/\r?\n|\\n/)[0] ?? '';

  if (/net::|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED/i.test(first)) {
    return 'нет связи с сервером обновлений';
  }
  if (/404/.test(first)) return 'в последнем релизе нет файла обновления';
  if (/403|rate limit/i.test(first)) return 'сервер обновлений временно ограничил запросы';

  return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}

export class Updater extends EventEmitter {
  private state: UpdateState = {
    supported: false,
    status: 'idle',
    version: null,
    progress: 0,
    error: null,
  };

  /** Портативная сборка распаковывается во временную папку и себя не обновляет. */
  private readonly isPortable = Boolean(process.env['PORTABLE_EXECUTABLE_DIR']);

  constructor() {
    super();
    this.state.supported = app.isPackaged && !this.isPortable;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    // Своё окно с прогрессом нам не нужно, но и молчать нельзя.
    autoUpdater.logger = null;

    autoUpdater.on('checking-for-update', () => this.update({ status: 'checking' }));
    autoUpdater.on('update-available', (info: { version: string }) => {
      this.update({ status: 'available', version: info.version });
    });
    autoUpdater.on('update-not-available', () => this.update({ status: 'idle' }));
    autoUpdater.on('download-progress', (p: { percent: number }) => {
      this.update({ status: 'downloading', progress: p.percent / 100 });
    });
    autoUpdater.on('update-downloaded', (info: { version: string }) => {
      this.update({ status: 'ready', version: info.version, progress: 1 });
    });
    autoUpdater.on('error', (err: Error) => {
      this.update({ status: 'error', error: shortReason(err) });
    });
  }

  private update(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  get current(): UpdateState {
    return this.state;
  }

  /**
   * Проверка при запуске.
   *
   * В отладке и в портативной сборке автообновление отключено, но проверить
   * наличие новой версии всё равно полезно — игрок хотя бы узнает,
   * что вышла свежая.
   */
  async check(): Promise<void> {
    if (!app.isPackaged) return;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      this.update({ status: 'error', error: shortReason(err as Error) });
    }
  }

  /** Загрузка начинается только по кнопке: трафик игрока — его дело. */
  async download(): Promise<void> {
    if (!this.state.supported) return;
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      this.update({ status: 'error', error: shortReason(err as Error) });
    }
  }

  /** Перезапуск с установкой. Вызывается только по явному нажатию. */
  install(): void {
    if (this.state.status !== 'ready') return;
    autoUpdater.quitAndInstall();
  }
}
