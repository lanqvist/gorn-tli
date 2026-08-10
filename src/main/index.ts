import { app, BrowserWindow, globalShortcut, ipcMain, shell } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DebugSink } from './debug.js';
import { Engine, type Snapshot } from './engine.js';
import { IconCache, registerIconScheme } from './icons.js';
import { Overlay } from './overlay.js';
import { SettingsStore, type NameLanguage, type OverlayMode } from './settings.js';
import { ToastLayer } from './toastLayer.js';
import { Updater, type UpdateState } from './updater.js';

// Схему нужно объявить до готовности приложения.
registerIconScheme();

// Два экземпляра делят одну базу и один файл настроек — это гонки записи
// и SQLITE_BUSY на ровном месте. Второй экземпляр просто поднимает первый.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

let window: BrowserWindow | null = null;
let engine: Engine | null = null;
let latest: Snapshot | null = null;
let overlay: Overlay | null = null;
let toastLayer: ToastLayer | null = null;
let settings: SettingsStore | null = null;
let debugSink: DebugSink | null = null;
let updater: Updater | null = null;

interface CatalogueItem {
  id: number;
  name: string;
  nameRu: string | null;
  icon: string | null;
}

function loadItems(): CatalogueItem[] {
  const candidates = [
    join(__dirname, '../../data/items.json'),
    join(process.resourcesPath ?? '', 'data/items.json'),
  ];
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as CatalogueItem[];
    } catch {
      continue;
    }
  }
  return [];
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#0e0f13',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.once('ready-to-show', () => window?.show());

  // На Windows закрытие главного окна — это выход. Без этого открытый
  // оверлей не давал сработать window-all-closed, и приложение зависало
  // фоновым процессом без единого способа вернуть дашборд.
  window.on('closed', () => {
    window = null;
    overlay?.close(false);
    toastLayer?.close();
  });

  // В режиме диагностики поднимаем сообщения из renderer наверх: иначе
  // нарушения политики безопасности видны только в devtools.
  if (isDev || process.argv.some((a) => a.startsWith('--capture='))) {
    window.webContents.on('console-message', (...args: unknown[]) => {
      const detail = args.find((a) => typeof a === 'object' && a !== null && 'message' in a) as
        | { level?: unknown; message?: unknown }
        | undefined;
      console.log('[renderer]', detail ? `${detail.level}: ${detail.message}` : args.slice(1));
    });
  }

  // Внешние ссылки открываем в браузере, а не внутри приложения.
  // Только http/https: file: и прочие схемы в openExternal — дыра.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (e) => e.preventDefault());

  if (isDev && process.env['VITE_DEV_SERVER_URL']) {
    void window.loadURL(process.env['VITE_DEV_SERVER_URL']);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  const items = loadItems();

  const icons = new IconCache(app.getPath('userData'), items);
  icons.install();

  createWindow();

  settings = new SettingsStore(app.getPath('userData'));
  overlay = new Overlay(settings);
  toastLayer = new ToastLayer(settings);
  engine = new Engine(app.getPath('userData'), items, settings.itemNames, {
    communityPrices: settings.communityPrices,
  });

  // Кнопка «Оверлей» в шапке обязана отражать реальность и когда оверлей
  // переключили хоткеем или закрыли его собственным крестиком.
  overlay.onOpenChanged = (open) => {
    if (window && !window.isDestroyed()) window.webContents.send('overlay:enabled', open);
  };

  // Не `--debug`: этот флаг перехватывает сам Node как устаревший отладчик
  // и до приложения он не доходит.
  const debugArg = process.argv.find((a) => a.startsWith('--observe='));
  if (debugArg && window) {
    const dir = debugArg.slice('--observe='.length);
    debugSink = new DebugSink(dir);
    debugSink.attach(window);
    console.log('[наблюдение] пишу в', dir);
  }

  engine.on('snapshot', (snapshot: Snapshot) => {
    latest = snapshot;
    if (window && !window.isDestroyed()) {
      window.webContents.send('snapshot', snapshot);
    }
    overlay?.send('snapshot', snapshot);
    toastLayer?.send('snapshot', snapshot);
    debugSink?.record(snapshot);
  });
  engine.on('error', (err: Error) => {
    console.error('[движок]', err.message);
  });
  engine.on('scanProgress', (progress: unknown) => {
    if (window && !window.isDestroyed()) window.webContents.send('scan:progress', progress);
  });

  ipcMain.handle('snapshot:get', () => latest);

  updater = new Updater();
  updater.on('state', (state: UpdateState) => {
    if (window && !window.isDestroyed()) window.webContents.send('update:state', state);
  });

  ipcMain.handle('update:get', () => updater?.current ?? null);
  ipcMain.handle('update:download', () => updater?.download());
  ipcMain.on('update:install', () => updater?.install());

  ipcMain.handle('settings:itemNames', () => settings?.itemNames ?? 'ru');
  ipcMain.handle('settings:setItemNames', (_e, language: NameLanguage) => {
    settings?.setItemNames(language);
    engine?.setLanguage(language);
    return language;
  });

  ipcMain.handle('settings:communityPrices', () => settings?.communityPrices ?? true);
  ipcMain.handle('settings:setCommunityPrices', (_e, enabled: boolean) => {
    settings?.setCommunityPrices(enabled);
    engine?.setCommunityPrices(enabled);
    return enabled;
  });

  ipcMain.handle('overlay:state', () => settings?.overlay ?? null);
  ipcMain.handle('overlay:toggle', () => {
    overlay?.toggle();
    return overlay?.isOpen ?? false;
  });
  ipcMain.on('overlay:close', () => overlay?.close());
  ipcMain.on('overlay:setMode', (_e, mode: OverlayMode) => overlay?.setMode(mode));
  ipcMain.on('overlay:cycleMode', () => overlay?.cycleMode());
  ipcMain.on('overlay:toggleLock', () => overlay?.toggleLocked());
  ipcMain.on('overlay:setOpacity', (_e, value: number) => overlay?.setOpacity(value));
  ipcMain.on('overlay:height', (_e, height: number) => overlay?.setContentHeight(height));
  ipcMain.on(
    'overlay:setPrefs',
    (_e, prefs: { popups?: boolean; sound?: boolean; volume?: number }) => {
      overlay?.patchPrefs(prefs);
      // Слой всплывашек живёт своим окном: настройки долетают и туда,
      // а само окно появляется и исчезает вслед за ними.
      toastLayer?.sync();
      const current = settings?.overlay;
      if (current) {
        toastLayer?.send('overlay:prefs', {
          popups: current.popups,
          sound: current.sound,
          volume: current.volume,
        });
      }
    },
  );

  ipcMain.on('toasts:height', (_e, height: number) => toastLayer?.setContentHeight(height));
  ipcMain.on('toasts:active', (_e, active: boolean) => toastLayer?.setActive(active));

  registerShortcuts();

  if (settings.overlay.enabled) overlay.open();
  // Слой всплывашек независим от оверлея-панели: доход у центра экрана
  // показывается и тем, кто панель не держит.
  toastLayer.sync();

  await engine.start();

  // Иконки виденных предметов подтягиваем фоном, чтобы они уже лежали
  // на диске к моменту, когда игрок войдёт в карту.
  void icons.prefetch(engine.seenItemIds()).then((n) => {
    if (n > 0) console.log(`[иконки] загружено ${n}`);
  });

  // Проверку обновлений откладываем: разбор логов при старте важнее,
  // и незачем соревноваться с ним за диск и сеть.
  setTimeout(() => void updater?.check(), 8000);

  await maybeCapture();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * Диагностический снимок окна: `--capture=<файл>`.
 *
 * Нужен, чтобы можно было посмотреть на реально запущенное приложение —
 * проверка вёрстки в браузере не ловит проблемы, которые возникают только
 * с настоящими данными и настоящим мостом в main.
 */
async function maybeCapture(): Promise<void> {
  const arg = process.argv.find((a) => a.startsWith('--capture='));
  if (!arg || !window) return;

  const file = arg.slice('--capture='.length);
  const delay = Number(process.env['CAPTURE_DELAY_MS'] ?? 6000);
  await new Promise((resolve) => setTimeout(resolve, delay));

  try {
    const probe = await window.webContents.executeJavaScript(`(async () => {
      const out = { imgs: 0, placeholders: 0, srcs: [], fetch: null, imgLoad: null };
      out.imgs = document.querySelectorAll('.drops img').length;
      out.placeholders = document.querySelectorAll('.drops .no-icon').length;
      out.srcs = [...document.querySelectorAll('.drops img')].slice(0, 3).map(i => i.src);
      try {
        const r = await fetch('gorn-icon://item/100300.webp');
        out.fetch = r.status + ' ' + r.headers.get('content-type') + ' ' + (await r.blob()).size + 'b';
      } catch (e) { out.fetch = 'ОШИБКА: ' + e.message; }
      out.imgLoad = await new Promise(res => {
        const i = new Image();
        i.onload = () => res('загрузилась ' + i.naturalWidth + 'px');
        i.onerror = () => res('НЕ загрузилась');
        i.src = 'gorn-icon://item/100300.webp';
        setTimeout(() => res('таймаут'), 3000);
      });
      return out;
    })()`);
    console.log('[проверка иконок]', JSON.stringify(probe));

    const image = await window.webContents.capturePage();
    writeFileSync(file, image.toPNG());
    console.log(`[снимок] ${file}`);

    // Второй снимок — нижняя часть страницы: capturePage снимает только
    // видимую область, а интересное часто ниже сгиба.
    await window.webContents.executeJavaScript(
      'window.scrollTo(0, document.body.scrollHeight)',
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const bottom = await window.webContents.capturePage();
    writeFileSync(file.replace(/\.png$/, '-low.png'), bottom.toPNG());
  } catch (err) {
    console.error('[снимок] не удался:', (err as Error).message);
  }
  app.quit();
}

/**
 * Горячие клавиши.
 *
 * globalShortcut в Electron не всегда доходит до приложения, пока фокус
 * держит игра: часть игр перехватывает ввод раньше. Это известное
 * ограничение, и обходится оно только низкоуровневым хуком клавиатуры —
 * тем же примитивом, что используют кейлоггеры. В инструменте для игры
 * с непредсказуемым анти-читом это плохой размен, поэтому остаёмся
 * на штатном механизме и честно пишем про ограничение в README.
 *
 * Сочетания намеренно редкие: пересечься с игровыми биндами почти нечем.
 */
function registerShortcuts(): void {
  const bindings: Array<[string, () => void]> = [
    ['Control+Alt+G', () => overlay?.toggle()],
    ['Control+Alt+L', () => overlay?.toggleLocked()],
    ['Control+Alt+M', () => overlay?.cycleMode()],
  ];

  for (const [accelerator, handler] of bindings) {
    const ok = globalShortcut.register(accelerator, handler);
    if (!ok) console.warn(`[хоткеи] не удалось занять ${accelerator} — занято другой программой`);
  }
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  engine?.stop();
  engine = null;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  debugSink?.stop();
  debugSink = null;
  engine?.stop();
  engine = null;
});
