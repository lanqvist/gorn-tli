import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Engine, type Snapshot } from './engine.js';
import { IconCache, registerIconScheme } from './icons.js';

// Схему нужно объявить до готовности приложения.
registerIconScheme();

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

let window: BrowserWindow | null = null;
let engine: Engine | null = null;
let latest: Snapshot | null = null;

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
  engine.on('snapshot', (snapshot: Snapshot) => {
    latest = snapshot;
    if (window && !window.isDestroyed()) {
      window.webContents.send('snapshot', snapshot);
    }
  });
  engine.on('error', (err: Error) => {
    console.error('[движок]', err.message);
  });

  ipcMain.handle('snapshot:get', () => latest);

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

app.on('window-all-closed', () => {
  engine?.stop();
  engine = null;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  engine?.stop();
  engine = null;
});
