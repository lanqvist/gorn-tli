/**
 * Поток подсказок в тюрьме: кадр игры → распознавание → ход → метки.
 *
 * Распознавание и расчёт хода — код «Tartarus Simulator» (vendor/tartarus):
 * сканер доски, движок, решатель и перенос анализатора без страницы
 * (advisor.js). Здесь только связка: кадр приходит из main-процесса
 * (BGRA, как отдаёт desktopCapturer), уходят тексты и метки в пикселях
 * кадра. Расчёт тяжёлый (секунды), поэтому он в отдельном потоке и не
 * тормозит ни интерфейс, ни разбор лога.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

import type { PrisonFrameKind } from '../../core/prisonTriggers.js';
import type { PrisonHint, PrisonShotMessage, PrisonWorkerReply } from './protocol.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- код симулятора без типов */
type Any = any;

const vendorDir: string = (workerData as { vendorDir: string }).vendorDir;
const req = createRequire(join(vendorDir, 'advisor.js'));
const Scan: Any = req('./scan.js');
const SCAN: Any = req('./scan-data.js');
const PICK: Any = req('./pick-data.js');
req('./scan-data-ru.js');
const { createAdvisor, hint } = req('./advisor.js') as { createAdvisor: () => Any; hint: (rec: Any, ctx: Any) => { text: string; marks: Any[] } | null };
const REF: Any = Scan.withPanelIcons(SCAN, PICK);
const SIMS: string[] = [...new Set<string>(REF.tools.map((x: Any) => (SCAN.toolNames[x.id] || {}).sim).filter(Boolean))];

const advisor = createAdvisor();

/** Сканер настроен на картинки до ~2600 px: 4K уменьшаем вдвое. */
const MAX_WIDTH = 2600;

interface Image {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** BGRA → RGBA, с уменьшением в целое число раз усреднением блоков. */
function toImage(width: number, height: number, bgra: Uint8Array): { img: Image; scale: number } {
  const f = Math.max(1, Math.ceil(width / MAX_WIDTH));
  const w = Math.floor(width / f);
  const h = Math.floor(height / f);
  const out = new Uint8ClampedArray(w * h * 4);
  const area = f * f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < f; dy++) {
        let i = ((y * f + dy) * width + x * f) * 4;
        for (let dx = 0; dx < f; dx++, i += 4) {
          b += bgra[i]!;
          g += bgra[i + 1]!;
          r += bgra[i + 2]!;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / area;
      out[o + 1] = g / area;
      out[o + 2] = b / area;
      out[o + 3] = 255;
    }
  }
  return { img: { width: w, height: h, data: out }, scale: f };
}

function scanBoard(img: Image): Any {
  const r = Scan.scan(img, REF);
  if (r.tools && r.tools.tools) {
    for (const t of r.tools.tools) {
      Object.assign(t, SCAN.toolNames[t.id] || {});
      for (const a of t.alts || []) a.sim = (SCAN.toolNames[a.id] || {}).sim;
    }
    r.tools.sims = SIMS;
  }
  return r;
}

/** Метки из пикселей уменьшенной картинки — в пиксели кадра. */
function scaleHint(h: { text: string; marks: Any[] }, scale: number): Pick<PrisonHint, 'text' | 'marks'> {
  const p = (v: number[]) => v.map((x) => x * scale);
  return {
    text: h.text,
    marks: h.marks.map((m: Any) =>
      m.kind === 'arrow' ? { kind: 'arrow', from: p(m.from), to: p(m.to) } : m.kind === 'ring' ? { kind: 'ring', at: p(m.at), r: m.r * scale } : { kind: 'box', box: p(m.box) },
    ),
  };
}

function reply(msg: PrisonWorkerReply): void {
  parentPort?.postMessage(msg);
}

function handle(msg: PrisonShotMessage): void {
  const { img, scale } = toImage(msg.width, msg.height, new Uint8Array(msg.buffer));
  const frame = { w: msg.width, h: msg.height };
  const ctx: Any = { img: { w: img.width, h: img.height } };
  let kind: PrisonFrameKind | 'manual' = msg.kind;

  if (kind === 'treasure') {
    advisor.treasure(msg.after);
    reply({ type: 'hint', id: msg.id, phase: 'final', frame, text: 'Сокровищница: нажми «Посмотреть состояние тюрьмы», чтобы получить совет по подарку', marks: [], live: false });
    return;
  }
  if (kind === 'objective') {
    const o = Scan.readObjectiveTitle(img);
    advisor.objective(o);
    reply({ type: 'clear', id: msg.id });
    return;
  }

  let board: Any = null;
  if (kind === 'board' || kind === 'manual') {
    board = scanBoard(img);
    if (board.ok) {
      advisor.board(board);
      if (msg.treasureView) advisor.treasure('view');
      ctx.scan = board;
      kind = 'board';
    } else if (kind === 'board') {
      reply({ type: 'clear', id: msg.id });
      return;
    }
  }
  if (kind === 'instruments' || kind === 'manual') {
    const p = Scan.scanPick(img, SCAN, PICK);
    if (!p.ok || p.cards.some((c: Any) => c.conf < 0.3)) {
      reply({ type: 'clear', id: msg.id });
      return;
    }
    advisor.pick(p, msg.fresh);
    ctx.pick = p;
  }

  let sent = '';
  const send = (rec: Any, st: Any, phase: 'instant' | 'final') => {
    ctx.st = st;
    const h = hint(rec, ctx);
    if (!h) return;
    const key = JSON.stringify(rec.action);
    if (phase === 'final' && key === sent) {
      reply({ type: 'settled', id: msg.id, live: !!rec.live });
      return;
    }
    sent = key;
    reply({ type: 'hint', id: msg.id, phase, frame, live: !!rec.live, ...scaleHint(h, scale) });
  };
  const res = advisor.advise({ budgetMs: msg.budgetMs, onInstant: (rec: Any, st: Any) => send(rec, st, 'instant') });
  if (!res || !res.rec) {
    reply({ type: 'clear', id: msg.id });
    return;
  }
  send(res.rec, res.st, 'final');
}

parentPort?.on('message', (msg: PrisonShotMessage | { type: 'reset' }) => {
  if (msg.type === 'reset') {
    advisor.reset();
    return;
  }
  try {
    handle(msg);
  } catch (err) {
    reply({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
});
