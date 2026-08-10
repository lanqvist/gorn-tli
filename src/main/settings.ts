import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Режимы оверлея — от самого компактного к подробному. */
export type OverlayMode = 'minimal' | 'compact' | 'full';

export interface OverlayPlacement {
  x: number;
  y: number;
  /** Идентификатор монитора: позиция запоминается для каждого отдельно. */
  displayId: number;
}

/** Язык названий предметов. */
export type NameLanguage = 'ru' | 'en' | 'both';

export interface Settings {
  /** Русские названия покрывают 96% справочника, поэтому это разумное умолчание.
   *  Часть игроков привыкла к английским — отсюда переключатель. */
  itemNames: NameLanguage;
  /**
   * Первичные цены из краудсорс-базы TITrack (titrack.ninja). Убирают
   * необходимость пробивать каждый предмет руками; свои пробивки всегда
   * в приоритете. Отключается для полностью офлайновой работы.
   */
  communityPrices: boolean;
  /**
   * Папка логов, указанная вручную. null — автопоиск по Steam-библиотекам.
   * Ручной путь нужен не-Steam установкам и нестандартным дискам.
   */
  logDir: string | null;
  /** Закрытие окна сворачивает в трей: трекер живёт фоном часами. */
  closeToTray: boolean;
  /** Запуск вместе с Windows: трекер полезен, только если уже запущен. */
  autoStart: boolean;
  overlay: {
    enabled: boolean;
    mode: OverlayMode;
    /** Заблокирован — значит клики проходят сквозь него в игру. */
    locked: boolean;
    opacity: number;
    fontScale: number;
    placement: OverlayPlacement | null;
    /** Всплывающий доход: «+N ФЕ» при подборе, итог при закрытии карты. */
    popups: boolean;
    /** Звук подбора и закрытия карты. */
    sound: boolean;
    /** Громкость звука, 0–1. */
    volume: number;
    /** Озвучивать только золотые находки и итог карты. */
    soundImportantOnly: boolean;
    /** Порог «золотой» находки, в ФЕ. */
    jackpotFe: number;
    /** Первое включение оверлея уже было — больше не открывать открепленным. */
    introShown: boolean;
  };
}

const DEFAULTS: Settings = {
  itemNames: 'ru',
  communityPrices: true,
  logDir: null,
  closeToTray: false,
  autoStart: false,
  overlay: {
    enabled: false,
    mode: 'compact',
    locked: true,
    opacity: 0.9,
    fontScale: 1,
    placement: null,
    popups: true,
    sound: true,
    volume: 0.5,
    soundImportantOnly: false,
    jackpotFe: 50,
    introShown: false,
  },
};

/**
 * Настройки в обычном JSON рядом с базой.
 *
 * Схема версионируется с самого начала: у Currency Cop обновление сломало
 * миграцию локального хранилища, и пользователи теряли доступ к своим данным.
 */
const SCHEMA_VERSION = 1;

export class SettingsStore {
  private path: string;
  private data: Settings;

  constructor(userDataDir: string) {
    this.path = join(userDataDir, 'settings.json');
    this.data = this.load();
  }

  private load(): Settings {
    if (!existsSync(this.path)) return structuredClone(DEFAULTS);
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as {
        version?: number;
        settings?: Partial<Settings>;
      };
      if (raw.version !== SCHEMA_VERSION || !raw.settings) return structuredClone(DEFAULTS);
      return {
        itemNames: raw.settings.itemNames ?? DEFAULTS.itemNames,
        communityPrices: raw.settings.communityPrices ?? DEFAULTS.communityPrices,
        logDir: raw.settings.logDir ?? DEFAULTS.logDir,
        closeToTray: raw.settings.closeToTray ?? DEFAULTS.closeToTray,
        autoStart: raw.settings.autoStart ?? DEFAULTS.autoStart,
        overlay: { ...DEFAULTS.overlay, ...raw.settings.overlay },
      };
    } catch {
      // Битый файл не должен мешать запуску.
      return structuredClone(DEFAULTS);
    }
  }

  get overlay(): Settings['overlay'] {
    return this.data.overlay;
  }

  get itemNames(): NameLanguage {
    return this.data.itemNames;
  }

  setItemNames(language: NameLanguage): void {
    this.data.itemNames = language;
    this.save();
  }

  get communityPrices(): boolean {
    return this.data.communityPrices;
  }

  setCommunityPrices(enabled: boolean): void {
    this.data.communityPrices = enabled;
    this.save();
  }

  get logDir(): string | null {
    return this.data.logDir;
  }

  setLogDir(dir: string | null): void {
    this.data.logDir = dir;
    this.save();
  }

  get closeToTray(): boolean {
    return this.data.closeToTray;
  }

  setCloseToTray(enabled: boolean): void {
    this.data.closeToTray = enabled;
    this.save();
  }

  get autoStart(): boolean {
    return this.data.autoStart;
  }

  setAutoStart(enabled: boolean): void {
    this.data.autoStart = enabled;
    this.save();
  }

  patchOverlay(patch: Partial<Settings['overlay']>): Settings['overlay'] {
    this.data.overlay = { ...this.data.overlay, ...patch };
    this.save();
    return this.data.overlay;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      // Запись через временный файл: краш посреди записи иначе оставляет
      // битый JSON, и все настройки молча слетают в умолчания.
      const tmp = `${this.path}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ version: SCHEMA_VERSION, settings: this.data }, null, 2),
        'utf8',
      );
      renameSync(tmp, this.path);
    } catch {
      // Настройки — не критичные данные, потеря не повод падать.
    }
  }
}
