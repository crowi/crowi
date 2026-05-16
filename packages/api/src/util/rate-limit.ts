import Debug from 'debug';

const debug = Debug('crowi:util:rate-limit');

/**
 * RFC-0004 Phase 5 — generic per-user fixed-window rate limiter.
 *
 * Used by the autocomplete endpoints (60 req/min/user) and, from
 * Phase 6, the attachment-upload endpoint (20 req/min/user). There was
 * no shared rate-limit utility before RFC-0004, so this is new.
 *
 * Storage strategy:
 *   - When a Redis client is supplied (multi-instance api deployment),
 *     counters live in Redis so the limit is shared across replicas.
 *     A fixed window keyed by `floor(now / windowMs)` keeps the logic
 *     to one `INCR` + one `EXPIRE` — no Lua, no sorted sets.
 *   - When no Redis client is supplied (single-instance dev), an
 *     in-memory `Map` fallback applies the same fixed-window logic
 *     within the process. Stale windows are pruned lazily on access
 *     plus by a low-frequency sweep so the map cannot grow unbounded.
 *
 * Fail-open posture: if the Redis round-trip throws, the request is
 * allowed. A rate limiter that hard-fails closed would turn a Redis
 * blip into a full feature outage, which is worse than briefly losing
 * the limit. The same posture is used by `editor-cap-counter.ts`.
 */

/**
 * Minimum surface of a node-redis v4 client this limiter leans on.
 * Structurally compatible with `crowi.redis`; kept narrow so tests can
 * supply a tiny fake.
 */
export interface RateLimitRedisClient {
  incr(key: string): Promise<number>;
  pExpire(key: string, ms: number): Promise<unknown>;
}

export interface RateLimitOptions {
  /** Logical bucket name, e.g. `'autocomplete'`. Namespaces the keys. */
  name: string;
  /** Max allowed requests per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Shared Redis client; omit / pass `null` to use the in-memory fallback. */
  redisClient?: RateLimitRedisClient | null;
}

export interface RateLimitResult {
  /** Whether this request is within budget (and should proceed). */
  allowed: boolean;
  /** Requests already counted in the current window (including this one). */
  count: number;
  /** Configured limit, echoed for response headers. */
  limit: number;
  /**
   * Seconds until the current window resets. Surfaced as `Retry-After`
   * on a 429. Always ≥ 1.
   */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /**
   * Count one request for `userId` and report whether it is allowed.
   * `userId` should be the stable user id; the limiter namespaces it
   * with `name` and the window index internally.
   */
  hit(userId: string): Promise<RateLimitResult>;
}

const KEY_PREFIX = 'crowi:ratelimit';

/** Current fixed-window index for `now`. */
const windowIndex = (now: number, windowMs: number): number => Math.floor(now / windowMs);

/** Milliseconds remaining until the window containing `now` resets. */
const msUntilReset = (now: number, windowMs: number): number => windowMs - (now % windowMs);

const toRetryAfterSeconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

/**
 * In-memory fallback store. One entry per `(name, userId, window)`
 * triple; the value is the running count. Entries from elapsed windows
 * are purged lazily and by a periodic sweep.
 */
class InMemoryWindowStore {
  private counts = new Map<string, { count: number; window: number }>();
  private lastSweep = 0;

  hit(key: string, window: number, windowMs: number): number {
    this.maybeSweep(window);
    const entry = this.counts.get(key);
    if (!entry || entry.window !== window) {
      this.counts.set(key, { count: 1, window });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  /** Drop entries whose window has elapsed. Cheap enough to run inline. */
  private maybeSweep(currentWindow: number): void {
    // Sweep at most once per ~window so a burst of hits doesn't walk
    // the whole map on every request.
    if (currentWindow === this.lastSweep) return;
    this.lastSweep = currentWindow;
    for (const [key, entry] of this.counts) {
      if (entry.window < currentWindow) this.counts.delete(key);
    }
  }
}

/**
 * Build a per-user rate limiter. Same API whether it is Redis-backed or
 * in-memory, so callers never branch.
 */
export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const { name, limit, windowMs, redisClient } = options;
  const memory = new InMemoryWindowStore();

  const evaluate = (count: number, now: number): RateLimitResult => ({
    allowed: count <= limit,
    count,
    limit,
    retryAfterSeconds: toRetryAfterSeconds(msUntilReset(now, windowMs)),
  });

  return {
    async hit(userId: string): Promise<RateLimitResult> {
      const now = Date.now();
      const window = windowIndex(now, windowMs);

      if (redisClient) {
        const key = `${KEY_PREFIX}:${name}:${userId}:${window}`;
        try {
          const count = await redisClient.incr(key);
          // Set the TTL once, when the window is first opened. A small
          // grace beyond `windowMs` avoids a race where the key expires
          // a hair before the window boundary.
          if (count === 1) {
            await redisClient.pExpire(key, windowMs + 1000);
          }
          return evaluate(count, now);
        } catch (err) {
          // Fail open — a Redis blip must not take the feature down.
          debug('redis hit failed for %s — failing open: %s', key, (err as Error).message);
          return { allowed: true, count: 0, limit, retryAfterSeconds: toRetryAfterSeconds(msUntilReset(now, windowMs)) };
        }
      }

      const key = `${name}:${userId}`;
      const count = memory.hit(key, window, windowMs);
      return evaluate(count, now);
    },
  };
}
