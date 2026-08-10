import type { Snapshot } from '../main/engine.js';
import type { OverlayMode } from '../main/settings.js';

/**
 * Единственное объявление моста в renderer. Раньше оно дублировалось
 * в дашборде и в оверлее — два несовпадающих описания одного и того же
 * глобального объекта рано или поздно расходятся.
 */
declare global {
  interface GornOverlayApi {
    getState: () => Promise<{
      enabled: boolean;
      mode: OverlayMode;
      locked: boolean;
      opacity: number;
      fontScale: number;
    }>;
    toggle: () => Promise<boolean>;
    close: () => void;
    setMode: (mode: OverlayMode) => void;
    cycleMode: () => void;
    toggleLock: () => void;
    setOpacity: (value: number) => void;
    reportHeight: (height: number) => void;
    onMode: (cb: (mode: OverlayMode) => void) => () => void;
    onLocked: (cb: (locked: boolean) => void) => () => void;
  }

  interface GornApi {
    getSnapshot: () => Promise<Snapshot | null>;
    onSnapshot: (cb: (snapshot: Snapshot) => void) => () => void;
    overlay: GornOverlayApi;
  }

  interface Window {
    /** Отсутствует в обычном браузере — там показываются демо-данные. */
    gorn: GornApi;
  }
}

export {};
