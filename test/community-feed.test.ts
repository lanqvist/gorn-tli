import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommunityPriceFeed } from '../src/main/communityPrices.js';

interface Pending {
  url: string;
  resolve: (rows: unknown[]) => void;
  reject: (err: Error) => void;
}

const row = (id: number, fe: number, updatedAt: string) => ({
  config_base_id: id,
  price_fe_median: fe,
  price_fe_p10: fe,
  submission_count: 3,
  unique_devices: 2,
  updated_at: updatedAt,
});

describe('цены сообщества: смена сезона посреди запроса', () => {
  let dir: string;
  let pending: Pending[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gorn-feed-'));
    pending = [];
    vi.stubGlobal(
      'fetch',
      (url: string) =>
        new Promise((resolve, reject) => {
          pending.push({
            url,
            resolve: (rows) => resolve({ ok: true, status: 200, json: async () => rows }),
            reject,
          });
        }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('ответ прошлого сезона не попадает в новый и не двигает его курсор', async () => {
    const feed = new CommunityPriceFeed(dir);
    feed.start(13);
    expect(pending).toHaveLength(1);
    const old = pending[0]!;
    expect(old.url).toContain('season_id=eq.13');

    feed.start(14);
    expect(pending).toHaveLength(2);
    const fresh = pending[1]!;
    expect(fresh.url).toContain('season_id=eq.14');
    expect(fresh.url).not.toContain('updated_at=gt.');

    // Старый запрос отвечает поздно — и с поздним updated_at.
    old.resolve([row(100, 5, '2026-10-19T00:00:00Z')]);
    await flush();
    expect(feed.priceOf(100)).toBeNull();
    expect(feed.size).toBe(0);

    fresh.resolve([row(200, 7, '2026-10-01T00:00:00Z')]);
    await flush();
    expect(feed.priceOf(200)?.fe).toBe(7);
    expect(feed.priceOf(100)).toBeNull();

    // Курсор нового сезона — по его строкам, а не по ответу прошлого.
    const cache = JSON.parse(readFileSync(join(dir, 'community-prices.json'), 'utf8'));
    expect(cache.seasonId).toBe(14);
    expect(cache.cursor).toBe('2026-10-01T00:00:00Z');

    void feed.refresh();
    expect(pending[2]!.url).toContain('season_id=eq.14');
    expect(pending[2]!.url).toContain(encodeURIComponent('2026-10-01T00:00:00Z'));
    pending[2]!.resolve([]);
    feed.stop();
  });

  it('ошибка запроса прошлого сезона не помечает новый устаревшим', async () => {
    const feed = new CommunityPriceFeed(dir);
    feed.start(13);
    feed.start(14);
    pending[0]!.reject(new Error('сеть'));
    await flush();
    expect(feed.stale).toBe(false);
    pending[1]!.resolve([]);
    await flush();
    expect(feed.stale).toBe(false);
    expect(feed.fetchedAtMs).not.toBeNull();
    feed.stop();
  });
});
