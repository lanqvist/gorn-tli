import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { heroName } from '../src/core/heroes.js';
import { languageForLocale, setUiLanguage, tr, uiLocale } from '../src/core/i18n.js';
import { SettingsStore } from '../src/main/settings.js';

afterEach(() => setUiLanguage('ru'));

describe('язык интерфейса', () => {
  it('tr и локаль следуют текущему языку', () => {
    expect(tr('Забеги', 'Runs')).toBe('Забеги');
    expect(uiLocale()).toBe('ru-RU');
    setUiLanguage('en');
    expect(tr('Забеги', 'Runs')).toBe('Runs');
    expect(uiLocale()).toBe('en-US');
  });

  it('русский по умолчанию только для русской системы', () => {
    expect(languageForLocale('ru')).toBe('ru');
    expect(languageForLocale('ru-RU')).toBe('ru');
    expect(languageForLocale('en-US')).toBe('en');
    expect(languageForLocale('de')).toBe('en');
    expect(languageForLocale('rue')).toBe('en');
    expect(languageForLocale(null)).toBe('en');
  });

  it('герои: известный по имени, неизвестный — «Герой N»', () => {
    expect(heroName(1700)).toBe('Селена');
    expect(heroName(42)).toBe('Герой 42');
    setUiLanguage('en');
    expect(heroName(1700)).toBe('Selena');
    expect(heroName(42)).toBe('Hero 42');
    expect(heroName(null)).toBeNull();
  });
});

describe('язык в настройках', () => {
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'gorn-'));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('новая установка берёт язык системы, вместе с названиями предметов', () => {
    withDir((dir) => {
      const en = new SettingsStore(dir, 'en-US');
      expect(en.uiLanguage).toBe('en');
      expect(en.itemNames).toBe('en');
    });
    withDir((dir) => {
      const ru = new SettingsStore(dir, 'ru-RU');
      expect(ru.uiLanguage).toBe('ru');
      expect(ru.itemNames).toBe('ru');
    });
  });

  it('существующие настройки без поля языка остаются русскими', () => {
    withDir((dir) => {
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({ version: 1, settings: { itemNames: 'both' } }),
      );
      const store = new SettingsStore(dir, 'en-US');
      expect(store.uiLanguage).toBe('ru');
      expect(store.itemNames).toBe('both');
    });
  });

  it('выбор языка сохраняется', () => {
    withDir((dir) => {
      new SettingsStore(dir, 'ru-RU').setUiLanguage('en');
      expect(new SettingsStore(dir, 'ru-RU').uiLanguage).toBe('en');
    });
  });
});
