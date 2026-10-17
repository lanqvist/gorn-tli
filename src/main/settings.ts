import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { isUiLanguage, languageForLocale, type UiLanguage } from '../core/i18n.js';

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
  /** Язык интерфейса. Не путать с itemNames — языком названий предметов. */
  uiLanguage: UiLanguage;
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
   * Подсказки в сезонной тюрьме: снимки окна игры по строкам лога и стрелки
   * поверх игры. Выключено по умолчанию — это единственное место, где
   * трекер смотрит на экран, а не только в лог.
   */
  prisonHints: boolean;
  /**
   * Папка логов, указанная вручную. null — автопоиск по Steam-библиотекам.
   * Ручной путь нужен не-Steam установкам и нестандартным дискам.
   */
  logDir: string | null;
  /**
   * Фильтр по персонажу: показывать только его забеги. null — все.
   * Хранится id строкой: значения не помещаются в double.
   */
  playerFilter: string | null;
  /**
   * Показывать забеги всех сезонов. По умолчанию — только текущего:
   * с началом сезона экономика обнуляется, и прошлые цифры описывают
   * другую игру.
   */
  allSeasons: boolean;
  /**
   * Предметы, исключённые из учёта: их добыча стоит ноль. Для того, что
   * формально имеет цену, но не продаётся, — и чтобы «Пробить цену»
   * перестало напоминать про мусор.
   */
  excludedItems: number[];
  /** Порог «мелочи» в ФЕ: дешевле него строки в списках добычи свёрнуты. 0 — показывать всё. */
  minDropFe: number;
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
    /** Свист на предмет дороже этого порога, в ФЕ. 0 — без свиста. */
    whistleFe: number;
    /** Первое включение оверлея уже было — больше не открывать открепленным. */
    introShown: boolean;
    /** Цель сессии в ФЕ: оверлей показывает прогресс. 0 — выключено. */
    goalFe: number;
  };
}

const DEFAULTS: Settings = {
  uiLanguage: 'ru',
  itemNames: 'ru',
  communityPrices: true,
  prisonHints: false,
  logDir: null,
  playerFilter: null,
  allSeasons: false,
  excludedItems: [],
  minDropFe: 0,
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
    whistleFe: 10,
    introShown: false,
    goalFe: 0,
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

  /**
   * @param systemLocale локаль системы — по ней выбирается язык новой
   *   установки. Существующие настройки без поля языка остаются русскими:
   *   до появления переключателя интерфейс был только русским.
   */
  constructor(userDataDir: string, systemLocale: string | null = null) {
    this.path = join(userDataDir, 'settings.json');
    this.systemLocale = systemLocale;
    this.data = this.load();
  }

  private readonly systemLocale: string | null;

  /** Умолчания новой установки: язык и названия предметов — по системе. */
  private fresh(): Settings {
    const uiLanguage = languageForLocale(this.systemLocale);
    return { ...structuredClone(DEFAULTS), uiLanguage, itemNames: uiLanguage === 'en' ? 'en' : 'ru' };
  }

  private load(): Settings {
    if (!existsSync(this.path)) return this.fresh();
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as {
        version?: number;
        settings?: Partial<Settings>;
      };
      if (raw.version !== SCHEMA_VERSION || !raw.settings) return this.fresh();
      return {
        uiLanguage: isUiLanguage(raw.settings.uiLanguage) ? raw.settings.uiLanguage : 'ru',
        itemNames: raw.settings.itemNames ?? DEFAULTS.itemNames,
        communityPrices: raw.settings.communityPrices ?? DEFAULTS.communityPrices,
        prisonHints: raw.settings.prisonHints === true,
        logDir: raw.settings.logDir ?? DEFAULTS.logDir,
        playerFilter: raw.settings.playerFilter ?? DEFAULTS.playerFilter,
        allSeasons: raw.settings.allSeasons === true,
        excludedItems: Array.isArray(raw.settings.excludedItems)
          ? raw.settings.excludedItems.filter((id) => Number.isInteger(id))
          : DEFAULTS.excludedItems,
        minDropFe:
          typeof raw.settings.minDropFe === 'number' && raw.settings.minDropFe >= 0
            ? raw.settings.minDropFe
            : DEFAULTS.minDropFe,
        closeToTray: raw.settings.closeToTray ?? DEFAULTS.closeToTray,
        autoStart: raw.settings.autoStart ?? DEFAULTS.autoStart,
        overlay: { ...DEFAULTS.overlay, ...raw.settings.overlay },
      };
    } catch {
      // Битый файл не должен мешать запуску.
      return this.fresh();
    }
  }

  get overlay(): Settings['overlay'] {
    return this.data.overlay;
  }

  get uiLanguage(): UiLanguage {
    return this.data.uiLanguage;
  }

  setUiLanguage(language: UiLanguage): void {
    this.data.uiLanguage = language;
    this.save();
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

  get prisonHints(): boolean {
    return this.data.prisonHints;
  }

  setPrisonHints(enabled: boolean): void {
    this.data.prisonHints = enabled;
    this.save();
  }

  get logDir(): string | null {
    return this.data.logDir;
  }

  setLogDir(dir: string | null): void {
    this.data.logDir = dir;
    this.save();
  }

  get playerFilter(): string | null {
    return this.data.playerFilter;
  }

  get allSeasons(): boolean {
    return this.data.allSeasons;
  }

  setRunScope(scope: { playerId: string | null; allSeasons: boolean }): void {
    this.data.playerFilter = scope.playerId;
    this.data.allSeasons = scope.allSeasons;
    this.save();
  }

  get excludedItems(): number[] {
    return this.data.excludedItems;
  }

  setExcluded(configBaseId: number, excluded: boolean): number[] {
    const set = new Set(this.data.excludedItems);
    if (excluded) set.add(configBaseId);
    else set.delete(configBaseId);
    this.data.excludedItems = [...set].sort((a, b) => a - b);
    this.save();
    return this.data.excludedItems;
  }

  get minDropFe(): number {
    return this.data.minDropFe;
  }

  setMinDropFe(value: number): void {
    this.data.minDropFe = Math.max(0, value);
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
