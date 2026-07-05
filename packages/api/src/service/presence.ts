import { EventEmitter } from 'node:events';
import type { PresenceCommentChangedMessage, PresenceViewer } from '@crowi/api-contract';
import Debug from 'debug';
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
 *   - `isEditing`: NOT stored in the viewer hash. It is derived at
 *     `listViewers` time from a dedicated, short-lived *editing hash*
 *     `crowi:presence:editing:<pageId>` — one field per editor
 *     connection (`<userId>:<socketId>`), value `lastSeenAt`
 *     (epoch-ms). The collab process refreshes its own fields every
 *     `EDITING_REFRESH_MS`; a field older than `EDITING_TTL_MS` is
 *     considered stale and swept. This replaces the earlier design
 *     that joined the RFC-0003 editor-cap Set: that Set is a *soft
 *     concurrency-limit counter* with a 24h key TTL whose members are
 *     only SREM'd on a clean `onDisconnect`, so an api crash / restart
 *     could leave stale members for up to 24h and paint the `✏️` badge
 *     on plain viewers. The editing hash self-heals: when the editing
 *     process dies it stops refreshing, and every field ages out
 *     within `EDITING_TTL_MS`.
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
/**
 * Redis pub/sub channel for cross-instance page-updated fan-out
 * (feature-live-page-content-sync). Distinct from
 * `PRESENCE_UPDATES_CHANNEL`, which carries bare pageId strings for the
 * viewer-list — this one carries a JSON `PageUpdatedPayload` so mixing
 * them on one channel would corrupt the viewer-list subscriber's
 * `emitChange(message)` (it treats the payload as a pageId).
 */
const PRESENCE_PAGE_UPDATED_CHANNEL = 'crowi:presence:page-updated';
/**
 * Redis pub/sub channel for cross-instance comment-changed fan-out
 * (feature-live-page-comment-sync). A third distinct channel carrying a
 * JSON `CommentChangedPayload`. It does NOT open a third subscriber
 * client: `createRedisPresenceService` subscribes it on the *same* dup
 * that already owns `PRESENCE_PAGE_UPDATED_CHANNEL` (node-redis v4
 * multiplexes many channels on one subscriber connection), so the
 * connection count is unchanged.
 */
const PRESENCE_COMMENT_CHANGED_CHANNEL = 'crowi:presence:comment-changed';
/**
 * Redis key prefix for the per-page *editing hash* — the presence-owned
 * short-lived editing signal that drives the `✏️` badge. One field per
 * editor connection (`<userId>:<socketId>`), value `lastSeenAt`.
 */
const EDITING_HASH_PREFIX = 'crowi:presence:editing:';

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

/**
 * An editing-hash field is considered live for 30s after its last
 * refresh. The collab process refreshes every `EDITING_REFRESH_MS`
 * (10s) so a healthy editor field stays comfortably fresh; once the
 * editing process dies and stops refreshing, the field ages out within
 * this window and the badge disappears.
 */
const EDITING_TTL_MS = 30_000;
/**
 * Key-level TTL for the editing hash, re-applied on every write.
 * Comfortably above `EDITING_TTL_MS` so a slow-to-disconnect editor
 * keeps the hash, but bounded so an abandoned page's editing hash is
 * reaped even if no `unmarkEditing` ever fires.
 */
const EDITING_HASH_TTL_SECONDS = 60;
/**
 * Interval at which the collab→presence adapter refreshes the
 * `lastSeenAt` of every live editor connection it owns. Well under
 * `EDITING_TTL_MS` so a single missed tick does not age a field out.
 */
const EDITING_REFRESH_MS = 10_000;

