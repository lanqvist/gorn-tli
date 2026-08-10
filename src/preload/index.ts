import { contextBridge, ipcRenderer } from 'electron';

/**
 * Renderer получает только готовые срезы и не имеет доступа ни к файловой
 * системе, ни к Node. Весь разбор лога происходит в main-процессе.
 */
contextBridge.exposeInMainWorld('gorn', {
  /** Текущий срез — нужен при первой отрисовке до прихода событий. */
  getSnapshot: () => ipcRenderer.invoke('snapshot:get'),

  /** Подписка на обновления. Возвращает функцию отписки. */
  onSnapshot: (callback: (snapshot: unknown) => void) => {
    const handler = (_event: unknown, snapshot: unknown) => callback(snapshot);
    ipcRenderer.on('snapshot', handler);
    return () => ipcRenderer.removeListener('snapshot', handler);
  },
});
