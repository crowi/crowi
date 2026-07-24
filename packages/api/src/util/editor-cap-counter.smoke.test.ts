/**
 * feature-redis-8-upgrade Phase 2 — editor cap counter smoke (consumer #2).
 *
 * Real `redis` v4 client (Redis 8, shared instance) driving
 * `createEditorCapCounter` through the exact same acquire → cap → release →
 * TTL-re-arm sequence the fake-based `editor-cap-counter.test.ts` already
 * covers, so a real-Redis regression in `SADD`/`SCARD`/`SREM`/`EXPIRE`
 * semantics would show up here even though the logic itself is unchanged.
 */

import type Crowi from 'src/crowi';
import { markRedisSmokeRan, REDIS_SMOKE_URLS, redisSmokeReachable, uniqueRedisSmokeId, withRedisClient } from 'src/test/redis-smoke';
import { createEditorCapCounter, type MinimalRedisClient } from 'src/util/editor-cap-counter';
import { resolveRedisKeyspace } from 'src/util/redis-keyspace';

const describeMaybe = redisSmokeReachable.shared ? describe : describe.skip;

/** `createEditorCapCounter`'s Redis-backed path now REQUIRES a keyspace (feature-redis-key-prefix §1/§2 review round 3). */
const SMOKE_KEYSPACE = resolveRedisKeyspace({
  getBaseUrl: () => null,
  getEnv: () => ({ REDIS_KEY_PREFIX: 'editor-cap-smoke' }) as unknown as NodeJS.ProcessEnv,
} as unknown as Crowi);

describeMaybe('editor cap counter smoke (real Redis 8)', () => {
  beforeAll(() => {
    markRedisSmokeRan('editor-cap');
  });

  it('acquire fills the set up to the cap, rejects the next acquirer, release frees a slot, and TTL is re-armed on every SADD', async () => {
    await withRedisClient(REDIS_SMOKE_URLS.shared, async (client) => {
      const counter = await createEditorCapCounter({
        redisClient: client as unknown as MinimalRedisClient,
        maxEditorsPerPage: 2,
        keyspace: SMOKE_KEYSPACE,
      });
      const pageId = uniqueRedisSmokeId('editor-cap-page');
      const editorCapKey = SMOKE_KEYSPACE.key('collab', 'editors', pageId);

      const r1 = await counter.tryAcquire(pageId, 'user-1', 'socket-1');
      expect(r1).toEqual({ acquired: true, count: 1, cap: 2 });

      // Duplicate acquire of the same entry is idempotent (Set semantics) —
      // does not grow the count, while the set is still under cap.
      const r1Dup = await counter.tryAcquire(pageId, 'user-1', 'socket-1');
      expect(r1Dup).toEqual({ acquired: true, count: 1, cap: 2 });

      const r2 = await counter.tryAcquire(pageId, 'user-2', 'socket-2');
      expect(r2).toEqual({ acquired: true, count: 2, cap: 2 });

      // 3rd acquirer is rejected — the cap is full.
      const r3 = await counter.tryAcquire(pageId, 'user-3', 'socket-3');
      expect(r3).toEqual({ acquired: false, count: 2, cap: 2 });

      // peek() agrees without mutating.
      expect(await counter.peek(pageId)).toEqual({ count: 2, cap: 2 });

      // release frees a slot — the 3rd acquirer now fits.
      await counter.release(pageId, 'user-2', 'socket-2');
      const r3Retry = await counter.tryAcquire(pageId, 'user-3', 'socket-3');
      expect(r3Retry).toEqual({ acquired: true, count: 2, cap: 2 });

      // TTL (24h) is applied on the underlying Redis key.
      const ttlSeconds = await client.ttl(editorCapKey);
      expect(ttlSeconds).toBeGreaterThan(0);
      expect(ttlSeconds).toBeLessThanOrEqual(86400);

      // Prove the TTL is *re-armed* on every successful SADD, not merely
      // "still positive" from the very first acquire: shrink it artificially,
      // then trigger one more successful SADD (via release + re-acquire) and
      // confirm the TTL jumps back up near the full 24h window.
      await client.expire(editorCapKey, 5);
      const shrunkTtl = await client.ttl(editorCapKey);
      expect(shrunkTtl).toBeGreaterThan(0);
      expect(shrunkTtl).toBeLessThanOrEqual(5);

      await counter.release(pageId, 'user-3', 'socket-3');
      const r4 = await counter.tryAcquire(pageId, 'user-4', 'socket-4');
      expect(r4).toEqual({ acquired: true, count: 2, cap: 2 });

      const reArmedTtl = await client.ttl(editorCapKey);
      expect(reArmedTtl).toBeGreaterThan(shrunkTtl);
      expect(reArmedTtl).toBeGreaterThan(3600);
      expect(reArmedTtl).toBeLessThanOrEqual(86400);

      // Clean up the key this test created.
      await client.del(editorCapKey);
    });
  }, 15000);
});
