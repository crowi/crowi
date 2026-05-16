import { createRateLimiter, type RateLimitRedisClient } from './rate-limit';

/**
 * RFC-0004 Phase 5 — unit tests for the generic per-user rate limiter.
 *
 * Covers the in-memory fallback (count / over-budget / per-user
 * isolation / window reset) and the Redis-backed path (shared counter,
 * TTL set once, fail-open on error).
 */
describe('createRateLimiter', () => {
  describe('in-memory fallback', () => {
    it('allows up to `limit` requests then blocks', async () => {
      const limiter = createRateLimiter({ name: 'test', limit: 3, windowMs: 60_000 });

      const r1 = await limiter.hit('alice');
      const r2 = await limiter.hit('alice');
      const r3 = await limiter.hit('alice');
      const r4 = await limiter.hit('alice');

      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      expect(r3.allowed).toBe(true);
      expect(r4.allowed).toBe(false);
      expect(r4.count).toBe(4);
      expect(r4.limit).toBe(3);
      expect(r4.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    });

    it('counts each user independently', async () => {
      const limiter = createRateLimiter({ name: 'test', limit: 1, windowMs: 60_000 });

      const alice = await limiter.hit('alice');
      const bob = await limiter.hit('bob');
      const aliceAgain = await limiter.hit('alice');

      expect(alice.allowed).toBe(true);
      expect(bob.allowed).toBe(true);
      expect(aliceAgain.allowed).toBe(false);
    });

    it('resets the counter when the fixed window rolls over', async () => {
      const realNow = Date.now;
      try {
        let clock = 1_000_000;
        Date.now = () => clock;
        const limiter = createRateLimiter({ name: 'test', limit: 1, windowMs: 1_000 });

        expect((await limiter.hit('alice')).allowed).toBe(true);
        expect((await limiter.hit('alice')).allowed).toBe(false);

        // Advance past the window boundary — counter resets.
        clock += 1_000;
        expect((await limiter.hit('alice')).allowed).toBe(true);
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe('Redis-backed', () => {
    const makeFakeRedis = () => {
      const store = new Map<string, number>();
      const expires: string[] = [];
      const client: RateLimitRedisClient = {
        async incr(key) {
          const next = (store.get(key) ?? 0) + 1;
          store.set(key, next);
          return next;
        },
        async pExpire(key) {
          expires.push(key);
        },
      };
      return { client, store, expires };
    };

    it('shares the counter across calls and sets TTL exactly once', async () => {
      const { client, expires } = makeFakeRedis();
      const limiter = createRateLimiter({ name: 'test', limit: 2, windowMs: 60_000, redisClient: client });

      const r1 = await limiter.hit('alice');
      const r2 = await limiter.hit('alice');
      const r3 = await limiter.hit('alice');

      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      expect(r3.allowed).toBe(false);
      // pExpire only on the window-opening hit.
      expect(expires).toHaveLength(1);
    });

    it('fails open when the Redis round-trip throws', async () => {
      const client: RateLimitRedisClient = {
        async incr() {
          throw new Error('redis down');
        },
        async pExpire() {
          /* unreachable */
        },
      };
      const limiter = createRateLimiter({ name: 'test', limit: 1, windowMs: 60_000, redisClient: client });

      const r1 = await limiter.hit('alice');
      const r2 = await limiter.hit('alice');

      // Both allowed — a Redis blip must not take the feature down.
      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
    });
  });
});
