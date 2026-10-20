import { pathToFileURL } from 'node:url';
import type { App, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';

/**
 * Страницы приложения: файлы собранного renderer или dev-сервер Vite.
 *
 * Все окна Горна получают один preload, а с ним window.gorn —
 * автозагрузку, установку обновления, выбор папки логов. Окно, которое
 * увели на чужой адрес (например, перетащив в оверлей ссылку), не должно
 * ни оставаться там, ни говорить с main от имени приложения.
 */
export function isAppUrl(url: string, rendererDir: string, devServer?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'file:') {
    // Сравниваем разобранные пути: так «..» и регистр схемы не обманут.
    const root = pathToFileURL(rendererDir).href.replace(/\/?$/, '/');
    return parsed.href.toLowerCase().startsWith(root.toLowerCase());
  }
  if (devServer) {
    try {
      return parsed.origin === new URL(devServer).origin;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Всем окнам: не уходить со страниц приложения и не открывать новых окон.
 *
 * Перезагрузку своей страницы (смена языка) пропускаем — это тоже
 * навигация. Главное окно ставит свой обработчик window.open после
 * создания, он заменяет этот и открывает http(s)-ссылки в браузере.
 */
export function guardWebContents(app: App, isTrusted: (url: string) => boolean): void {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (e, url) => {
      if (!isTrusted(url)) e.preventDefault();
    });
    contents.on('will-redirect', (e, url) => {
      if (!isTrusted(url)) e.preventDefault();
    });
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

type SenderEvent = Pick<IpcMainEvent | IpcMainInvokeEvent, 'senderFrame'>;

/** Отправитель — страница приложения (не чужой адрес и не вложенный фрейм). */
export function fromApp(event: SenderEvent, isTrusted: (url: string) => boolean): boolean {
  const frame = event.senderFrame;
  if (!frame) return false;
  // Фреймов у Горна нет: сообщение из вложенного — заведомо чужое.
  if (frame.parent) return false;
  return isTrusted(frame.url);
}

/**
 * Проверка отправителя у всех обработчиков IPC сразу, включая
 * зарегистрированные в других модулях (тюрьма). Обёртка подменяет
 * handle/on/once одного объекта ipcMain — зовётся до регистрации.
 */
export function guardIpc(ipc: IpcMain, isTrusted: (url: string) => boolean): void {
  const handle = ipc.handle.bind(ipc);
  const on = ipc.on.bind(ipc);
  const once = ipc.once.bind(ipc);
  const reject = (channel: string, event: SenderEvent) =>
    console.warn(`[безопасность] ${channel}: чужой отправитель ${event.senderFrame?.url ?? '?'}`);

  ipc.handle = (channel, listener) =>
    handle(channel, (event, ...args) => {
      if (!fromApp(event, isTrusted)) {
        reject(channel, event);
        throw new Error('forbidden');
      }
      return listener(event, ...args);
    });
  const wrap =
    (channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void) =>
    (event: IpcMainEvent, ...args: any[]) => {
      if (!fromApp(event, isTrusted)) return reject(channel, event);
      listener(event, ...args);
    };
  ipc.on = (channel, listener) => on(channel, wrap(channel, listener));
  ipc.once = (channel, listener) => once(channel, wrap(channel, listener));
}
