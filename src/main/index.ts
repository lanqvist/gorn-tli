import { app, BrowserWindow, globalShortcut, ipcMain, shell } from 'electron';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Engine, type Snapshot } from './engine.js';
import { IconCache, registerIconScheme } from './icons.js';
import { Overlay } from './overlay.js';
import { SettingsStore, type OverlayMode } from './settings.js';

// Схему нужно объявить до готовности приложения.
registerIconScheme();

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

let window: BrowserWindow | null = null;
let engine: Engine | null = null;
let latest: Snapshot | null = null;
let overlay: Overlay | null = null;
let settings: SettingsStore | null = null;

function loadItems(): Array<{ id: number; name: string; icon: string | null }> {
  const candidates = [
    join(__dirname, '../../data/items.json'),
    join(process.resourcesPath ?? '', 'data/items.json'),
  ];
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Array<{
        id: number;
        name: string;
        icon: string | null;
      }>;
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

  // Внешние ссылки открываем в браузере, а не внутри приложения.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

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

  engine = new Engine(app.getPath('userData'), items);
  settings = new SettingsStore(app.getPath('userData'));
  overlay = new Overlay(settings);

  engine.on('snapshot', (snapshot: Snapshot) => {
    latest = snapshot;
    if (window && !window.isDestroyed()) {
      window.webContents.send('snapshot', snapshot);
    }
    overlay?.send('snapshot', snapshot);
  });
  engine.on('error', (err: Error) => {
    console.error('[движок]', err.message);
  });

  ipcMain.handle('snapshot:get', () => latest);

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

  registerShortcuts();

  if (settings.overlay.enabled) overlay.open();

  await engine.start();

  // Иконки виденных предметов подтягиваем фоном, чтобы они уже лежали
  // на диске к моменту, когда игрок войдёт в карту.
  void icons.prefetch(engine.seenItemIds()).then((n) => {
    if (n > 0) console.log(`[иконки] загружено ${n}`);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

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
  engine?.stop();
  engine = null;
});
