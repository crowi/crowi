/**
 * feature-redis-8-upgrade Phase 2 — rate limiting smoke (consumer #6).
 *
 * Real `redis` v4 client (Redis 8, shared instance) driving
 * `createRateLimiter`'s Redis-backed path — same fixed-window `INCR` +
 * `PEXPIRE` sequence the fake-based `rate-limit.test.ts` already covers —
 * plus a real-clock window-reset check (real Redis TTL means fake timers
 * can't drive this one; a short real `windowMs` + a real sleep past it is
 * used instead).
 */

import { markRedisSmokeRan, REDIS_SMOKE_URLS, redisSmokeReachable, uniqueRedisSmokeId, withRedisClient } from 'src/test/redis-smoke';
import { createRateLimiter, type RateLimitRedisClient } from 'src/util/rate-limit';

const describeMaybe = redisSmokeReachable.shared ? describe : describe.skip;

describeMaybe('rate limiting smoke (real Redis 8)', () => {
  beforeAll(() => {
    markRedisSmokeRan('rate-limit');
  });

  it('allows up to the limit within a window, blocks over-budget requests, and resets once the window rolls over', async () => {
    await withRedisClient(REDIS_SMOKE_URLS.shared, async (client) => {
      const name = uniqueRedisSmokeId('ratelimit-bucket');
      const userId = uniqueRedisSmokeId('ratelimit-user');
      const windowMs = 400;
      const limiter = createRateLimiter({ name, limit: 2, windowMs, redisClient: client as unknown as RateLimitRedisClient });

      // Sample the clock ONCE, immediately before the burst of `hit()`
      // calls, and derive the key from that single sample — not from a
      // fresh `Date.now()` taken after the 3 awaited round trips below.
      // `hit()` computes its own window index from `Date.now()`
      // internally too; re-deriving the key from a LATER clock sample
      // risks landing in the next window if a bucket boundary is crossed
      // while awaiting, producing a mismatched key (flaky assertion +
      // an orphaned, un-cleaned-up key).
      const window1 = Math.floor(Date.now() / windowMs);
      const key = `crowi:ratelimit:${name}:${userId}:${window1}`;

      const r1 = await limiter.hit(userId);
      const r2 = await limiter.hit(userId);
      const r3 = await limiter.hit(userId);

      expect(r1).toMatchObject({ allowed: true, count: 1, limit: 2 });
      expect(r2).toMatchObject({ allowed: true, count: 2, limit: 2 });
      expect(r3).toMatchObject({ allowed: false, count: 3, limit: 2 });

      // Real INCR under the hood — read the key directly to prove it's
      // actually Redis, not the in-memory fallback.
      expect(await client.get(key)).toBe('3');
      const ttlMs = await client.pTTL(key);
      expect(ttlMs).toBeGreaterThan(0);
      expect(ttlMs).toBeLessThanOrEqual(windowMs + 1000);

      // Wait for the window to roll over — a fresh window resets the count.
      await new Promise((resolve) => setTimeout(resolve, windowMs + 100));
      // Same fix as above: sample the clock right before `hit()`, not after.
      const window2 = Math.floor(Date.now() / windowMs);
      const secondKey = `crowi:ratelimit:${name}:${userId}:${window2}`;
      const r4 = await limiter.hit(userId);
      expect(r4).toMatchObject({ allowed: true, count: 1, limit: 2 });

      // Clean up both window keys this test created (the TTL would expire
      // them anyway, but every smoke test explicitly DELs its own keys —
      // see the spec's "どのテストも FLUSHALL/FLUSHDB は呼ばず...後始末で
      // DEL...している").
      await client.del([key, secondKey]);
    });
  }, 15000);
});
