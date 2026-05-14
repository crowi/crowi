import Debug from 'debug';
import { createClient, type RedisClientType } from 'redis';

const debug = Debug('crowi:util:editor-cap-counter');

/**
 * RFC-0003 Phase 6 — Redis-backed editor cap counter.
 *
 * Tracks the set of currently-connected editors per page so the
 * api process (wsToken issuance) and the collab process (Hocuspocus
 * `onAuthenticate` defence-in-depth) agree on a single cluster-wide
 * count.
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
 *   - No `redisOpts` (REDIS_URL unset) → return a no-op counter:
 *     `peek` is always 0, `tryAcquire` is always `{acquired: true}`,
 *     `release` is a no-op. This lets a single-instance deployment
 *     run without Redis (cap simply disabled — the underlying spec
 *     intent is a soft limit, not a fail-closed gate).
 *   - Connect failure on boot → warn + degrade to the same no-op
 *     counter. The collab side gates its real counter behind the
 *     same fallback so a Redis outage never blocks new editors.
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
 * "isFinite && > 0" dance. Exported for `collab-cap.ts` /
 * `collab/server.ts` to share the same parsing rule.
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
   * Disconnect the Redis client. Idempotent — safe to call from a
   * SIGTERM handler that also disconnects other Redis clients.
   */
  disconnect(): Promise<void>;
}

export interface CreateEditorCapCounterOptions {
  /**
   * Node-redis v4 client options (`socket`/`password` shape). Build
   * from `REDIS_URL` via `buildRedisOpts` so api + collab agree on
   * TLS / port / password semantics. Pass `null` to force a no-op
   * counter (REDIS_URL not configured).
   */
  redisOpts?: Record<string, unknown> | null;
  /** Override the default 20-editor cap. */
  maxEditorsPerPage?: number;
  /**
   * Test seam — inject a pre-built `RedisClientType`-shaped object.
   * The util's unit tests use this to avoid spinning up real Redis
   * (mirroring the `service/page-event-pubsub.test.ts` posture of
   * verifying behaviour against the public surface rather than the
   * client lifecycle, which is covered by `service/config.ts`).
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
 * Build an editor-cap counter against Redis. Returns a no-op counter
 * when `redisOpts` is null/undefined or when the initial `connect()`
 * fails — the API surface is identical so callers don't have to
 * branch.
 */
export async function createEditorCapCounter(opts: CreateEditorCapCounterOptions = {}): Promise<EditorCapCounter> {
  const maxEditorsPerPage = opts.maxEditorsPerPage ?? DEFAULT_MAX_EDITORS;

  if (opts.__clientForTest) {
    return wrapClient(opts.__clientForTest, maxEditorsPerPage);
  }

  if (!opts.redisOpts) {
    debug('REDIS_URL not configured — editor cap counter disabled (fail-open)');
    return makeNoopCounter(maxEditorsPerPage);
  }

  let client: RedisClientType;
  try {
    client = createClient(opts.redisOpts);
    await client.connect();
  } catch (err) {
    console.warn('[crowi:editor-cap-counter] Redis connect failed — editor cap disabled (fail-open).', (err as Error).message);
    return makeNoopCounter(maxEditorsPerPage);
  }

  debug('editor cap counter ready (max=%d, key prefix=%s)', maxEditorsPerPage, KEY_PREFIX);

  // Surface but never crash on background client errors. `connect`
  // succeeded so the client is in a usable state; emitter errors that
  // arrive after boot (transient TLS / partition) should warn and let
  // the next op rediscover.
  client.on('error', (err: Error) => {
    console.warn('[crowi:editor-cap-counter] redis client error:', err.message);
  });

  return wrapClient(client, maxEditorsPerPage);
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
      try {
        if (client.isOpen) {
          await client.disconnect();
        }
      } catch (err) {
        debug('disconnect error: %s', (err as Error).message);
      }
    },
  };
}
