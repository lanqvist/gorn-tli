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

  overlay: {
    /** Текущие настройки оверлея. */
    getState: () => ipcRenderer.invoke('overlay:state'),
    toggle: () => ipcRenderer.invoke('overlay:toggle'),
    close: () => ipcRenderer.send('overlay:close'),
    setMode: (mode: string) => ipcRenderer.send('overlay:setMode', mode),
    cycleMode: () => ipcRenderer.send('overlay:cycleMode'),
    toggleLock: () => ipcRenderer.send('overlay:toggleLock'),
    setOpacity: (value: number) => ipcRenderer.send('overlay:setOpacity', value),
    /** Интерфейс сообщает свою высоту, чтобы окно было ровно по содержимому. */
    reportHeight: (height: number) => ipcRenderer.send('overlay:height', height),

    onMode: (callback: (mode: string) => void) => {
      const handler = (_e: unknown, mode: string) => callback(mode);
      ipcRenderer.on('overlay:mode', handler);
      return () => ipcRenderer.removeListener('overlay:mode', handler);
    },
    onLocked: (callback: (locked: boolean) => void) => {
      const handler = (_e: unknown, locked: boolean) => callback(locked);
      ipcRenderer.on('overlay:locked', handler);
      return () => ipcRenderer.removeListener('overlay:locked', handler);
    },
  },
});