const viewerHashKey = (pageId: string): string => `${VIEWER_HASH_PREFIX}${pageId}`;
const editingHashKey = (pageId: string): string => `${EDITING_HASH_PREFIX}${pageId}`;
const editingField = (userId: string, socketId: string): string => `${userId}:${socketId}`;
/** Inverse of `editingField` — the `userId` portion of a `<userId>:<socketId>` field. */
const editingFieldUserId = (field: string): string => {
  const sep = field.indexOf(':');
  return sep < 0 ? field : field.slice(0, sep);
};

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
 * Signal payload for the read-side soft-refresh
 * (feature-live-page-content-sync). Mirrors the api-contract
 * `PresencePageUpdatedMessage` wire shape. Deliberately identity-only —
 * NO `body` / `renderedAst` — so a private page's content never crosses
 * the presence channel; the client re-fetches the body from the
 * permission-checked `GET /pages/revisions/{id}`.
 */
export interface PageUpdatedPayload {
  pageId: string;
  revisionId: string;
  editorUserId: string;
  editorDisplayName: string;
}

/**
 * Signal payload for the live comment append / removal
 * (feature-live-page-comment-sync). Reuses the api-contract wire type
 * minus its `type` discriminant (the attach layer re-adds `type` when
 * it frames the WebSocket message). Deliberately identity-only — NO
 * comment body — so a private page's discussion never crosses the
 * presence channel; the client re-fetches the list from the
 * permission-checked `GET /comments?page_id=`.
 */
export type CommentChangedPayload = Omit<PresenceCommentChangedMessage, 'type'>;

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
   * Current live viewer list for a page, with `isEditing` derived from
   * the short-lived editing hash. Stale entries (heartbeat older than
   * `VIEWER_TTL_MS`) are filtered out and swept from the hash.
   */
  listViewers(pageId: string): Promise<PresenceViewer[]>;
  /**
   * Collab `onAuthenticate` integration point — a user opened the
   * editor for this page on connection `socketId`. Records an editing
   * signal in the editing hash and publishes a viewer-list change so
   * the editor immediately picks up an `✏️` badge.
   */
  markEditing(pageId: string, userId: string, socketId: string): Promise<void>;
  /**
   * Keep-alive for a live editor connection — refreshes the editing
   * hash field's `lastSeenAt` so it does not age past `EDITING_TTL_MS`.
   * Unlike `markEditing` this does NOT publish a viewer-list change
   * (the editing set did not change), so periodic refreshes do not
   * trigger redundant broadcasts.
   */
  refreshEditing(pageId: string, userId: string, socketId: string): Promise<void>;
  /**
   * Collab `onDisconnect` integration point — a user closed the editor
   * on connection `socketId`. Removes the editing-hash field and
   * publishes a viewer-list change so the `✏️` badge clears on the next
   * broadcast.
   */
  unmarkEditing(pageId: string, userId: string, socketId: string): Promise<void>;
  /**
   * Subscribe to viewer-list change notifications. The listener is
   * invoked with a `pageId` whenever that page's viewer list may have
   * changed (local or cross-instance). Returns an unsubscribe fn.
   */
  onViewersChanged(listener: (pageId: string) => void): () => void;
  /**
   * Broadcast that a new revision was saved for `pageId`
   * (feature-live-page-content-sync). Fans out to every connected
   * viewer socket (local + cross-instance) so the read-side
   * soft-refresh can swap the body in place. Uses the `'page-updated'`
   * local emitter event + the dedicated Redis channel — the viewer-list
   * `'change'` path is untouched.
   */
  publishPageUpdated(pageId: string, payload: PageUpdatedPayload): Promise<void>;
  /**
   * Subscribe to page-updated signals. The listener is invoked with the
   * `pageId` + full `PageUpdatedPayload` whenever a new revision was
   * saved for a page (local or cross-instance). Returns an unsubscribe fn.
   */
  onPageUpdated(listener: (pageId: string, payload: PageUpdatedPayload) => void): () => void;
  /**
   * Broadcast that a comment was added to / removed from `pageId`
   * (feature-live-page-comment-sync). Fans out to every connected viewer
   * socket (local + cross-instance) so the reader's comment list can
   * append / drop the entry in place. Uses the `'comment-changed'` local
   * emitter event + a dedicated Redis channel — the viewer-list
   * `'change'` and `'page-updated'` paths are untouched.
   */
  publishCommentChanged(pageId: string, payload: CommentChangedPayload): Promise<void>;
  /**
   * Subscribe to comment-changed signals. The listener is invoked with
   * the `pageId` + full `CommentChangedPayload` whenever a comment was
   * added / removed on a page (local or cross-instance). Returns an
   * unsubscribe fn.
   */
  onCommentChanged(listener: (pageId: string, payload: CommentChangedPayload) => void): () => void;
  /** Tear down the dedicated pub/sub subscriber client(s). */
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
 * process-local Map; the editing signal is tracked in a parallel
 * process-local Map (`editing`), keyed `<pageId>` → `<userId>:<socketId>`
 * → `lastSeenAt`, mirroring the Redis editing hash. `isEditing` is
 * therefore accurate in single-instance dev too.
 */
