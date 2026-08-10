import { isHubAsset } from './patterns.js';
import type { EnterLevelEvent, ItemDelta, Run } from './types.js';

/**
 * Режет поток событий на забеги.
 *
 * Забег — отрезок между входом в зону и входом в следующую.
 * Зоны-хабы (город, укрытие) помечаются isHub и не участвуют в расчёте
 * эффективности, но сохраняются: по ним считается время простоя.
 *
 * Проверено на реальном логе, чередование выглядит так:
 *   10:02:40 зона 110  (хаб) → 10:03:16 зона 5351 → 10:04:03 зона 110
 *   → 10:04:10 зона 5348 → 10:05:34 зона 110
 * Все начисления ФЭ легли внутрь 5348, границы сошлись.
 */
export class RunSegmenter {
  private runs: Run[] = [];
  private current: Run | null = null;
  /** Путь ассета приходит отдельной строкой ДО входа в зону. */
  private pendingAsset: string | null = null;
  private pendingLevelType: number | null = null;

  noteAsset(asset: string): void {
    this.pendingAsset = asset;
  }

  noteLevelType(levelType: number): void {
    this.pendingLevelType = levelType;
  }

  enterLevel(ev: EnterLevelEvent): void {
    this.closeCurrent(ev.ts);
    this.current = {
      areaId: ev.areaId,
      asset: this.pendingAsset,
      levelType: this.pendingLevelType,
      startedAt: ev.ts,
      endedAt: null,
      durationMs: null,
      isHub: isHubAsset(this.pendingAsset),
      drops: [],
      costs: [],
    };
    this.pendingAsset = null;
    this.pendingLevelType = null;
  }

  /** Приросты и расходы приписываются текущей зоне. */
  addDelta(delta: ItemDelta): void {
    if (!this.current) return;
    if (delta.kind === 'loot' && delta.qty > 0) {
      this.current.drops.push(delta);
    } else if (delta.kind === 'mapCost' && delta.qty < 0) {
      this.current.costs.push({ ...delta, qty: -delta.qty });
    }
  }

  private closeCurrent(ts: number): void {
    if (!this.current) return;
    this.current.endedAt = ts;
    this.current.durationMs = ts - this.current.startedAt;
    this.runs.push(this.current);
    this.current = null;
  }

  /** Завершает открытый забег. Вызывать в конце файла. */
  finish(lastTs: number): Run[] {
    this.closeCurrent(lastTs);
    return this.runs;
  }

  get all(): Run[] {
    return this.current ? [...this.runs, this.current] : this.runs;
  }
}
