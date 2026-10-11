import { useEffect, useState } from 'react';

import type { UpdateState } from '../../main/updater.js';
import { num } from '../format.js';
import { playTest } from '../overlay/sound.js';

/**
 * Язык названий предметов.
 *
 * Русские покрывают 96% справочника, но часть игроков привыкла к английским
 * — по ним ищут на бирже и в гайдах. Режим «оба» показывает и то и другое.
 */
function NameLanguageSwitch() {
  const [language, setLanguage] = useState<NameLanguage>('ru');

  useEffect(() => {
    if (!window.gorn) return;
    void window.gorn.getItemNames().then(setLanguage);
  }, []);

  const options: Array<[NameLanguage, string, string]> = [
    ['ru', 'Рус', 'Русские названия предметов'],
    ['en', 'Eng', 'Английские названия — как в гайдах и на бирже'],
    ['both', 'Оба', 'Русское и английское рядом'],
  ];

  return (
    <div className="lang-switch" role="group" aria-label="Язык названий предметов">
      {options.map(([value, label, hint]) => (
        <button
          key={value}
          className={language === value ? 'on' : ''}
          title={hint}
          onClick={() => {
            if (!window.gorn) return setLanguage(value);
            void window.gorn.setItemNames(value).then(setLanguage);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * Панель настроек — единственное место, где собраны все ручки.
 *
 * До неё настройки были размазаны: язык в шапке, цены сообщества
 * в самодиагностике, звук и плашки — на полоске откреплённого оверлея,
 * а громкость и прозрачность не имели контролов вовсе. Игрок, который
 * хочет «сделать потише», должен находить это за один клик.
 */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [prefs, setPrefs] = useState({
    popups: true,
    sound: true,
    volume: 0.5,
    soundImportantOnly: false,
    jackpotFe: 50,
    fontScale: 1,
    opacity: 0.9,
    goalFe: 0,
  });
  const [sys, setSys] = useState<GornAppSettings | null>(null);
  const [community, setCommunity] = useState(true);
  const [logDirNote, setLogDirNote] = useState<string | null>(null);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [updState, setUpdState] = useState<UpdateState | null>(null);
  const [updChecked, setUpdChecked] = useState(false);

  const refreshSys = () => {
    void window.gorn?.settings.get().then(setSys);
  };

  useEffect(() => {
    if (!window.gorn) return;
    void window.gorn.overlay.getState().then((s) => {
      setPrefs({
        popups: s.popups ?? true,
        sound: s.sound ?? true,
        volume: s.volume ?? 0.5,
        soundImportantOnly: s.soundImportantOnly ?? false,
        jackpotFe: s.jackpotFe ?? 50,
        fontScale: s.fontScale ?? 1,
        opacity: s.opacity ?? 0.9,
        goalFe: s.goalFe ?? 0,
      });
    });
    refreshSys();
    void window.gorn.getCommunityPrices().then(setCommunity);
    return window.gorn.update.onState(setUpdState);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Прозрачность идёт своим каналом, остальное — общим patchPrefs. */
  const patch = (p: Partial<typeof prefs>) => {
    setPrefs((s) => ({ ...s, ...p }));
    const { opacity, ...rest } = p;
    if (Object.keys(rest).length > 0) window.gorn?.overlay.setPrefs(rest);
    if (opacity !== undefined) window.gorn?.overlay.setOpacity(opacity);
  };

  const soundMode = !prefs.sound ? 'off' : prefs.soundImportantOnly ? 'important' : 'all';
  const setSoundMode = (mode: 'all' | 'important' | 'off') =>
    patch({ sound: mode !== 'off', soundImportantOnly: mode === 'important' });

  const chooseDir = () => {
    void window.gorn?.settings.chooseLogDir().then((r) => {
      if (r.status === 'invalid') {
        setLogDirNote('В выбранной папке нет логов игры — нужна …\\Saved\\Logs или корень установки.');
        return;
      }
      setLogDirNote(null);
      if (r.status === 'needsRestart') setNeedsRestart(true);
      if (r.status !== 'cancelled') refreshSys();
    });
  };

  const resetDir = () => {
    void window.gorn?.settings.resetLogDir().then((r) => {
      setLogDirNote(null);
      if (r.status === 'needsRestart') setNeedsRestart(true);
      refreshSys();
    });
  };

  const updateNote = !updChecked
    ? null
    : updState === null || updState.status === 'checking'
      ? 'проверяю…'
      : updState.status === 'idle'
        ? 'у вас последняя версия'
        : updState.status === 'error'
          ? `не получилось: ${updState.error ?? 'ошибка'}`
          : 'вышла новая версия — смотрите полосу сверху';

  return (
    <>
      <div className="settings-backdrop" onClick={onClose} />
      <aside className="settings-panel" role="dialog" aria-label="Настройки">
        <div className="settings-head">
          <h2>Настройки</h2>
          <button className="update-close" title="Закрыть" onClick={onClose}>
            ✕
          </button>
        </div>

        <section className="set-section">
          <h3>Звук</h3>
          <div className="lang-switch set-seg" role="group" aria-label="Режим звука">
            <button className={soundMode === 'all' ? 'on' : ''} onClick={() => setSoundMode('all')}>
              Все находки
            </button>
            <button
              className={soundMode === 'important' ? 'on' : ''}
              title="Удар молота на золотую находку и итог карты; обычные подборы молчат"
              onClick={() => setSoundMode('important')}
            >
              Только важное
            </button>
            <button className={soundMode === 'off' ? 'on' : ''} onClick={() => setSoundMode('off')}>
              Без звука
            </button>
          </div>
          <label className={`set-row ${prefs.sound ? '' : 'set-disabled'}`}>
            <span>Громкость</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(prefs.volume * 100)}
              disabled={!prefs.sound}
              onChange={(e) => patch({ volume: Number(e.target.value) / 100 })}
              onPointerUp={() => playTest(prefs.volume)}
            />
          </label>
        </section>

        <section className="set-section">
          <h3>Плашки поверх игры</h3>
          <label className="set-row">
            <span>Всплывающий доход у центра экрана</span>
            <input
              type="checkbox"
              checked={prefs.popups}
              onChange={(e) => patch({ popups: e.target.checked })}
            />
          </label>
          <label className="set-row">
            <span>Золотая плашка и удар молота</span>
            <select
              value={String(prefs.jackpotFe)}
              onChange={(e) => patch({ jackpotFe: Number(e.target.value) })}
            >
              <option value="0">авто — дорогое для сезона</option>
              <option value="10">от 10 ФЕ — почти на всё</option>
              <option value="50">от 50 ФЕ</option>
              <option value="200">от 200 ФЕ — только дорогое</option>
              {![0, 10, 50, 200].includes(prefs.jackpotFe) && (
                <option value={String(prefs.jackpotFe)}>от {prefs.jackpotFe} ФЕ</option>
              )}
            </select>
          </label>
        </section>

        <section className="set-section">
          <h3>Оверлей</h3>
          <label className="set-row">
            <span>Прозрачность</span>
            <input
              type="range"
              min={25}
              max={100}
              value={Math.round(prefs.opacity * 100)}
              onChange={(e) => patch({ opacity: Number(e.target.value) / 100 })}
            />
          </label>
          <label className="set-row">
            <span>Масштаб</span>
            <input
              type="range"
              min={80}
              max={160}
              step={10}
              value={Math.round(prefs.fontScale * 100)}
              onChange={(e) => patch({ fontScale: Number(e.target.value) / 100 })}
            />
          </label>
          <label className="set-row">
            <span title="Оверлей покажет полосу прогресса и оценку, сколько ещё фармить при текущем темпе. 0 — выключено.">
              Цель сессии, ФЕ
            </span>
            <input
              type="number"
              min={0}
              step={100}
              className="set-num"
              value={prefs.goalFe}
              onChange={(e) => patch({ goalFe: Math.max(0, Number(e.target.value) || 0) })}
            />
          </label>
          <p className="muted small">
            Ctrl+Alt+G — показать · Ctrl+Alt+L — закрепить · Ctrl+Alt+M — режим
          </p>
          {sys && sys.busyHotkeys.length > 0 && (
            <p className="note warn">
              {sys.busyHotkeys.join(', ')} — занято другой программой, сочетание
              не сработает. Управляйте оверлеем кнопками из этого окна.
            </p>
          )}
          <p className="muted small">
            Не видно оверлея в игре? Переключите её в безрамочный режим —
            эксклюзивный полный экран перекрыть нельзя.
          </p>
        </section>

        <section className="set-section">
          <h3>Названия предметов</h3>
          <div className="set-row">
            <span>Язык</span>
            <NameLanguageSwitch />
          </div>
          <label className="set-row">
            <span title="Первичные цены из базы сообщества TITrack (titrack.ninja). Свои пробивки всегда в приоритете.">
              Цены сообщества
            </span>
            <input
              type="checkbox"
              checked={community}
              onChange={(e) => {
                setCommunity(e.target.checked);
                void window.gorn?.setCommunityPrices(e.target.checked);
              }}
            />
          </label>
        </section>

        <section className="set-section">
          <h3>Данные</h3>
          <div className="set-dir">
            <span className="muted small">Папка логов:</span>
            <span className="set-path" title={sys?.resolvedLogDir ?? undefined}>
              {sys?.logDir ?? sys?.resolvedLogDir ?? 'не найдена'}
              {!sys?.logDir && sys?.resolvedLogDir && (
                <span className="muted"> · найдена автоматически</span>
              )}
            </span>
          </div>
          <div className="set-actions">
            <button className="set-btn" onClick={chooseDir}>
              Указать папку…
            </button>
            {sys?.logDir && (
              <button className="set-btn" onClick={resetDir}>
                Вернуть автопоиск
              </button>
            )}
          </div>
          {logDirNote && <p className="note warn">{logDirNote}</p>}
          {needsRestart && (
            <p className="note warn">
              Папка сменится после перезапуска.{' '}
              <button className="set-btn" onClick={() => window.gorn?.settings.relaunch()}>
                Перезапустить сейчас
              </button>
            </p>
          )}
        </section>

        <section className="set-section">
          <h3>Система</h3>
          <label className="set-row">
            <span>Запускать вместе с Windows</span>
            <input
              type="checkbox"
              checked={sys?.autoStart ?? false}
              onChange={(e) => {
                void window.gorn?.settings.setAutoStart(e.target.checked).then(refreshSys);
              }}
            />
          </label>
          <label className="set-row">
            <span title="Закрытие окна сворачивает трекер в трей — оверлей и подсчёт продолжают работать">
              Закрывать в трей
            </span>
            <input
              type="checkbox"
              checked={sys?.closeToTray ?? false}
              onChange={(e) => {
                void window.gorn?.settings.setCloseToTray(e.target.checked).then(refreshSys);
              }}
            />
          </label>
          <div className="set-row">
            <span className="muted">Горн {sys?.version ? `v${sys.version}` : ''}</span>
            <span className="set-update">
              {updateNote && <span className="muted small">{updateNote}</span>}
              <button
                className="set-btn"
                onClick={() => {
                  setUpdChecked(true);
                  void window.gorn?.update.check();
                }}
              >
                Проверить обновления
              </button>
            </span>
          </div>
        </section>
      </aside>
    </>
  );
}
