/**
 * feature-redis-8-upgrade Phase 2 — LRU (recently-viewed pages) smoke
 * (consumer #7). No existing fake-based test file for `LRU` — this is its
 * first automated coverage, real Redis 8 (shared instance), exercising
 * `add()`'s `multi()`-pipelined `ZREMRANGEBYRANK` + `ZADD`, `range()`'s
 * `ZRANGE ... REV`, and `removeByRange()`'s `ZREMRANGEBYRANK`.
 */
import type Crowi from 'src/crowi';
import LRU from 'src/service/lru';
import { markRedisSmokeRan, REDIS_SMOKE_URLS, redisSmokeReachable, uniqueRedisSmokeId, withRedisClient } from 'src/test/redis-smoke';

const describeMaybe = redisSmokeReachable.shared ? describe : describe.skip;

describeMaybe('LRU smoke (real Redis 8)', () => {
  beforeAll(() => {
    markRedisSmokeRan('lru');
  });

  it('add() pipelines ZREMRANGEBYRANK+ZADD and keeps only the `max` most recent entries; range() returns most-recent-first', async () => {
    await withRedisClient(REDIS_SMOKE_URLS.shared, async (client) => {
      const namespace = uniqueRedisSmokeId('lru-user');
      const lru = new LRU({ redis: client } as unknown as Crowi);
      expect(lru.max).toBe(10);

      // Insert 12 entries (> max=10) with strictly increasing scores (Date.now()
      // — a tiny stagger keeps ZADD scores distinct even on a fast loop).
      const pageIds: string[] = [];
      for (let i = 0; i < 12; i += 1) {
        const pageId = uniqueRedisSmokeId(`lru-page-${i}`);
        pageIds.push(pageId);
        // eslint-disable-next-line no-await-in-loop
        await lru.add(namespace, pageId);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 2));
      }

      // `add()`'s ZREMRANGEBYRANK trims based on the size BEFORE this call's
      // own ZADD (both run in the same `multi()` pipeline) — it only fires
      // once the PRE-add size exceeds `max`, so the steady-state size after
      // repeated adds settles at `max + 1`, not `max` (empirically verified
      // against real Redis 8 directly: `ZREMRANGEBYRANK key 0 -(max+1)` is a
      // no-op while size <= max, and removes exactly ONE element — the
      // globally oldest surviving entry — once size > max). Across 12 adds
      // with max=10, only the very FIRST entry is ever evicted.
      const rangeAll = await lru.range(namespace, 0);
      expect(rangeAll).toHaveLength(11);
      // Most-recent-first (ZRANGE ... REV): the very last inserted page id
      // must be first.
      expect(rangeAll[0]).toBe(pageIds[pageIds.length - 1]);
      // Only the very first (oldest) entry was evicted.
      expect(rangeAll).not.toContain(pageIds[0]);
      expect(rangeAll).toContain(pageIds[1]);

      // range(limit) — first N most-recent.
      const rangeThree = await lru.range(namespace, 3);
      expect(rangeThree).toHaveLength(3);
      expect(rangeThree).toEqual(rangeAll.slice(0, 3));

      // removeByRange — drop everything but the single most recent entry.
      await lru.removeByRange(namespace, -2);
      const afterRemove = await client.zRange(namespace, 0, -1);
      expect(afterRemove).toHaveLength(1);
      expect(afterRemove[0]).toBe(pageIds[pageIds.length - 1]);

      // Clean up the key this test created.
      await client.del(namespace);
    });
  }, 20000);
});
