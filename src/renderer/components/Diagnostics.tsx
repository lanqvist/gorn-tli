import { useEffect, useState } from 'react';

import type { Snapshot } from '../../main/engine.js';
import { ago, cacheDate, copyText, num } from '../format.js';

/**
 * Самодиагностика. Формат лога меняется каждый сезон, и трекер должен
 * говорить, что ослеп, а не показывать нули как ни в чём не бывало.
 */
export function Diagnostics({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const {
    unknownProtos,
    pricedItems,
    communityPrices,
    communityEnabled,
    communityFetchedAt,
    communityStale,
  } = snapshot.diagnostics;

  // Свежесть цен: счётчик «2 154 цены» ничего не говорит о том, не лежат ли
  // они в кэше третий день без сети.
  const freshness = !communityEnabled
    ? null
    : communityStale
      ? ` · нет сети — кэш${communityFetchedAt ? ` от ${cacheDate(communityFetchedAt)}` : ''}`
      : communityFetchedAt
        ? ` · обновлены ${ago(Math.max(0, now - communityFetchedAt))}`
        : null;

  return (
    <section className="card diag">
      <h2>Самодиагностика</h2>
      {/* Маркер относится к своей строке, а не к общему состоянию:
          иначе справочная строка выглядит как проблема. */}
      <div className="diag-row">
        <span className="ok">✓</span>
        <span>Своих пробивок: {num(pricedItems)}</span>
      </div>
      {/* Только факты: ручка включения живёт в настройках. */}
      <div className="diag-row">
        <span className={communityEnabled ? 'ok' : 'muted'}>
          {communityEnabled ? '✓' : '·'}
        </span>
        <span>
          {communityEnabled
            ? `Цен из базы сообщества: ${num(communityPrices)}`
            : 'Цены сообщества выключены — только свои пробивки.'}
          {freshness && <span className="muted">{freshness}</span>}
        </span>
      </div>
      {unknownProtos.length > 0 && (
        <div className="diag-row">
          <span className="warn">!</span>
          <span>
            Незнакомые операции: {unknownProtos.map(([p, n]) => `${p} ×${n}`).join(', ')}.
            Возможно, игра обновилась —{' '}
            <a
              href="https://github.com/lanqvist/gorn-tli/issues"
              target="_blank"
              rel="noreferrer"
            >
              сообщите
            </a>
            , чтобы я их учёл.
          </span>
          <CopyProtosReport snapshot={snapshot} />
        </div>
      )}
    </section>
  );
}

/**
 * Готовый текст для баг-репорта: игроку достаточно вставить его в issue,
 * не переписывая имена протоколов руками.
 */
function CopyProtosReport({ snapshot }: { snapshot: Snapshot }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1100);
    return () => clearTimeout(t);
  }, [copied]);

  const report = [
    `Незнакомые операции в логе (сезон ${snapshot.seasonId ?? '?'}):`,
    ...snapshot.diagnostics.unknownProtos.map(([p, n]) => `- ${p} ×${n}`),
  ].join('\n');

  return (
    <button
      className="diag-toggle"
      title="Скопировать список для баг-репорта"
      onClick={() => void copyText(report).then(() => setCopied(true))}
    >
      {copied ? 'скопировано ✓' : 'скопировать отчёт'}
    </button>
  );
}
