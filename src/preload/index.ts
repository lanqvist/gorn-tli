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

  /** Прогресс разбора накопленных логов — для заглушки первого запуска. */
  onScanProgress: (callback: (progress: unknown) => void) => {
    const handler = (_event: unknown, progress: unknown) => callback(progress);
    ipcRenderer.on('scan:progress', handler);
    return () => ipcRenderer.removeListener('scan:progress', handler);
  },

  update: {
    get: () => ipcRenderer.invoke('update:get'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.send('update:install'),
    onState: (callback: (state: unknown) => void) => {
      const handler = (_e: unknown, state: unknown) => callback(state);
      ipcRenderer.on('update:state', handler);
      return () => ipcRenderer.removeListener('update:state', handler);
    },
  },

  /** Язык названий предметов: русские, английские или оба. */
  getItemNames: () => ipcRenderer.invoke('settings:itemNames'),
  setItemNames: (language: string) => ipcRenderer.invoke('settings:setItemNames', language),

  /** Первичные цены сообщества: включение и отключение. */
  getCommunityPrices: () => ipcRenderer.invoke('settings:communityPrices'),
  setCommunityPrices: (enabled: boolean) =>
    ipcRenderer.invoke('settings:setCommunityPrices', enabled),

  /** Слой всплывающего дохода у центра экрана. */
  toasts: {
    reportHeight: (height: number) => ipcRenderer.send('toasts:height', height),
    /** Есть плашки — окно видно; кончились — главный процесс его прячет. */
    reportActive: (active: boolean) => ipcRenderer.send('toasts:active', active),
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

    /** Открыт ли оверлей — для кнопки в шапке главного окна. */
    onEnabled: (callback: (open: boolean) => void) => {
      const handler = (_e: unknown, open: boolean) => callback(open);
      ipcRenderer.on('overlay:enabled', handler);
      return () => ipcRenderer.removeListener('overlay:enabled', handler);
    },

    /** Настройки всплывашек и звука. */
    setPrefs: (prefs: { popups?: boolean; sound?: boolean; volume?: number }) =>
      ipcRenderer.send('overlay:setPrefs', prefs),
    onPrefs: (callback: (prefs: unknown) => void) => {
      const handler = (_e: unknown, prefs: unknown) => callback(prefs);
      ipcRenderer.on('overlay:prefs', handler);
      return () => ipcRenderer.removeListener('overlay:prefs', handler);
    },
  },
});