function createInProcessPresenceService(emitter: EventEmitter, emitChange: (pageId: string) => void): PresenceService {
  const pages = new Map<string, Map<string, StoredViewer>>();
  // pageId → (`<userId>:<socketId>` → lastSeenAt). Mirrors the Redis
  // editing hash for the no-Redis dev path.
  const editing = new Map<string, Map<string, number>>();

  const pageMap = (pageId: string): Map<string, StoredViewer> => {
    let m = pages.get(pageId);
    if (!m) {
      m = new Map();
      pages.set(pageId, m);
    }
    return m;
  };

  const editingMap = (pageId: string): Map<string, number> => {
    let m = editing.get(pageId);
    if (!m) {
      m = new Map();
      editing.set(pageId, m);
    }
    return m;
  };

  /**
   * Set of userIds with a fresh editing signal for a page. Stale
   * fields (older than `EDITING_TTL_MS`) are swept as a side effect —
   * same pattern as the Redis implementation.
   */
  const editingUserIds = (pageId: string): Set<string> => {
    const m = editing.get(pageId);
    const ids = new Set<string>();
    if (!m) return ids;
    const cutoff = Date.now() - EDITING_TTL_MS;
    for (const [field, lastSeenAt] of m) {
      if (lastSeenAt < cutoff) {
        m.delete(field);
        continue;
      }
      ids.add(editingFieldUserId(field));
    }
    return ids;
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
      const editingIds = editingUserIds(pageId);
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
          isEditing: editingIds.has(entry.userId),
          joinedAt: entry.joinedAt,
        });
      }
      return out.sort((a, b) => a.joinedAt - b.joinedAt);
    },
    async markEditing(pageId, userId, socketId) {
      editingMap(pageId).set(editingField(userId, socketId), Date.now());
      emitChange(pageId);
    },
    async refreshEditing(pageId, userId, socketId) {
      // Keep-alive only — no broadcast (the editing set is unchanged).
      editingMap(pageId).set(editingField(userId, socketId), Date.now());
    },
    async unmarkEditing(pageId, userId, socketId) {
      editing.get(pageId)?.delete(editingField(userId, socketId));
      emitChange(pageId);
    },
    onViewersChanged(listener) {
      emitter.on('change', listener);
      return () => emitter.off('change', listener);
    },
    async publishPageUpdated(pageId, payload) {
      // Single-instance: emit directly to the local subscribers. No
      // Redis, so there is no cross-instance leg and no double-delivery.
      emitter.emit('page-updated', pageId, payload);
    },
    onPageUpdated(listener) {
      emitter.on('page-updated', listener);
      return () => emitter.off('page-updated', listener);
    },
    async publishCommentChanged(pageId, payload) {
      // Single-instance: emit directly to the local subscribers. No
      // Redis, so there is no cross-instance leg and no double-delivery.
      emitter.emit('comment-changed', pageId, payload);
    },
    onCommentChanged(listener) {
      emitter.on('comment-changed', listener);
      return () => emitter.off('comment-changed', listener);
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

  // SECOND subscriber, shared by the page-updated AND comment-changed
  // channels. node-redis v4 puts a connection into subscriber mode on
  // `subscribe` and it can then no longer issue regular commands — so
  // this needs its own `duplicate()` distinct from both the primary
  // (hash writes) and the viewer-list subscriber above. But a single
  // subscriber connection multiplexes any number of channels, so the
  // sibling comment-changed feed (feature-live-page-comment-sync) rides
  // this same `dup` as a second channel rather than opening a third
  // client — keeping the connection count at two subscribers. Its own
  // failure is likewise non-fatal: cross-instance page-updated /
  // comment-changed fan-out is lost for this process while local
  // delivery keeps working.
  let pageUpdatedSubscriber: PresenceRedisClient | null = null;
  try {
    const dup = redis.duplicate();
    await dup.connect();
    await dup.subscribe(PRESENCE_PAGE_UPDATED_CHANNEL, (message: string) => {
      try {
        const payload = JSON.parse(message) as PageUpdatedPayload;
        if (payload && typeof payload.pageId === 'string' && typeof payload.revisionId === 'string') {
          emitter.emit('page-updated', payload.pageId, payload);
        }
      } catch {
        // Corrupt frame — ignore (same fail-soft posture as the corrupt
        // viewer-hash field path).
        debug('dropping unparseable page-updated frame on %s', PRESENCE_PAGE_UPDATED_CHANNEL);
      }
    });
    // Second channel on the SAME subscriber — comment-changed fan-out.
    await dup.subscribe(PRESENCE_COMMENT_CHANGED_CHANNEL, (message: string) => {
      try {
        const payload = JSON.parse(message) as CommentChangedPayload;
        if (payload && typeof payload.pageId === 'string' && typeof payload.commentId === 'string') {
          emitter.emit('comment-changed', payload.pageId, payload);
        }
      } catch {
        // Corrupt frame — ignore (same fail-soft posture as page-updated).
        debug('dropping unparseable comment-changed frame on %s', PRESENCE_COMMENT_CHANGED_CHANNEL);
      }
    });
    pageUpdatedSubscriber = dup;
    debug('presence pub/sub subscriber connected on %s + %s', PRESENCE_PAGE_UPDATED_CHANNEL, PRESENCE_COMMENT_CHANGED_CHANNEL);
  } catch (err) {
    console.warn('[crowi:presence] page-updated / comment-changed subscriber setup failed — cross-instance fan-out disabled:', (err as Error).message);
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
   * presence-owned editing hash. Fields are `<userId>:<socketId>` with
   * a `lastSeenAt` value; a field older than `EDITING_TTL_MS` is stale
   * and swept from the hash as a side effect (same pattern as the
   * viewer-hash stale sweep). A user with multiple editor tabs appears
   * once in the resulting set.
   */
  const editingUserIds = async (pageId: string): Promise<Set<string>> => {
    try {
      const raw = await redis.hGetAll(editingHashKey(pageId));
      const ids = new Set<string>();
      const stale: string[] = [];
      const cutoff = Date.now() - EDITING_TTL_MS;
      for (const [field, value] of Object.entries(raw ?? {})) {
        const lastSeenAt = Number(value);
        if (!Number.isFinite(lastSeenAt) || lastSeenAt < cutoff) {
          stale.push(field);
          continue;
        }
        ids.add(editingFieldUserId(field));
      }
      if (stale.length > 0) {
        try {
          await redis.hDel(editingHashKey(pageId), stale);
        } catch (err) {
          debug('stale editing-field sweep failed for page %s: %s', pageId, (err as Error).message);
        }
      }
      return ids;
    } catch (err) {
      // Editing is advisory — a failed read just means no `✏️` badge.
      console.warn(`[crowi:presence] editing-hash read failed for page ${pageId}:`, (err as Error).message);
      return new Set();
    }
  };

  /**
   * Write (or refresh) an editing-hash field's `lastSeenAt` and re-apply
   * the key TTL. Shared by `markEditing` and `refreshEditing`; failures
   * are warn-only (editing is advisory — a failed write just means no
   * `✏️` badge).
   */
  const writeEditingField = async (pageId: string, userId: string, socketId: string): Promise<void> => {
    const key = editingHashKey(pageId);
    try {
      await redis.hSet(key, editingField(userId, socketId), String(Date.now()));
      await redis.expire(key, EDITING_HASH_TTL_SECONDS);
    } catch (err) {
      console.warn(`[crowi:presence] editing-hash write failed for page ${pageId}:`, (err as Error).message);
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

    async markEditing(pageId, userId, socketId) {
      // Record a fresh editing signal in the presence-owned editing
      // hash, then publish so the editor immediately gets an `✏️` badge.
      await writeEditingField(pageId, userId, socketId);
      debug('markEditing page=%s user=%s socket=%s — publishing viewer-list change', pageId, userId, socketId);
      await publishChange(pageId);
    },

    async refreshEditing(pageId, userId, socketId) {
      // Keep-alive for a live editor connection. NO publish: the editing
      // set is unchanged, so a refresh must not trigger a redundant
      // viewer-list broadcast.
      await writeEditingField(pageId, userId, socketId);
    },

    async unmarkEditing(pageId, userId, socketId) {
      try {
        await redis.hDel(editingHashKey(pageId), editingField(userId, socketId));
      } catch (err) {
        console.warn(`[crowi:presence] unmarkEditing delete failed for page ${pageId}:`, (err as Error).message);
      }
      debug('unmarkEditing page=%s user=%s socket=%s — publishing viewer-list change', pageId, userId, socketId);
      await publishChange(pageId);
    },

    onViewersChanged(listener) {
      emitter.on('change', listener);
      return () => emitter.off('change', listener);
    },

    async publishPageUpdated(pageId, payload) {
      // Two-step, mirroring `publishChange`: emit locally so *this*
      // instance's viewer sockets get the lowest-latency delivery, then
      // publish so the OTHER instances' page-updated subscribers pick it
      // up. Redis loops the publish back to this instance's own
      // subscriber too, so `broadcastPageUpdated` runs twice on the
      // origin and its local viewers receive the same frame twice —
      // harmless because the client coalesces via debounce + a
      // `revision.createdAt` monotonicity guard (see
      // feature-live-page-content-sync spec §"double-send"). Kept
      // symmetric with the viewer-list path rather than optimised to a
      // single leg.
      emitter.emit('page-updated', pageId, payload);
      try {
        await redis.publish(PRESENCE_PAGE_UPDATED_CHANNEL, JSON.stringify(payload));
      } catch (err) {
        console.warn(`[crowi:presence] page-updated publish failed for page ${pageId}:`, (err as Error).message);
      }
    },

    onPageUpdated(listener) {
      emitter.on('page-updated', listener);
      return () => emitter.off('page-updated', listener);
    },

    async publishCommentChanged(pageId, payload) {
      // Two-step, mirroring `publishPageUpdated`: emit locally so *this*
      // instance's viewer sockets get the lowest-latency delivery, then
      // publish so the OTHER instances' comment-changed subscribers pick
      // it up. Redis loops the publish back to this instance's own
      // subscriber too, so `broadcastCommentChanged` runs twice on the
      // origin and its local viewers receive the same frame twice —
      // harmless because the client coalesces via an idempotent
      // invalidate → re-fetch and a seen-set diff for the new-comment
      // highlight (see feature-live-page-comment-sync spec §"double
      // delivery"). Kept symmetric with the page-updated path.
      emitter.emit('comment-changed', pageId, payload);
      try {
        await redis.publish(PRESENCE_COMMENT_CHANGED_CHANNEL, JSON.stringify(payload));
      } catch (err) {
        console.warn(`[crowi:presence] comment-changed publish failed for page ${pageId}:`, (err as Error).message);
      }
    },

    onCommentChanged(listener) {
      emitter.on('comment-changed', listener);
      return () => emitter.off('comment-changed', listener);
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
      if (pageUpdatedSubscriber) {
        try {
          await pageUpdatedSubscriber.disconnect();
        } catch (err) {
          debug('page-updated subscriber disconnect failed: %s', (err as Error).message);
        }
        pageUpdatedSubscriber = null;
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
 * api hands it this adapter via `createCollabServer`'s `presence`
 * option. Each call resolves the process-shared presence service
 * lazily and forwards; errors are swallowed because presence is
 * advisory and must never block a collab connection.
 *
 * The adapter also owns a periodic *refresher*: it tracks every live
 * editor connection of *this* process in an in-process Map and, on a
 * `setInterval`, calls `service.refreshEditing` for each so the Redis
 * editing hash field never ages past `EDITING_TTL_MS` while the editor
 * is connected. This is the self-heal mechanism — when the process
 * dies the Map and interval die with it, nothing refreshes the editing
 * hash, and every field ages out within `EDITING_TTL_MS` so the `✏️`
 * badge disappears on plain viewers. A clean disconnect removes the
 * field immediately via `unmarkEditing`. In a multi-instance
 * deployment each instance refreshes only its own connections, so the
 * scheme stays correct under load balancing.
 */
export interface PresenceCollabDeps {
  markEditing(pageId: string, userId: string, socketId: string): Promise<void>;
  unmarkEditing(pageId: string, userId: string, socketId: string): Promise<void>;
  /**
   * Stop the periodic editing-hash refresher. Called from the collab
   * `shutdown()` so a graceful api teardown does not leak a timer.
   */
  shutdown(): void;
}

export function createPresenceCollabDeps(crowi: Crowi): PresenceCollabDeps {
  // socketId → { pageId, userId } for every live editor connection
  // this process owns. Drives the periodic refresher below.
  const liveEditors = new Map<string, { pageId: string; userId: string }>();
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  // Lazily start the refresher on the first `markEditing`. `.unref()`
  // so the timer never keeps the process alive on its own.
  const ensureRefresher = (): void => {
    if (refreshTimer !== null) return;
    refreshTimer = setInterval(() => {
      void (async () => {
        let service: PresenceService;
        try {
          service = await getPresenceService(crowi);
        } catch {
          // Service not resolvable right now — skip this tick.
          return;
        }
        // Snapshot the entries: a concurrent `unmarkEditing` may mutate
        // `liveEditors` while the refresh awaits are in flight.
        const entries = Array.from(liveEditors.entries());
        await Promise.all(
          entries.map(([socketId, { pageId, userId }]) =>
            service.refreshEditing(pageId, userId, socketId).catch((err: unknown) => {
              debug('refreshEditing tick failed for socket %s: %s', socketId, (err as Error).message);
            }),
          ),
        );
      })();
    }, EDITING_REFRESH_MS);
    refreshTimer.unref();
  };

  return {
    async markEditing(pageId, userId, socketId) {
      liveEditors.set(socketId, { pageId, userId });
      ensureRefresher();
      try {
        const service = await getPresenceService(crowi);
        await service.markEditing(pageId, userId, socketId);
      } catch (err) {
        console.warn('[crowi:presence] collab markEditing wiring failed (non-blocking):', (err as Error).message);
      }
    },
    async unmarkEditing(pageId, userId, socketId) {
      liveEditors.delete(socketId);
      try {
        const service = await getPresenceService(crowi);
        await service.unmarkEditing(pageId, userId, socketId);
      } catch (err) {
        console.warn('[crowi:presence] collab unmarkEditing wiring failed (non-blocking):', (err as Error).message);
      }
    },
    shutdown() {
      if (refreshTimer !== null) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
      liveEditors.clear();
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

export {
  EDITING_HASH_PREFIX,
  EDITING_REFRESH_MS,
  EDITING_TTL_MS,
  PRESENCE_COMMENT_CHANGED_CHANNEL,
  PRESENCE_PAGE_UPDATED_CHANNEL,
  PRESENCE_UPDATES_CHANNEL,
  VIEWER_HASH_PREFIX,
  VIEWER_TTL_MS,
};
