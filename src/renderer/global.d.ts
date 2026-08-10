import type { RetroScanProgress } from '../core/retroScan.js';
import type { Snapshot } from '../main/engine.js';
import type { OverlayMode } from '../main/settings.js';
import type { UpdateState } from '../main/updater.js';

/**
 * Единственное объявление моста в renderer. Раньше оно дублировалось
 * в дашборде и в оверлее — два несовпадающих описания одного и того же
 * глобального объекта рано или поздно расходятся.
 */
declare global {
  interface GornOverlayPrefs {
    popups: boolean;
    sound: boolean;
    volume: number;
  }

  interface GornOverlayApi {
    getState: () => Promise<{
      enabled: boolean;
      mode: OverlayMode;
      locked: boolean;
      opacity: number;
      fontScale: number;
      popups: boolean;
      sound: boolean;
      volume: number;
    }>;
    toggle: () => Promise<boolean>;
    close: () => void;
    setMode: (mode: OverlayMode) => void;
    cycleMode: () => void;
    toggleLock: () => void;
    setOpacity: (value: number) => void;
    reportHeight: (height: number) => void;
    setPrefs: (prefs: Partial<GornOverlayPrefs>) => void;
    onMode: (cb: (mode: OverlayMode) => void) => () => void;
    onLocked: (cb: (locked: boolean) => void) => () => void;
    onEnabled: (cb: (open: boolean) => void) => () => void;
    onPrefs: (cb: (prefs: GornOverlayPrefs) => void) => () => void;
  }

  type NameLanguage = 'ru' | 'en' | 'both';

  interface GornApi {
    getSnapshot: () => Promise<Snapshot | null>;
    onSnapshot: (cb: (snapshot: Snapshot) => void) => () => void;
    onScanProgress: (cb: (progress: RetroScanProgress) => void) => () => void;
    getItemNames: () => Promise<NameLanguage>;
    setItemNames: (language: NameLanguage) => Promise<NameLanguage>;
    getCommunityPrices: () => Promise<boolean>;
    setCommunityPrices: (enabled: boolean) => Promise<boolean>;
    toasts: {
      reportHeight: (height: number) => void;
      reportActive: (active: boolean) => void;
    };
    overlay: GornOverlayApi;
    update: {
      get: () => Promise<UpdateState | null>;
      download: () => Promise<void>;
      install: () => void;
      onState: (cb: (state: UpdateState) => void) => () => void;
    };
  }

  interface Window {
    /** Отсутствует в обычном браузере — там показываются демо-данные. */
    gorn: GornApi;
  }
}

export {};
