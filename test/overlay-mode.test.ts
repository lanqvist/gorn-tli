import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SettingsStore } from '../src/main/settings.js';

function withSettings(overlay: Record<string, unknown>, check: (store: SettingsStore) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'gorn-mode-'));
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, settings: { overlay } }));
    check(new SettingsStore(dir, 'ru-RU'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('режим оверлея из настроек', () => {
  it('лента запоминается', () => {
    withSettings({ mode: 'strip' }, (s) => expect(s.overlay.mode).toBe('strip'));
  });

  it('незнакомый режим — компактный, а не окно без ширины', () => {
    withSettings({ mode: 'hologram', locked: false }, (s) => {
      expect(s.overlay.mode).toBe('compact');
      expect(s.overlay.locked).toBe(false);
    });
  });
});
