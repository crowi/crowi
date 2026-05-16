import { EventEmitter } from 'node:events';
import Debug from 'debug';
import type { PresenceViewer } from '@crowi/api-contract';
import type Crowi from 'src/crowi';

const debug = Debug('crowi:service:presence');

/**
 * RFC-0005 — page-presence service.
 *
 * Tracks which users are currently *viewing* a page (the live-presence
 * row above the page title). Editor-side presence (peer cursors,
 * typing badges) is RFC-0003's concern and lives in `@crowi/collab`.
 *
 * Replaces the RFC-0003 Phase 5 `markEditing` no-op stub that
 * previously occupied this file — the swap point the stub's comment
 * promised. The collab package still calls into presence through a
 * dependency-injected adapter (`createPresenceCollabDeps` below) so
 * `@crowi/collab` never imports `@crowi/api`.
 *
 * Wire-level design:
 *
 *   - Viewer hash: `crowi:presence:viewers:<pageId>` — a Redis hash,
 *     one field per viewing `userId`, value a JSON blob with the
 *     viewer's denormalised identity + `joinedAt` + `lastHeartbeatAt`.
 *   - TTL: the hash carries a *key-level* `EXPIRE` (re-applied on every
 *     write) so an idle page's hash evaporates. Per-*field* TTL would
 *     need `HEXPIRE` (Redis 7.4 / node-redis v5) which this codebase's
 *     node-redis v4.7 does not expose — instead each field stores
 *     `lastHeartbeatAt` and `listViewers` filters out entries whose
 *     last heartbeat is older than `VIEWER_TTL_MS`, sweeping the stale
 *     fields from the hash as a side effect.
 *   - Pub/sub: `crowi:presence:updates` carries `<pageId>` strings.
 *     When a viewer joins / leaves on api instance A, A publishes the
 *     pageId; every instance (including A) re-broadcasts the fresh
 *     viewer list to its locally-connected clients. Same
 *     Redis-as-shared-state pattern as RFC-0003.
 *   - `isEditing`: NOT stored in the presence hash. It is derived at
 *     `listViewers` time by joining the viewer set with RFC-0003's
 *     editor-cap Set `crowi:collab:editors:<pageId>` (whose members are
 *     `<userId>:<socketId>`). Single source of truth for "is editing".
 *
 * Fail-soft posture: when `crowi.redis` is null (REDIS_URL unset,
 * single-instance dev) presence degrades to an in-process-only store
 * with no cross-instance fan-out. The `/presence` WebSocket still works
 * for viewers connected to the same process.
 */

/** Redis key prefix for the per-page viewer hash. */
const VIEWER_HASH_PREFIX = 'crowi:presence:viewers:';
/** Redis pub/sub channel for cross-instance viewer-list invalidation. */
const PRESENCE_UPDATES_CHANNEL = 'crowi:presence:updates';
/** Editor-cap Set prefix from RFC-0003 (`util/editor-cap-counter.ts`). */
const EDITOR_CAP_PREFIX = 'crowi:collab:editors:';

/**
 * A viewer entry is considered live for 30s after its last heartbeat.
 * The browser heartbeats every 15s, so a viewer normally refreshes
 * twice within the window; a single dropped heartbeat does not evict.
 */
const VIEWER_TTL_MS = 30_000;
/**
 * Key-level TTL for the viewer hash. Comfortably above `VIEWER_TTL_MS`
 * so a page with one slow-to-leave viewer keeps its hash, but bounded
 * so an abandoned page's hash is reaped within a minute of the last
 * heartbeat even if no `leave` ever fires.
 */
const VIEWER_HASH_TTL_SECONDS = 60;

const viewerHashKey = (pageId: string): string => `${VIEWER_HASH_PREFIX}${pageId}`;
const editorCapKey = (pageId: string): string => `${EDITOR_CAP_PREFIX}${pageId}`;

/** Denormalised viewer identity persisted in the Redis hash field. */
interface StoredViewer {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  joinedAt: number;
  lastHeartbeatAt: number;
}

