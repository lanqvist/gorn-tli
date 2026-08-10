import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  overlay: {
    enabled: boolean;
    mode: OverlayMode;
    /** Заблокирован — значит клики проходят сквозь него в игру. */
    locked: boolean;
    opacity: number;
    fontScale: number;
    placement: OverlayPlacement | null;
  };
}

const DEFAULTS: Settings = {
  itemNames: 'ru',
  overlay: {
    enabled: false,
    mode: 'compact',
    locked: true,
    opacity: 0.9,
    fontScale: 1,
    placement: null,
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

  patchOverlay(patch: Partial<Settings['overlay']>): Settings['overlay'] {
    this.data.overlay = { ...this.data.overlay, ...patch };
    this.save();
    return this.data.overlay;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(
        this.path,
        JSON.stringify({ version: SCHEMA_VERSION, settings: this.data }, null, 2),
        'utf8',
      );
    } catch {
      // Настройки — не критичные данные, потеря не повод падать.
    }
  }
}
