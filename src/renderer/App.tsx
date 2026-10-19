import { useEffect, useState } from 'react';

import { tr } from '../core/i18n.js';
import { RUN, pluralize } from '../core/plural.js';
import type { RetroScanProgress } from '../core/retroScan.js';
import type { Snapshot } from '../main/engine.js';
import { CurrentRun } from './components/CurrentRun.js';
import { Diagnostics } from './components/Diagnostics.js';
import { Header } from './components/Header.js';
import { Hero } from './components/Hero.js';
import { History } from './components/History.js';
import { Maps } from './components/Maps.js';
import { MissingPrices } from './components/MissingPrices.js';
import { Prices } from './components/Prices.js';
import { RecentRuns } from './components/RecentRuns.js';
import { SessionRecords } from './components/SessionRecords.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { Sidebar } from './components/Sidebar.js';
import { Strategies } from './components/Strategies.js';
import { UpdateBanner } from './components/UpdateBanner.js';

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [scanProgress, setScanProgress] = useState<RetroScanProgress | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    // В браузере main-процесса нет — показываем демо-данные, чтобы вёрстку
    // можно было проверять без запуска Electron.
    if (!window.gorn) {
      if (import.meta.env.DEV) {
        void import('./demo.js').then((m) => setSnapshot(m.demoSnapshot));
      }
      return;
    }
    void window.gorn.getSnapshot().then((s) => s && setSnapshot(s));
    const offSnapshot = window.gorn.onSnapshot(setSnapshot);
    const offScan = window.gorn.onScanProgress(setScanProgress);
    return () => {
      offSnapshot();
      offScan();
    };
  }, []);

  // Секундного таймера здесь нет: время спрашивают сами часы забега и
  // возраст лога (useNow), иначе каждую секунду перерисовывалось бы всё окно.

  if (!snapshot) {
    return (
      <div className="boot">
        <div className="boot-spark" />
        <p>{tr('Разбираю логи…', 'Reading logs…')}</p>
        {/* На большой пачке логов без живой цифры заглушка неотличима
            от зависания. */}
        {scanProgress && (
          <p className="muted small">
            {tr(
              `Файл ${scanProgress.index + 1} из ${scanProgress.total}`,
              `File ${scanProgress.index + 1} of ${scanProgress.total}`,
            )}
            {scanProgress.runsFound > 0 && (
              <>
                {' '}
                · {tr('найдено', 'found')} {pluralize(scanProgress.runsFound, RUN)}
              </>
            )}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <UpdateBanner />
      <Header snapshot={snapshot} onOpenSettings={() => setSettingsOpen(true)} />
      {settingsOpen && (
        <SettingsPanel minDropFe={snapshot.minDropFe} onClose={() => setSettingsOpen(false)} />
      )}
      <Hero snapshot={snapshot} />
      <SessionRecords snapshot={snapshot} />
      <div className="columns">
        <CurrentRun snapshot={snapshot} />
        <Sidebar snapshot={snapshot} />
      </div>
      <Strategies snapshot={snapshot} />
      <Maps snapshot={snapshot} />
      <RecentRuns snapshot={snapshot} />
      <History snapshot={snapshot} />
      <MissingPrices snapshot={snapshot} />
      <Prices snapshot={snapshot} />
      <Diagnostics snapshot={snapshot} />
    </div>
  );
}