/** Identity fields a caller supplies when a viewer joins. */
export interface ViewerIdentity {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * Minimum node-redis v4 surface the presence service leans on. Keeps
 * the test-mock surface narrow and documents exactly which commands a
 * fake must implement.
 */
export interface PresenceRedisClient {
  hSet(key: string, field: string, value: string): Promise<number>;
  hGet(key: string, field: string): Promise<string | null | undefined>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hDel(key: string, field: string | string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<boolean | number>;
  sMembers(key: string): Promise<string[]>;
  publish(channel: string, message: string): Promise<number>;
  duplicate(): PresenceRedisClient;
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  subscribe(channel: string, listener: (message: string) => void): Promise<void>;
  isOpen?: boolean;
}

/**
 * Public surface of the presence service. The `/presence` WebSocket
 * handler holds one process-shared instance (see `getPresenceService`);
 * `@crowi/collab` is wired to `markEditing` / `unmarkEditing` via
 * dependency injection so the collab package never imports `@crowi/api`.
 */
export interface PresenceService {
  /**
   * Register (or refresh) a viewer for a page. Idempotent — re-calling
   * for the same `userId` updates `lastHeartbeatAt` and dedupes
   * multiple tabs to a single hash field. Publishes a viewer-list
   * change so every instance re-broadcasts.
   */
  join(pageId: string, viewer: ViewerIdentity): Promise<void>;
  /**
   * Refresh a viewer's `lastHeartbeatAt` (and the hash key TTL). Called
   * on every client heartbeat. Returns `false` when the viewer was not
   * present (e.g. swept while the socket was briefly idle) so the
   * handler can re-`join`.
   */
  heartbeat(pageId: string, userId: string): Promise<boolean>;
  /**
   * Remove a viewer from a page. Idempotent. Publishes a viewer-list
   * change. The handler calls this on WebSocket close.
   */
  leave(pageId: string, userId: string): Promise<void>;
  /**
   * Current live viewer list for a page, with `isEditing` joined from
   * the RFC-0003 editor-cap Set. Stale entries (heartbeat older than
   * `VIEWER_TTL_MS`) are filtered out and swept from the hash.
   */
  listViewers(pageId: string): Promise<PresenceViewer[]>;
  /**
   * Collab `onAuthenticate` integration point — a user opened the
   * editor for this page. Presence does not store an editing flag
   * itself (it joins the editor-cap Set at `listViewers` time); this
   * just publishes a viewer-list change so the next broadcast picks up
   * the freshly-added editor-cap entry.
   */
  markEditing(pageId: string, userId: string): Promise<void>;
  /**
   * Collab `onDisconnect` integration point — a user closed the editor.
   * Symmetric with `markEditing`: publishes a viewer-list change so the
   * `✏️` badge clears on the next broadcast.
   */
  unmarkEditing(pageId: string, userId: string): Promise<void>;
  /**
   * Subscribe to viewer-list change notifications. The listener is
   * invoked with a `pageId` whenever that page's viewer list may have
   * changed (local or cross-instance). Returns an unsubscribe fn.
   */
  onViewersChanged(listener: (pageId: string) => void): () => void;
  /** Tear down the dedicated pub/sub subscriber client. */
  shutdown(): Promise<void>;
}

/**
 * Build a presence service.
 *
 *   - `redis` present  → cross-instance mode: viewer state in Redis,
 *     change notifications fan out via pub/sub.
 *   - `redis` null     → single-instance mode: viewer state in a
 *     process-local Map, change notifications are emitted directly.
 *
 * The two modes share the same `PresenceService` surface so the
 * `/presence` handler never branches on Redis availability.
 */
export async function createPresenceService(redis: PresenceRedisClient | null): Promise<PresenceService> {
  // Local EventEmitter the `/presence` handler subscribes to. In Redis
  // mode it is fed by the pub/sub subscriber + local publishes; in
  // single-instance mode it is emitted directly.
  const emitter = new EventEmitter();
  // EventEmitter's default 10-listener cap warns once per page with
  // many connected sockets; presence legitimately has one listener per
  // connected socket, so lift the cap.
  emitter.setMaxListeners(0);

  const emitChange = (pageId: string): void => {
    emitter.emit('change', pageId);
  };

  if (redis === null) {
    return createInProcessPresenceService(emitter, emitChange);
  }
  return createRedisPresenceService(redis, emitter, emitChange);
}

/**
 * Single-instance (no Redis) implementation. Viewer state lives in a
 * process-local Map; `markEditing` / `unmarkEditing` cannot consult the
 * editor-cap Set (also Redis-backed) so `isEditing` is always `false`
 * — acceptable for dev, and documented in the RFC's fail-soft notes.
 */
function createInProcessPresenceService(emitter: EventEmitter, emitChange: (pageId: string) => void): PresenceService {
  const pages = new Map<string, Map<string, StoredViewer>>();

  const pageMap = (pageId: string): Map<string, StoredViewer> => {
    let m = pages.get(pageId);
    if (!m) {
      m = new Map();
      pages.set(pageId, m);
    }
    return m;
  };

  return {
    async join(pageId, viewer) {
      const now = Date.now();
      const m = pageMap(pageId);
      const existing = m.get(viewer.userId);
      m.set(viewer.userId, {
        userId: viewer.userId,
        username: viewer.username,
        displayName: viewer.displayName,
        avatarUrl: viewer.avatarUrl,
        joinedAt: existing?.joinedAt ?? now,
        lastHeartbeatAt: now,
      });
      emitChange(pageId);
    },
    async heartbeat(pageId, userId) {
      const entry = pages.get(pageId)?.get(userId);
      if (!entry) return false;
      entry.lastHeartbeatAt = Date.now();
      return true;
    },
    async leave(pageId, userId) {
      if (pages.get(pageId)?.delete(userId)) {
        emitChange(pageId);
      }
    },
    async listViewers(pageId) {
      const m = pages.get(pageId);
      if (!m) return [];
      const cutoff = Date.now() - VIEWER_TTL_MS;
      const out: PresenceViewer[] = [];
      for (const [userId, entry] of m) {
        if (entry.lastHeartbeatAt < cutoff) {
          m.delete(userId);
          continue;
        }
        out.push({
          userId: entry.userId,
          username: entry.username,
          displayName: entry.displayName,
          avatarUrl: entry.avatarUrl,
          // No Redis → no editor-cap Set → no editing signal in dev.
          isEditing: false,
          joinedAt: entry.joinedAt,
        });
      }
      return out.sort((a, b) => a.joinedAt - b.joinedAt);
    },
    async markEditing(pageId) {
      emitChange(pageId);
    },
    async unmarkEditing(pageId) {
      emitChange(pageId);
    },
    onViewersChanged(listener) {
      emitter.on('change', listener);
      return () => emitter.off('change', listener);
    },
    async shutdown() {
      emitter.removeAllListeners();
    },
  };
}

/**
 * Cross-instance (Redis) implementation.
 *
 * A *dedicated* subscriber client is duplicated off the shared
 * `crowi.redis` — node-redis v4 puts a connection into subscriber mode
 * on `subscribe`, after which it can no longer issue regular commands,
 * so the hash writes must go through the original (non-subscriber)
 * client.
 */
async function createRedisPresenceService(redis: PresenceRedisClient, emitter: EventEmitter, emitChange: (pageId: string) => void): Promise<PresenceService> {
  let subscriber: PresenceRedisClient | null = null;
  try {
    const dup = redis.duplicate();
    await dup.connect();
    await dup.subscribe(PRESENCE_UPDATES_CHANNEL, (message: string) => {
      // The published message is the bare pageId.
      if (message) emitChange(message);
    });
    subscriber = dup;
    debug('presence pub/sub subscriber connected on %s', PRESENCE_UPDATES_CHANNEL);
  } catch (err) {
    // A subscriber failure degrades presence to single-instance
    // behaviour for *this* process — local clients still work, but
    // cross-instance fan-out is lost. Never fatal.
    console.warn('[crowi:presence] pub/sub subscriber setup failed — cross-instance fan-out disabled:', (err as Error).message);
  }

  /**
   * Publish a viewer-list change. Also emits locally so the publishing
   * instance re-broadcasts without waiting for the pub/sub round-trip.
   * The subscriber on *this* process will also see the published
   * message and fire `change` again — harmless (the second broadcast
   * sends an identical viewer list); emitting locally is the
   * lower-latency path and the subscriber is what reaches the *other*
   * instances.
   */
  const publishChange = async (pageId: string): Promise<void> => {
    emitChange(pageId);
    try {
      await redis.publish(PRESENCE_UPDATES_CHANNEL, pageId);
    } catch (err) {
      console.warn(`[crowi:presence] publish failed for page ${pageId}:`, (err as Error).message);
    }
  };

  /** Read + parse the viewer hash, dropping fields that fail to parse. */
  const readHash = async (pageId: string): Promise<Map<string, StoredViewer>> => {
    const raw = await redis.hGetAll(viewerHashKey(pageId));
    const out = new Map<string, StoredViewer>();
    for (const [userId, json] of Object.entries(raw ?? {})) {
      try {
        const parsed = JSON.parse(json) as StoredViewer;
        if (parsed && typeof parsed.lastHeartbeatAt === 'number') {
          out.set(userId, parsed);
        }
      } catch {
        // Corrupt field — ignore; it expires with the hash TTL.
        debug('dropping unparseable viewer field user=%s page=%s', userId, pageId);
      }
    }
    return out;
  };

  /**
   * Extract the set of userIds currently editing this page from the
   * RFC-0003 editor-cap Set. Members are `<userId>:<socketId>`; a user
   * with multiple editor tabs appears once in the resulting set.
   */
  const editingUserIds = async (pageId: string): Promise<Set<string>> => {
    try {
      const members = await redis.sMembers(editorCapKey(pageId));
      const ids = new Set<string>();
      for (const member of members) {
        const sep = member.indexOf(':');
        ids.add(sep < 0 ? member : member.slice(0, sep));
      }
      return ids;
    } catch (err) {
      // Editing is advisory — a failed read just means no `✏️` badge.
      console.warn(`[crowi:presence] editor-cap read failed for page ${pageId}:`, (err as Error).message);
      return new Set();
    }
  };

  return {
    async join(pageId, viewer) {
      const key = viewerHashKey(pageId);
      const now = Date.now();
      // Preserve the original joinedAt across re-joins / extra tabs so
      // avatar ordering stays stable.
      let joinedAt = now;
      try {
        const existingRaw = await redis.hGet(key, viewer.userId);
        if (existingRaw) {
          const existing = JSON.parse(existingRaw) as StoredViewer;
          if (typeof existing.joinedAt === 'number') joinedAt = existing.joinedAt;
        }
      } catch {
        // Treat an unreadable prior entry as a fresh join.
      }
      const stored: StoredViewer = {
        userId: viewer.userId,
        username: viewer.username,
        displayName: viewer.displayName,
        avatarUrl: viewer.avatarUrl,
        joinedAt,
        lastHeartbeatAt: now,
      };
      await redis.hSet(key, viewer.userId, JSON.stringify(stored));
      await redis.expire(key, VIEWER_HASH_TTL_SECONDS);
      await publishChange(pageId);
    },

    async heartbeat(pageId, userId) {
      const key = viewerHashKey(pageId);
      const existingRaw = await redis.hGet(key, userId);
      if (!existingRaw) return false;
      let existing: StoredViewer;
      try {
        existing = JSON.parse(existingRaw) as StoredViewer;
      } catch {
        return false;
      }
      existing.lastHeartbeatAt = Date.now();
      await redis.hSet(key, userId, JSON.stringify(existing));
      await redis.expire(key, VIEWER_HASH_TTL_SECONDS);
      // A heartbeat doesn't change *who* is here, so no broadcast — it
      // only refreshes the TTL.
      return true;
    },

    async leave(pageId, userId) {
      const removed = await redis.hDel(viewerHashKey(pageId), userId);
      if (removed > 0) {
        await publishChange(pageId);
      }
    },

    async listViewers(pageId) {
      const [hash, editing] = await Promise.all([readHash(pageId), editingUserIds(pageId)]);
      const cutoff = Date.now() - VIEWER_TTL_MS;
      const stale: string[] = [];
      const out: PresenceViewer[] = [];
      for (const [userId, entry] of hash) {
        if (entry.lastHeartbeatAt < cutoff) {
          stale.push(userId);
          continue;
        }
        out.push({
          userId: entry.userId,
          username: entry.username,
          displayName: entry.displayName,
          avatarUrl: entry.avatarUrl,
          isEditing: editing.has(entry.userId),
          joinedAt: entry.joinedAt,
        });
      }
      // Sweep stale fields so an abandoned page eventually empties its
      // hash even with HEXPIRE unavailable.
      if (stale.length > 0) {
        try {
          await redis.hDel(viewerHashKey(pageId), stale);
        } catch (err) {
          debug('stale-field sweep failed for page %s: %s', pageId, (err as Error).message);
        }
      }
      return out.sort((a, b) => a.joinedAt - b.joinedAt);
    },

    async markEditing(pageId, userId) {
      // The editor-cap SADD is owned by `@crowi/collab`'s
      // `editorCapCounter.tryAcquire` (RFC-0003). Presence only needs
      // to nudge a re-broadcast so the freshly-added editing user gets
      // an `✏️` badge.
      debug('markEditing page=%s user=%s — publishing viewer-list change', pageId, userId);
      await publishChange(pageId);
    },

    async unmarkEditing(pageId, userId) {
      debug('unmarkEditing page=%s user=%s — publishing viewer-list change', pageId, userId);
      await publishChange(pageId);
    },

    onViewersChanged(listener) {
      emitter.on('change', listener);
      return () => emitter.off('change', listener);
    },

    async shutdown() {
      emitter.removeAllListeners();
      if (subscriber) {
        try {
          await subscriber.disconnect();
        } catch (err) {
          debug('subscriber disconnect failed: %s', (err as Error).message);
        }
        subscriber = null;
      }
    },
  };
}

/**
 * Process-shared presence service. Lazy so the api can boot without an
 * immediate Redis round-trip; the service materialises on the first
 * `/presence` connect or the first collab `onAuthenticate`.
 *
 * Stores the in-flight promise (not the resolved service) so concurrent
 * first callers race onto the same instance — one subscriber client,
 * one EventEmitter.
 */
let cachedService: Promise<PresenceService> | null = null;

export function getPresenceService(crowi: Crowi): Promise<PresenceService> {
  if (cachedService) return cachedService;
  // `crowi.redis` is typed `any` on the Crowi class; narrow it to the
  // structural client surface (or null) the service expects.
  const redis = (crowi.redis as PresenceRedisClient | null) ?? null;
  cachedService = createPresenceService(redis);
  return cachedService;
}

/**
 * Collab → presence wiring. `@crowi/collab` is crowi-agnostic, so the
 * api hands it these two thin adapters via `createCollabServer`'s
 * `presence` option. Each resolves the process-shared presence service
 * lazily and forwards the call; errors are swallowed because presence
 * is advisory and must never block a collab connection.
 */
export interface PresenceCollabDeps {
  markEditing(pageId: string, userId: string): Promise<void>;
  unmarkEditing(pageId: string, userId: string): Promise<void>;
}

export function createPresenceCollabDeps(crowi: Crowi): PresenceCollabDeps {
  return {
    async markEditing(pageId, userId) {
      try {
        const service = await getPresenceService(crowi);
        await service.markEditing(pageId, userId);
      } catch (err) {
        console.warn('[crowi:presence] collab markEditing wiring failed (non-blocking):', (err as Error).message);
      }
    },
    async unmarkEditing(pageId, userId) {
      try {
        const service = await getPresenceService(crowi);
        await service.unmarkEditing(pageId, userId);
      } catch (err) {
        console.warn('[crowi:presence] collab unmarkEditing wiring failed (non-blocking):', (err as Error).message);
      }
    },
  };
}

/**
 * Test helper — inject a pre-built service or reset to lazy. Pass a
 * fake to exercise the `/presence` handler / collab wiring without
 * Redis; pass `null` to clear the cache.
 */
export const _setPresenceServiceForTesting = (service: PresenceService | null): void => {
  cachedService = service == null ? null : Promise.resolve(service);
};

export { PRESENCE_UPDATES_CHANNEL, VIEWER_HASH_PREFIX, VIEWER_TTL_MS };
