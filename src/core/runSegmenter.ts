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
 * Все начисления ФЕ легли внутрь 5348, границы сошлись.
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

  /**
   * Окно, в котором возврат в ту же карту считается продолжением забега.
   * Сходить в город продать добычу — минуты; всё, что дольше, вероятнее
   * новая карта того же типа, а не тот же самый портал.
   */
  private static readonly RESUME_TTL_MS = 480_000;

  enterLevel(ev: EnterLevelEvent): void {
    this.closeCurrent(ev.ts);
    const isHub = isHubAsset(this.pendingAsset);

    // Портал в город и обратно — это ОДИН забег, а не два. Без склейки
    // вторая половина карты становилась отдельным забегом без вложений:
    // счётчик забегов раздувался, медианы резались пополам, а стратегия
    // с маяком теряла половину своего дохода в пользу «Без вложений».
    if (!isHub) {
      const resumed = this.tryResume(ev);
      if (resumed) return;
    }

    this.current = {
      areaId: ev.areaId,
      asset: this.pendingAsset,
      levelType: this.pendingLevelType,
      startedAt: ev.ts,
      endedAt: null,
      durationMs: null,
      isHub,
      drops: [],
      // Вложения, сделанные в городе перед входом, принадлежат этой карте.
      costs: isHub ? [] : this.takePendingCosts(ev.ts),
    };
    this.pendingAsset = null;
    this.pendingLevelType = null;
  }

  /**
   * areaId — это тип карты, а не экземпляр, поэтому совпадения зоны мало.
   * Продолжением считается только если между выходом и возвратом были
   * одни хабы, не открывалась новая карта (нет ожидающих вложений)
   * и прошло меньше RESUME_TTL_MS.
   */
  private tryResume(ev: EnterLevelEvent): boolean {
    if (this.pendingCosts.length > 0) return false;

    for (let i = this.runs.length - 1; i >= 0; i--) {
      const run = this.runs[i]!;
      if (run.isHub) continue;
      if (run.areaId !== ev.areaId || run.asset !== this.pendingAsset) return false;
      if (run.endedAt === null || ev.ts - run.endedAt > RunSegmenter.RESUME_TTL_MS) return false;

      this.runs.splice(i, 1);
      run.endedAt = null;
      run.durationMs = null;
      this.current = run;
      this.pendingAsset = null;
      this.pendingLevelType = null;
      return true;
    }
    return false;
  }

  private takePendingCosts(ts: number): ItemDelta[] {
    const fresh = this.pendingCosts.filter(
      (c) => ts - c.ts <= RunSegmenter.PENDING_TTL_MS,
    );
    this.pendingCosts = [];
    return fresh;
  }

  /**
   * Приросты приписываются текущей зоне, расходы — той карте,
   * ради которой они сделаны.
   *
   * Компас, маяк или фитиль списываются, пока игрок ещё в городе:
   *
   *   12:05:06  Spv3Open → маяк 400033: 23 → 22
   *   12:05:06  ВХОД В ЗОНУ 5348
   *
   * Приписывать такой расход текущему забегу нельзя — это городской
   * забег, и он выброшен из статистики. Поэтому вложения придерживаются
   * и переносятся в следующую боевую карту.
   */
  addDelta(delta: ItemDelta): void {
    if (delta.kind === 'mapCost' && delta.qty < 0) {
      const cost = { ...delta, qty: -delta.qty };
      if (this.current && !this.current.isHub) this.current.costs.push(cost);
      else this.pendingCosts.push(cost);
      return;
    }

    if (!this.current) return;
    if (delta.kind === 'loot' && delta.qty > 0) this.current.drops.push(delta);
  }

  /**
   * Вложения ждут своей карты, но не бесконечно: если игрок открыл карту
   * и ушёл заниматься другими делами, расход не должен приклеиться
   * к случайному забегу через полчаса.
   */
  private pendingCosts: ItemDelta[] = [];
  private static readonly PENDING_TTL_MS = 300_000;

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
