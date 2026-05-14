import Debug from 'debug';

const debug = Debug('crowi:util:editor-cap-counter');

/**
 * RFC-0003 Phase 6 — Redis-backed editor cap counter.
 *
 * Tracks the set of currently-connected editors per page so the
 * wsToken issuance path (api HTTP handler) and the WebSocket
 * `onAuthenticate` hook (in-process Hocuspocus engine; see
 * `src/collab/attach.ts`) agree on a single cluster-wide count.
 *
 * Wire-level design:
 *
 *   - Key:   `crowi:collab:editors:<pageId>`
 *   - Value: a **Set** of `<userId>:<socketId>` entries (one entry
 *            per active WebSocket connection).
 *   - TTL:   `EXPIRE 86400` (24 h) is re-applied on every successful
 *            `SADD` so an idle key naturally evaporates after a day
 *            of stillness. Stale entries left behind by abnormal
 *            disconnects are bounded by the same TTL — the spec
 *            (`defence in depth`) explicitly allows up to 24 h of
 *            overcount before Redis garbage-collects.
 *
 * Why a Set, not INCR/DECR?
 *
 *   - INCR / DECR is asymmetric on abnormal close: a +1 that never
 *     gets the matching -1 climbs the counter until an operator
 *     manually resets it. SADD-with-EXPIRE self-heals.
 *   - SCARD is O(1) so the read cost matches GET-against-INCR.
 *   - The same `<userId>:<socketId>` can be SADD'd twice (handler
 *     retry, etc.) without inflating the count (Set idempotency).
 *
 * Race window:
 *
 *   - SCARD + SADD is *not* atomic; a 21st client racing 20 acquirers
 *     can briefly observe `count = 20`, write its entry, then settle
 *     at 21. The spec accepts this — Phase 6 is "defence in depth",
 *     not "hard cap with Redis Lua". A `simplify` pass may add a Lua
 *     script if operations need stricter semantics.
 *
 * Fail-open posture:
 *
 *   - `redisClient` null/undefined (= REDIS_URL unset) → return a
 *     no-op counter: `peek` is always 0, `tryAcquire` is always
 *     `{acquired: true}`, `release` is a no-op. The cap is a soft
 *     limit by design.
 *
 * Phase 9 (same-process attach) signature change: the previous
 * `redisOpts` argument is replaced with a pre-built `redisClient`
 * (typed structurally as `MinimalRedisClient`). The api boot opens
 * exactly one Redis client per process (`crowi.redis`); embedded
 * collab now shares it instead of opening a second connection — see
 * `.feature-state/specs/feature-collab-embed-into-api.md` §"Redis
 * client 共有".
 */

const KEY_PREFIX = 'crowi:collab:editors:';
/** Default editor cap when `COLLAB_MAX_EDITORS_PER_PAGE` is unset / invalid. */
export const DEFAULT_MAX_EDITORS = 20;
const TTL_SECONDS = 86400; // 24h sliding window via re-EXPIRE on SADD

const keyFor = (pageId: string): string => `${KEY_PREFIX}${pageId}`;
const entryFor = (userId: string, socketId: string): string => `${userId}:${socketId}`;

/**
 * Parse `COLLAB_MAX_EDITORS_PER_PAGE` (or any equivalent env string)
 * defensively. Empty / non-numeric / non-positive values fall back to
 * `DEFAULT_MAX_EDITORS` so callers never have to remember the
 * "isFinite && > 0" dance.
 */
export function parseCapEnv(value: string | undefined): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_EDITORS;
}

export interface TryAcquireResult {
  acquired: boolean;
  /** Post-acquire SCARD (or the SCARD observed when rejection happens). */
  count: number;
  cap: number;
}

export interface EditorCapCounter {
  /** Soft maximum editors per page (`COLLAB_MAX_EDITORS_PER_PAGE`, default 20). */
  readonly maxEditorsPerPage: number;
  /**
   * Read-only count check. Used by the wsToken endpoint so a 21st
   * client gets a `readonly: true` token *before* the WebSocket
   * connects, avoiding the "editable for a millisecond then forced
   * readonly" UX bug.
   */
  peek(pageId: string): Promise<{ count: number; cap: number }>;
  /**
   * SADD the `<userId>:<socketId>` entry **after** verifying the
   * pre-acquire count is under the cap. Returns `acquired: false`
   * when the entry is rejected so the caller can flip the readonly
   * bit on the connection.
   */
  tryAcquire(pageId: string, userId: string, socketId: string): Promise<TryAcquireResult>;
  /**
   * SREM the entry. Best-effort: failures are warn-only (the entry
   * eventually expires via the per-key TTL). No-op for entries that
   * were never acquired (Redis SREM returns 0).
   */
  release(pageId: string, userId: string, socketId: string): Promise<void>;
  /**
   * Disconnect handler. Embedded collab shares `crowi.redis` so the
   * disconnect call is a no-op (api owns the client lifecycle). The
   * method stays on the interface so a future Phase 9 multi-instance
   * extension that owns its own client can implement teardown
   * symmetrically.
   */
  disconnect(): Promise<void>;
}

