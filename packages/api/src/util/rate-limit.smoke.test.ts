/**
 * feature-redis-8-upgrade Phase 2 — rate limiting smoke (consumer #6).
 *
 * Real `redis` v4 client (Redis 8, shared instance) driving
 * `createRateLimiter`'s Redis-backed path — same fixed-window `INCR` +
 * `PEXPIRE` sequence the fake-based `rate-limit.test.ts` already covers —
 * plus a window-reset check driven by a mocked `Date.now` (the limiter
 * derives its window index purely from `Date.now`; real Redis only ever
 * sees the derived key names, so the INCR/PEXPIRE/TTL path stays fully
 * real while the test never sleeps and can never straddle a window
 * boundary mid-burst).
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

      // Pin the clock mid-window: the burst below can then never straddle
      // a window boundary, and the derived key is exact by construction.
      const base = Math.floor(Date.now() / windowMs) * windowMs + 50;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);
      const window1 = Math.floor(base / windowMs);
      const key = `crowi:ratelimit:${name}:${userId}:${window1}`;
      try {
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

        // Roll the window by advancing the MOCKED clock — no sleep, no
        // boundary race; a fresh window resets the count.
        nowSpy.mockReturnValue(base + windowMs);
        const window2 = window1 + 1;
        const secondKey = `crowi:ratelimit:${name}:${userId}:${window2}`;
        const r4 = await limiter.hit(userId);
        expect(r4).toMatchObject({ allowed: true, count: 1, limit: 2 });

        // Clean up both window keys this test created (the TTL would expire
        // them anyway, but every smoke test explicitly DELs its own keys —
        // see the spec's "どのテストも FLUSHALL/FLUSHDB は呼ばず...後始末で
        // DEL...している").
        await client.del([key, secondKey]);
      } finally {
        nowSpy.mockRestore();
      }
    });
  }, 15000);
});
