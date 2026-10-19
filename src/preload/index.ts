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

  /** Новая сессия: счётчики с нуля, история никуда не девается. */
  session: {
    reset: () => ipcRenderer.invoke('session:reset'),
  },

  /** История забегов: поиск и выгрузка — по запросу, не в каждом срезе. */
  runs: {
    query: (query: string) => ipcRenderer.invoke('runs:query', query),
    exportCsv: () => ipcRenderer.invoke('runs:exportCsv'),
  },

  /** Цены: история своих пробивок и исключение из учёта. */
  prices: {
    query: (query: string) => ipcRenderer.invoke('prices:query', query),
    setExcluded: (configBaseId: number, excluded: boolean) =>
      ipcRenderer.invoke('items:setExcluded', configBaseId, excluded),
  },

  /** Порог «мелочи» в списках добычи, ФЕ. */
  setMinDropFe: (value: number) => ipcRenderer.invoke('settings:setMinDropFe', value),

  /** Язык интерфейса. При смене окна перезагружаются сами. */
  getUiLanguage: () => ipcRenderer.invoke('settings:uiLanguage'),
  setUiLanguage: (language: string) => ipcRenderer.invoke('settings:setUiLanguage', language),
  onUiLanguage: (callback: (language: string) => void) => {
    const handler = (_e: unknown, language: string) => callback(language);
    ipcRenderer.on('ui:language', handler);
    return () => ipcRenderer.removeListener('ui:language', handler);
  },

  /**
   * Чьи забеги показывать: персонаж (null — все) и все ли сезоны.
   * Выбор запоминается.
   */
  setRunScope: (scope: { playerId: string | null; allSeasons: boolean }) =>
    ipcRenderer.invoke('settings:setRunScope', scope),

  update: {
    get: () => ipcRenderer.invoke('update:get'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.send('update:install'),
    onState: (callback: (state: unknown) => void) => {
      const handler = (_e: unknown, state: unknown) => callback(state);
      ipcRenderer.on('update:state', handler);
      return () => ipcRenderer.removeListener('update:state', handler);
    },
  },

  /** Панель настроек: системные вещи за пределами оверлея. */
  settings: {
    get: () => ipcRenderer.invoke('app:settings'),
    setCloseToTray: (enabled: boolean) => ipcRenderer.invoke('app:setCloseToTray', enabled),
    setAutoStart: (enabled: boolean) => ipcRenderer.invoke('app:setAutoStart', enabled),
    chooseLogDir: () => ipcRenderer.invoke('app:chooseLogDir'),
    resetLogDir: () => ipcRenderer.invoke('app:resetLogDir'),
    relaunch: () => ipcRenderer.send('app:relaunch'),
  },

  /** Язык названий предметов: русские, английские или оба. */
  getItemNames: () => ipcRenderer.invoke('settings:itemNames'),
  setItemNames: (language: string) => ipcRenderer.invoke('settings:setItemNames', language),

  /** Первичные цены сообщества: включение и отключение. */
  getCommunityPrices: () => ipcRenderer.invoke('settings:communityPrices'),
  setCommunityPrices: (enabled: boolean) =>
    ipcRenderer.invoke('settings:setCommunityPrices', enabled),

  /** Подсказки в сезонной тюрьме: включение и окно стрелок. */
  getPrisonHints: () => ipcRenderer.invoke('settings:prisonHints'),
  setPrisonHints: (enabled: boolean) => ipcRenderer.invoke('settings:setPrisonHints', enabled),
  getPrisonSaveShots: () => ipcRenderer.invoke('settings:prisonSaveShots'),
  setPrisonSaveShots: (enabled: boolean) => ipcRenderer.invoke('settings:setPrisonSaveShots', enabled),
  openPrisonShots: () => ipcRenderer.invoke('settings:openPrisonShots'),
  prison: {
    /** Страница стрелок подписалась и готова принимать подсказки. */
    ready: () => ipcRenderer.send('prison:ready'),
    onHint: (callback: (hint: unknown) => void) => {
      const handler = (_e: unknown, hint: unknown) => callback(hint);
      ipcRenderer.on('prison:hint', handler);
      return () => ipcRenderer.removeListener('prison:hint', handler);
    },
    onSettled: (callback: (live: boolean) => void) => {
      const handler = (_e: unknown, live: boolean) => callback(live);
      ipcRenderer.on('prison:settled', handler);
      return () => ipcRenderer.removeListener('prison:settled', handler);
    },
  },

  /** Скрытое окно с потоком экрана для подсказок в тюрьме. */
  capture: {
    onStart: (callback: (req: { sourceId: string; width: number; height: number }) => void) => {
      const handler = (_e: unknown, req: { sourceId: string; width: number; height: number }) => callback(req);
      ipcRenderer.on('capture:start', handler);
      return () => ipcRenderer.removeListener('capture:start', handler);
    },
    onStop: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('capture:stop', handler);
      return () => ipcRenderer.removeListener('capture:stop', handler);
    },
    onGrab: (callback: (id: number, stableMs: number, maxMs: number, okAgeMs: number) => void) => {
      const handler = (_e: unknown, id: number, stableMs: number, maxMs: number, okAgeMs: number) => callback(id, stableMs, maxMs, okAgeMs);
      ipcRenderer.on('capture:grab', handler);
      return () => ipcRenderer.removeListener('capture:grab', handler);
    },
    started: (err: string | null) => ipcRenderer.send('capture:started', err),
    frame: (id: number, frame: { width: number; height: number; buffer: ArrayBuffer } | null, err: string | null) =>
      ipcRenderer.send('capture:frame', id, frame, err),
  },

  /** Пульт поверх игры: открывается клавишей, закрывается по Esc. */
  panel: {
    onOpen: (callback: (req: { tab: string | null; scale: number }) => void) => {
      const handler = (_e: unknown, req: { tab: string | null; scale: number }) => callback(req);
      ipcRenderer.on('panel:open', handler);
      return () => ipcRenderer.removeListener('panel:open', handler);
    },
    onHidden: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('panel:hidden', handler);
      return () => ipcRenderer.removeListener('panel:hidden', handler);
    },
    /** Страница подписалась — main может её показывать. */
    ready: () => ipcRenderer.send('panel:ready'),
    close: () => ipcRenderer.send('panel:close'),
    setTab: (tab: string) => ipcRenderer.send('panel:tab', tab),
  },

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
