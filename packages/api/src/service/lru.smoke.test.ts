/**
 * feature-redis-8-upgrade Phase 2 — LRU (recently-viewed pages) smoke
 * (consumer #7). No existing fake-based test file for `LRU` — this is its
 * first automated coverage, real Redis 8 (shared instance), exercising
 * `add()`'s `multi()`-pipelined `ZREMRANGEBYRANK` + `ZADD`, `range()`'s
 * `ZRANGE ... REV`, and `removeByRange()`'s `ZREMRANGEBYRANK`.
 *
 * feature-redis-key-prefix §1/§2 — `LRU` now scopes every key it touches to
 * `crowi:<instance-slug>:lru:<namespace>`; `fakeCrowi` below supplies
 * `getBaseUrl`/`getEnv` so `resolveRedisKeyspace()` (called from `LRU`'s
 * constructor) can resolve one, and the raw `client.zRange`/`client.del`
 * calls that bypass the `LRU` abstraction (to assert directly against
 * Redis) use the SAME scoped key `LRU` itself computes, via
 * `resolveRedisKeyspace(fakeCrowi).key('lru', namespace)`.
 */
import type Crowi from 'src/crowi';
import LRU from 'src/service/lru';
import { markRedisSmokeRan, REDIS_SMOKE_URLS, redisSmokeReachable, uniqueRedisSmokeId, withRedisClient } from 'src/test/redis-smoke';
import { resolveRedisKeyspace } from 'src/util/redis-keyspace';

const describeMaybe = redisSmokeReachable.shared ? describe : describe.skip;

const fakeCrowi = (client: unknown): Crowi =>
  ({
    redis: client,
    getBaseUrl: () => null,
    getEnv: () => ({ REDIS_KEY_PREFIX: 'lru-smoke' }) as unknown as NodeJS.ProcessEnv,
  }) as unknown as Crowi;

describeMaybe('LRU smoke (real Redis 8)', () => {
  beforeAll(() => {
    markRedisSmokeRan('lru');
  });

  it('add() pipelines ZREMRANGEBYRANK+ZADD and keeps only the `max` most recent entries; range() returns most-recent-first', async () => {
    await withRedisClient(REDIS_SMOKE_URLS.shared, async (client) => {
      const namespace = uniqueRedisSmokeId('lru-user');
      const crowiLike = fakeCrowi(client);
      const lru = new LRU(crowiLike);
      expect(lru.max).toBe(10);
      // The instance-scoped key LRU actually reads/writes — used below to
      // assert directly against Redis, bypassing the LRU abstraction.
      const zsetKey = resolveRedisKeyspace(crowiLike).key('lru', namespace);

      // Insert 12 entries (> max=10) with strictly increasing scores.
      // `add()` reads `Date.now()` for the ZADD score — a monotonic mocked
      // clock GUARANTEES distinct scores (the previous 2ms real-sleep
      // stagger only made them probable) and drops ~24ms of sleeps; the
      // ZREMRANGEBYRANK/ZADD pipeline still runs against real Redis.
      let mockedNow = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
        mockedNow += 5;
        return mockedNow;
      });
      const pageIds: string[] = [];
      try {
        for (let i = 0; i < 12; i += 1) {
          const pageId = uniqueRedisSmokeId(`lru-page-${i}`);
          pageIds.push(pageId);
          // eslint-disable-next-line no-await-in-loop
          await lru.add(namespace, pageId);
        }
      } finally {
        nowSpy.mockRestore();
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

      // The bare (non-instance-scoped) namespace was never written to —
      // everything landed on the scoped key instead.
      expect(await client.zRange(namespace, 0, -1)).toEqual([]);

      // removeByRange — drop everything but the single most recent entry.
      await lru.removeByRange(namespace, -2);
      const afterRemove = await client.zRange(zsetKey, 0, -1);
      expect(afterRemove).toHaveLength(1);
      expect(afterRemove[0]).toBe(pageIds[pageIds.length - 1]);

      // Clean up the key this test created.
      await client.del(zsetKey);
    });
  }, 20000);
});
