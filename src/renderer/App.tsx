import { useEffect, useState } from 'react';

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
  const [now, setNow] = useState(Date.now());

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

  // Таймер текущего забега должен идти, даже когда в лог ничего не падает.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!snapshot) {
    return (
      <div className="boot">
        <div className="boot-spark" />
        <p>Разбираю логи…</p>
        {/* На большой пачке логов без живой цифры заглушка неотличима
            от зависания. */}
        {scanProgress && (
          <p className="muted small">
            Файл {scanProgress.index + 1} из {scanProgress.total}
            {scanProgress.runsFound > 0 && (
              <> · найдено {pluralize(scanProgress.runsFound, RUN)}</>
            )}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <UpdateBanner />
      <Header snapshot={snapshot} now={now} onOpenSettings={() => setSettingsOpen(true)} />
      {settingsOpen && (
        <SettingsPanel minDropFe={snapshot.minDropFe} onClose={() => setSettingsOpen(false)} />
      )}
      <Hero snapshot={snapshot} />
      <SessionRecords snapshot={snapshot} />
      <div className="columns">
        <CurrentRun snapshot={snapshot} now={now} />
        <Sidebar snapshot={snapshot} />
      </div>
      <Strategies snapshot={snapshot} />
      <Maps snapshot={snapshot} />
      <RecentRuns snapshot={snapshot} />
      <History snapshot={snapshot} />
      <MissingPrices snapshot={snapshot} />
      <Prices snapshot={snapshot} />
      <Diagnostics snapshot={snapshot} now={now} />
    </div>
  );
}