export interface CreateEditorCapCounterOptions {
  /**
   * Pre-built node-redis v4 client (typed structurally as
   * `MinimalRedisClient`). Pass `crowi.redis` from the api boot.
   * `null` / `undefined` → return a no-op counter (Redis not
   * configured; cap disabled).
   */
  redisClient?: MinimalRedisClient | null;
  /** Override the default 20-editor cap. */
  maxEditorsPerPage?: number;
  /**
   * Test seam — inject a pre-built `RedisClientType`-shaped object.
   * Kept distinct from `redisClient` so unit tests can drive a fake
   * without the api passing a real client (the production wiring
   * always uses `redisClient`; tests that mock the fake go through
   * this seam).
   */
  __clientForTest?: MinimalRedisClient;
}

/**
 * Minimum surface of node-redis v4 we lean on. Keeps the test mock
 * surface narrow and gives us a single place to extend if Phase 9's
 * multi-server work needs more commands.
 */
export interface MinimalRedisClient {
  isOpen: boolean;
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  sCard(key: string): Promise<number>;
  sAdd(key: string, member: string): Promise<number>;
  sRem(key: string, member: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

const makeNoopCounter = (maxEditorsPerPage: number): EditorCapCounter => ({
  maxEditorsPerPage,
  async peek() {
    return { count: 0, cap: maxEditorsPerPage };
  },
  async tryAcquire() {
    return { acquired: true, count: 0, cap: maxEditorsPerPage };
  },
  async release() {
    /* nothing */
  },
  async disconnect() {
    /* nothing */
  },
});

/**
 * Build an editor-cap counter against a shared Redis client.
 *
 * Returns a no-op counter when `redisClient` is null/undefined — the
 * API surface is identical so callers don't have to branch.
 */
export async function createEditorCapCounter(opts: CreateEditorCapCounterOptions = {}): Promise<EditorCapCounter> {
  const maxEditorsPerPage = opts.maxEditorsPerPage ?? DEFAULT_MAX_EDITORS;

  if (opts.__clientForTest) {
    return wrapClient(opts.__clientForTest, maxEditorsPerPage);
  }

  if (!opts.redisClient) {
    debug('redis client not provided — editor cap counter disabled (fail-open)');
    return makeNoopCounter(maxEditorsPerPage);
  }

  debug('editor cap counter ready (max=%d, key prefix=%s)', maxEditorsPerPage, KEY_PREFIX);
  return wrapClient(opts.redisClient, maxEditorsPerPage);
}

function wrapClient(client: MinimalRedisClient, maxEditorsPerPage: number): EditorCapCounter {
  return {
    maxEditorsPerPage,
    async peek(pageId) {
      try {
        const count = await client.sCard(keyFor(pageId));
        return { count, cap: maxEditorsPerPage };
      } catch (err) {
        console.warn(`[crowi:editor-cap-counter] peek failed for ${pageId} — treating as 0:`, (err as Error).message);
        return { count: 0, cap: maxEditorsPerPage };
      }
    },
    async tryAcquire(pageId, userId, socketId) {
      const key = keyFor(pageId);
      const entry = entryFor(userId, socketId);
      let preCount: number;
      try {
        preCount = await client.sCard(key);
      } catch (err) {
        console.warn(`[crowi:editor-cap-counter] tryAcquire SCARD failed for ${pageId} — fail-open:`, (err as Error).message);
        return { acquired: true, count: 0, cap: maxEditorsPerPage };
      }
      if (preCount >= maxEditorsPerPage) {
        debug('cap exceeded for page %s (count=%d max=%d)', pageId, preCount, maxEditorsPerPage);
        return { acquired: false, count: preCount, cap: maxEditorsPerPage };
      }
      try {
        const added = await client.sAdd(key, entry);
        await client.expire(key, TTL_SECONDS);
        // `added === 0` means the entry already existed in the set;
        // treat it as a successful acquire so a handler retry is
        // idempotent. The count reported is `preCount` (unchanged)
        // when the entry was already present.
        const count = preCount + (added > 0 ? 1 : 0);
        debug('acquired page=%s entry=%s count=%d', pageId, entry, count);
        return { acquired: true, count, cap: maxEditorsPerPage };
      } catch (err) {
        console.warn(`[crowi:editor-cap-counter] tryAcquire SADD failed for ${pageId} — fail-open:`, (err as Error).message);
        return { acquired: true, count: preCount, cap: maxEditorsPerPage };
      }
    },
    async release(pageId, userId, socketId) {
      try {
        await client.sRem(keyFor(pageId), entryFor(userId, socketId));
        debug('released page=%s user=%s socket=%s', pageId, userId, socketId);
      } catch (err) {
        console.warn(`[crowi:editor-cap-counter] release failed for ${pageId}:`, (err as Error).message);
      }
    },
    async disconnect() {
      // Shared client lifecycle is owned by Crowi (api boot). The
      // counter doesn't `disconnect()` the underlying client here —
      // doing so would tear down session storage / config pub-sub /
      // page-event pubsub too. Phase 9 multi-instance extensions
      // that *do* own a private client can override this.
      debug('disconnect() noop — shared client lifetime owned by Crowi');
    },
  };
}
