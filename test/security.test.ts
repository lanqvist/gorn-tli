import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IpcMain } from 'electron';

import { fromApp, guardIpc, isAppUrl } from '../src/main/security.js';

const rendererDir = join(process.cwd(), 'dist', 'renderer');
const own = pathToFileURL(join(rendererDir, 'overlay.html')).href;

describe('isAppUrl', () => {
  it('пускает свои файлы renderer', () => {
    expect(isAppUrl(own, rendererDir)).toBe(true);
    expect(isAppUrl(own + '?lang=en#x', rendererDir)).toBe(true);
  });

  it('не пускает чужие адреса и чужие файлы', () => {
    expect(isAppUrl('https://evil.example/', rendererDir)).toBe(false);
    expect(isAppUrl(pathToFileURL(join(rendererDir, '..', 'main', 'index.js')).href, rendererDir)).toBe(false);
    // «..» внутри URL разбирается до сравнения.
    expect(isAppUrl(own.replace('overlay.html', '../../secret.html'), rendererDir)).toBe(false);
    // Соседняя папка с тем же началом имени.
    expect(isAppUrl(pathToFileURL(rendererDir + '-evil/x.html').href, rendererDir)).toBe(false);
    expect(isAppUrl('не адрес', rendererDir)).toBe(false);
  });

  it('dev-сервер — только его origin', () => {
    const dev = 'http://localhost:5173/';
    expect(isAppUrl('http://localhost:5173/overlay.html', rendererDir, dev)).toBe(true);
    expect(isAppUrl('http://localhost:5174/overlay.html', rendererDir, dev)).toBe(false);
    expect(isAppUrl('http://localhost:5173/', rendererDir)).toBe(false);
  });
});

describe('IPC: только от страниц приложения', () => {
  const trusted = (url: string) => isAppUrl(url, rendererDir);
  const frame = (url: string, parent: unknown = null) => ({ senderFrame: { url, parent } }) as never;

  it('fromApp смотрит на адрес и на вложенность фрейма', () => {
    expect(fromApp(frame(own), trusted)).toBe(true);
    expect(fromApp(frame('https://evil.example/'), trusted)).toBe(false);
    expect(fromApp(frame(own, {}), trusted)).toBe(false);
    expect(fromApp({ senderFrame: null } as never, trusted)).toBe(false);
  });

  it('guardIpc отсекает чужого отправителя у handle и on', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipc = {
      handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
      on: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
      once: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    } as unknown as IpcMain;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    guardIpc(ipc, trusted);

    const install = vi.fn();
    ipc.handle('app:setAutoStart', (_e, v: boolean) => v);
    ipc.on('update:install', install);

    expect(handlers.get('app:setAutoStart')!(frame(own), true)).toBe(true);
    expect(() => handlers.get('app:setAutoStart')!(frame('https://evil.example/'), true)).toThrow();

    handlers.get('update:install')!(frame('https://evil.example/'));
    expect(install).not.toHaveBeenCalled();
    handlers.get('update:install')!(frame(own));
    expect(install).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
