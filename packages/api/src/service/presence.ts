import { EventEmitter } from 'node:events';
import type { PresenceCommentChangedMessage, PresenceViewer } from '@crowi/api-contract';
import Debug from 'debug';
import type Crowi from 'src/crowi';
import type { PresenceFeed } from 'src/presence/attach';
import { resolveRedisKeyspace, type RedisKeyspace } from 'src/util/redis-keyspace';
import { duplicateWithErrorHandler } from 'src/util/redis-opts';

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
 * Wire-level design (keys/channel shown instance-scoped,
 * `crowi:<instance-slug>:...` — feature-redis-key-prefix §1/§2. A
 * {@link RedisKeyspace} is a MANDATORY argument on the Redis-backed path
 * (`createPresenceService`'s overload requires it whenever a Redis client
 * is supplied) — there is no legacy non-scoped fallback left to reach,
 * closing the "literal `crowi:` fallback still compiled into a production
 * module" gap the feature-redis-key-prefix Phase 1 review round 3 flagged):
 *
 *   - Viewer hash: `crowi:<instance-slug>:presence:viewers:<pageId>` — a
 *     Redis hash, one field per live *connection* (`<userId>:<connectionId>`,
 *     the same composite-field shape as the editing hash below), value a
 *     JSON blob with the viewer's denormalised identity + `joinedAt` +
 *     `lastHeartbeatAt`. Multiple fields can share a `userId` (multi-tab,
 *     and — the point of this shape — multiple REPLICAS each holding one of
 *     that user's tabs): `listViewers` groups fields by `userId` and emits
 *     one `PresenceViewer` per user as long as at least one of their
 *     connections is live, with `joinedAt` taken as the MINIMUM across the
 *     group (the earliest tab's join time), so opening/closing extra tabs
 *     never reshuffles the user's position in the ordered list. Before this
 *     shape the hash had one field per `userId` and `leave` unconditionally
 *     deleted it — closing ONE of a user's tabs made them vanish from every
 *     replica's viewer list even while a sibling tab on ANOTHER replica was
 *     still connected (feature-presence-consistency-fixes defect 1); a
 *     per-connection field makes `leave` naturally correct: it removes only
 *     the closing connection's own field, and the user disappears only once
 *     every field sharing their `userId` is gone.
 *   - TTL: the hash carries a *key-level* `EXPIRE` (re-applied on every
 *     write) so an idle page's hash evaporates. Per-*field* TTL would
 *     need `HEXPIRE` (Redis 7.4 / node-redis v5) which this codebase's
 *     node-redis v4.7 does not expose — instead each field stores
 *     `lastHeartbeatAt` and `listViewers` filters out entries whose
 *     last heartbeat is older than `VIEWER_TTL_MS`, sweeping the stale
 *     fields from the hash as a side effect.
 *   - Pub/sub (feature-presence-generic-feed-bus): every read-side feed
 *     (viewer-list / page-updated / comment-changed) rides ONE Redis
 *     channel, `crowi:<instance-slug>:presence:feed`, as a JSON envelope
 *     `{ feed, pageId, payload }`. When a viewer joins / leaves on api
 *     instance A, A publishes the envelope; every instance sharing the same
 *     instance slug (including A itself) re-broadcasts the fresh viewer
 *     list to its locally-connected clients — a DIFFERENT instance slug
 *     never sees the publish at all, even on the same Redis. Same
 *     Redis-as-shared-state pattern as RFC-0003.
 *   - `isEditing`: NOT stored in the viewer hash. It is derived at
 *     `listViewers` time from a dedicated, short-lived *editing hash*
 *     `crowi:<instance-slug>:presence:editing:<pageId>` — one field per
 *     editor connection (`<userId>:<socketId>`), value `lastSeenAt`
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

/**
 * Redis pub/sub channel every `PresenceFeed` rides
 * (feature-presence-generic-feed-bus), scoped to the caller's
 * {@link RedisKeyspace} — see {@link presenceFeedChannel}. Carries a JSON
 * envelope `{ feed, pageId, payload }`; ONE dedicated subscriber connection
 * multiplexes every feed (viewer-list, page-updated, comment-changed —
 * and any future feed), replacing the pre-consolidation split between a
 * bare-pageId-string channel (viewer-list) and a JSON channel
 * (page-updated / comment-changed).
 */

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

/**
 * Per-page viewer hash key, instance-scoped (`crowi:<slug>:presence:
 * viewers:<pageId>`). `keyspace` is mandatory — the Redis-backed
 * implementation (`createRedisPresenceService`) only ever runs once a
 * real Redis client is present, at which point a {@link RedisKeyspace} is
 * always resolvable (feature-redis-key-prefix §1's env validation
 * guarantees this at boot), so there is no legitimate caller that needs a
 * legacy non-scoped literal.
 */
const viewerHashKey = (pageId: string, keyspace: RedisKeyspace): string => keyspace.key('presence', 'viewers', pageId);
/** Per-page editing hash key — see {@link viewerHashKey}. */
const editingHashKey = (pageId: string, keyspace: RedisKeyspace): string => keyspace.key('presence', 'editing', pageId);
/** The `PresenceFeed` pub/sub channel — see {@link viewerHashKey}. */
const presenceFeedChannel = (keyspace: RedisKeyspace): string => keyspace.key('presence', 'feed');
/**
 * Build a composite `<userId>:<connectionId>` Redis hash field — the shape
 * shared by both the editing hash (one field per live editor connection)
 * and, since feature-presence-consistency-fixes defect 1, the viewer hash
 * (one field per live viewer connection, refcounting a user's tabs/replicas
 * instead of a single field a `leave` from any one of them could delete
 * out from under the others).
 */
const compositeField = (userId: string, connectionId: string): string => `${userId}:${connectionId}`;
/** Inverse of `compositeField` — the `userId` portion of a `<userId>:<connectionId>` field. */
const compositeFieldUserId = (field: string): string => {
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
 * The set of read-side realtime feeds presence multiplexes
 * (feature-presence-generic-feed-bus). DERIVED, not hand-declared: the
 * canonical definition is `keyof ReturnType<typeof createFeedHandlers>`
 * in `presence/attach.ts` (that file's per-feed dispatch table is the
 * single place every feed name is enumerated) — re-exported here so
 * external consumers (e.g. `presence.test.ts`) keep importing it from
 * this file, alongside this file's own `subscribe`/`publish` signatures.
 * Adding a fourth feed therefore touches exactly two places: (1) a
 * `publish(feed, ...)` call at the write site (this file), and (2) one
 * new entry in `createFeedHandlers`'s returned object
 * (`presence/attach.ts`) — which automatically extends this type, so
 * there is no separate union-type edit, no new Redis channel, no new
 * EventEmitter event name, and no new `PresenceService` method pair
 * required.
 */
export type { PresenceFeed };

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
  /**
   * `error` / `ready` listener registration — the surface
   * `duplicateWithErrorHandler` (`src/util/redis-opts.ts`) needs on a
   * duplicated subscriber so a Redis outage after `connect()` succeeds
   * cannot raise an unhandled EventEmitter `error` and crash the process.
   */
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'ready', listener: () => void): unknown;
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
   * Register (or refresh) one viewer CONNECTION for a page. Idempotent
   * per `(userId, connectionId)` pair. `connectionId` (feature-presence-
   * consistency-fixes defect 1) identifies one WebSocket connection —
   * one browser tab, on one replica — distinctly from every other
   * connection the same `userId` may hold concurrently (other tabs,
   * other replicas): `listViewers` groups by `userId` and reports the
   * user as present as long as ANY of their connections is live, so
   * closing one tab never affects a sibling. Publishes a viewer-list
   * change so every instance re-broadcasts.
   */
  join(pageId: string, viewer: ViewerIdentity, connectionId: string): Promise<void>;
  /**
   * Refresh one connection's `lastHeartbeatAt` (and the hash key TTL).
   * Called on every client heartbeat. Returns `false` when the
   * connection was not present (e.g. swept while the socket was
   * briefly idle) so the handler can re-`join`.
   */
  heartbeat(pageId: string, userId: string, connectionId: string): Promise<boolean>;
  /**
   * Remove one viewer CONNECTION from a page. Idempotent. Publishes a
   * viewer-list change. The handler calls this on WebSocket close —
   * unconditionally, for every close, since `connectionId` scoping
   * means removing THIS connection can never affect a sibling
   * connection's field (feature-presence-consistency-fixes defect 1;
   * the caller no longer needs to first check whether the user has
   * another live connection before deciding to call this).
   */
  leave(pageId: string, userId: string, connectionId: string): Promise<void>;
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
   * Broadcast that a new revision was saved for `pageId`
   * (feature-live-page-content-sync). Fans out to every connected
   * viewer socket (local + cross-instance) so the read-side
   * soft-refresh can swap the body in place. Delegates to the generic
   * `publish('page-updated', ...)` — the viewer-list feed is untouched.
   */
  publishPageUpdated(pageId: string, payload: PageUpdatedPayload): Promise<void>;
  /**
   * Broadcast that a comment was added to / removed from `pageId`
   * (feature-live-page-comment-sync). Fans out to every connected viewer
   * socket (local + cross-instance) so the reader's comment list can
   * append / drop the entry in place. Delegates to the generic
   * `publish('comment-changed', ...)` — the viewer-list and page-updated
   * feeds are untouched.
   */
  publishCommentChanged(pageId: string, payload: CommentChangedPayload): Promise<void>;
  /**
   * Generic feed bus (feature-presence-generic-feed-bus) — subscribe to
   * one `PresenceFeed`. `payload` is `undefined` for the `'viewers'`
   * feed (callers re-read via `listViewers` instead); it carries the
   * feed's full payload for `'page-updated'` / `'comment-changed'`.
   * `presence/attach.ts` is the sole caller — every feed's socket
   * fan-out is registered through this one method. Returns an
   * unsubscribe fn.
   */
  subscribe(feed: PresenceFeed, listener: (pageId: string, payload: unknown) => void): () => void;
  /**
   * Generic feed bus (feature-presence-generic-feed-bus) — publish a
   * message on one `PresenceFeed`. Every named `publishXxx` method
   * above delegates to this. `payload` is omitted for the `'viewers'`
   * feed.
   */
  publish(feed: PresenceFeed, pageId: string, payload?: unknown): Promise<void>;
  /** Tear down the dedicated pub/sub subscriber client(s). */
  shutdown(): Promise<void>;
}

/**
 * The generic `subscribe` implementation (feature-presence-generic-feed-bus)
 * — identical wiring in both the in-process and the Redis implementation,
 * since both share the same feed-bus contract over their own `emitter`.
 * Each `PresenceFeed` rides its OWN EventEmitter event name (the feed name
 * itself), so `emitFeed` below only invokes that feed's listeners — no
 * app-level filtering needed on top of what `EventEmitter` already does.
 */
const createFeedSubscribers = (emitter: EventEmitter): Pick<PresenceService, 'subscribe'> => ({
  subscribe(feed, listener) {
    emitter.on(feed, listener);
    return () => emitter.off(feed, listener);
  },
});

/**
 * Emit a feed message on the shared bus. The primitive every named
 * `publishXxx` method (and the generic `publish`) builds on.
 */
const emitFeed = (emitter: EventEmitter, feed: PresenceFeed, pageId: string, payload?: unknown): void => {
  emitter.emit(feed, pageId, payload);
};

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
 *
 * `keyspace` (feature-redis-key-prefix §1/§2) scopes every Redis key/
 * channel this service touches to `crowi:<instance-slug>:presence:...` so
 * multiple Crowi instances sharing one Redis do not cross-talk on viewer
 * lists / editing badges / the feed channel. Mandatory whenever `redis` is
 * non-null (see the overload signatures) — `getPresenceService` (the real
 * production entry point) always resolves and passes one; there is no
 * legacy non-scoped fallback to omit it in favour of.
 */
export async function createPresenceService(redis: null): Promise<PresenceService>;
export async function createPresenceService(redis: PresenceRedisClient, keyspace: RedisKeyspace): Promise<PresenceService>;
export async function createPresenceService(redis: PresenceRedisClient | null, keyspace?: RedisKeyspace): Promise<PresenceService> {
  // Local EventEmitter every PresenceFeed message rides on (one event
  // name per feed — see createFeedSubscribers/emitFeed above). In Redis
  // mode it is fed by the pub/sub subscriber + local publishes;
  // in single-instance mode it is emitted directly.
  const emitter = new EventEmitter();
  // EventEmitter's default 10-listener cap warns once per page with
  // many connected sockets; presence legitimately has one listener per
  // connected socket, so lift the cap.
  emitter.setMaxListeners(0);

  if (redis === null) {
    return createInProcessPresenceService(emitter);
  }
  // The overload above guarantees `keyspace` is supplied whenever `redis`
  // is non-null — this non-null assertion reflects that invariant, not a
  // guess.
  return createRedisPresenceService(redis, emitter, keyspace!);
}

/**
 * Single-instance (no Redis) implementation. Viewer state lives in a
 * process-local Map, keyed `pageId` → `userId` → `connectionId` →
 * `StoredViewer` — mirroring the Redis viewer hash's per-connection
 * field shape (feature-presence-consistency-fixes defect 1) so a
 * single process with several tabs open for the same user behaves
 * identically to the multi-replica Redis path: `leave` drops only the
 * closing connection, and the user disappears from `listViewers` only
 * once every one of their connections is gone. The editing signal is
 * tracked in a parallel process-local Map (`editing`), keyed `<pageId>`
 * → `<userId>:<socketId>` → `lastSeenAt`, mirroring the Redis editing
 * hash. `isEditing` is therefore accurate in single-instance dev too.
 */
function createInProcessPresenceService(emitter: EventEmitter): PresenceService {
  const pages = new Map<string, Map<string, Map<string, StoredViewer>>>();
  // pageId → (`<userId>:<socketId>` → lastSeenAt). Mirrors the Redis
  // editing hash for the no-Redis dev path.
  const editing = new Map<string, Map<string, number>>();

  const pageConnections = (pageId: string): Map<string, Map<string, StoredViewer>> => {
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
      ids.add(compositeFieldUserId(field));
    }
    return ids;
  };

  return {
    async join(pageId, viewer, connectionId) {
      const now = Date.now();
      const connections = pageConnections(pageId);
      let byConnection = connections.get(viewer.userId);
      if (!byConnection) {
        byConnection = new Map();
        connections.set(viewer.userId, byConnection);
      }
      const existing = byConnection.get(connectionId);
      byConnection.set(connectionId, {
        userId: viewer.userId,
        username: viewer.username,
        displayName: viewer.displayName,
        avatarUrl: viewer.avatarUrl,
        joinedAt: existing?.joinedAt ?? now,
        lastHeartbeatAt: now,
      });
      emitFeed(emitter, 'viewers', pageId);
    },
    async heartbeat(pageId, userId, connectionId) {
      const entry = pages.get(pageId)?.get(userId)?.get(connectionId);
      if (!entry) return false;
      entry.lastHeartbeatAt = Date.now();
      return true;
    },
    async leave(pageId, userId, connectionId) {
      const byConnection = pages.get(pageId)?.get(userId);
      if (!byConnection?.delete(connectionId)) return;
      if (byConnection.size === 0) {
        pages.get(pageId)?.delete(userId);
      }
      emitFeed(emitter, 'viewers', pageId);
    },
    async listViewers(pageId) {
      const connections = pages.get(pageId);
      if (!connections) return [];
      const cutoff = Date.now() - VIEWER_TTL_MS;
      const editingIds = editingUserIds(pageId);
      const out: PresenceViewer[] = [];
      for (const [userId, byConnection] of connections) {
        let canonical: StoredViewer | null = null;
        for (const [connectionId, entry] of byConnection) {
          if (entry.lastHeartbeatAt < cutoff) {
            byConnection.delete(connectionId);
            continue;
          }
          if (canonical === null || entry.joinedAt < canonical.joinedAt) canonical = entry;
        }
        if (byConnection.size === 0) {
          connections.delete(userId);
          continue;
        }
        if (canonical === null) continue;
        out.push({
          userId,
          username: canonical.username,
          displayName: canonical.displayName,
          avatarUrl: canonical.avatarUrl,
          isEditing: editingIds.has(userId),
          joinedAt: canonical.joinedAt,
        });
      }
      return out.sort((a, b) => a.joinedAt - b.joinedAt);
    },
    async markEditing(pageId, userId, socketId) {
      editingMap(pageId).set(compositeField(userId, socketId), Date.now());
      emitFeed(emitter, 'viewers', pageId);
    },
    async refreshEditing(pageId, userId, socketId) {
      // Keep-alive only — no broadcast (the editing set is unchanged).
      editingMap(pageId).set(compositeField(userId, socketId), Date.now());
    },
    async unmarkEditing(pageId, userId, socketId) {
      editing.get(pageId)?.delete(compositeField(userId, socketId));
      emitFeed(emitter, 'viewers', pageId);
    },
    async publishPageUpdated(pageId, payload) {
      // Single-instance: emit directly to the local subscribers. No
      // Redis, so there is no cross-instance leg and no double-delivery.
      emitFeed(emitter, 'page-updated', pageId, payload);
    },
    async publishCommentChanged(pageId, payload) {
      // Single-instance: emit directly to the local subscribers. No
      // Redis, so there is no cross-instance leg and no double-delivery.
      emitFeed(emitter, 'comment-changed', pageId, payload);
    },
    ...createFeedSubscribers(emitter),
    async publish(feed, pageId, payload) {
      emitFeed(emitter, feed, pageId, payload);
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
 * client. Every `PresenceFeed` rides this ONE subscriber
 * (feature-presence-generic-feed-bus consolidated the pre-existing
 * viewer-list subscriber + the page-updated/comment-changed subscriber
 * into a single connection subscribing a single channel).
 */
/** Wire shape published on the {@link presenceFeedChannel} (feature-presence-generic-feed-bus). */
type FeedEnvelope = { feed: PresenceFeed; pageId: string; payload?: unknown };

/**
 * Runtime whitelist of valid `PresenceFeed` values. `PresenceFeed` itself
 * is a compile-time-only union derived in `presence/attach.ts` (`keyof
 * ReturnType<typeof createFeedHandlers>`), so it disappears at runtime —
 * an inbound Redis envelope's `feed` field is untrusted wire data and
 * needs an explicit runtime check before it is used as an EventEmitter
 * event name. Without this, a malformed/malicious envelope naming a
 * Node.js special event (e.g. `"error"`) would reach `emitFeed` and throw
 * on `emitter.emit('error', ...)` when no listener is registered for it.
 * Keep in sync with `createFeedHandlers`'s keys in `presence/attach.ts`.
 */
const KNOWN_PRESENCE_FEEDS: ReadonlySet<string> = new Set<PresenceFeed>(['viewers', 'page-updated', 'comment-changed']);

async function createRedisPresenceService(redis: PresenceRedisClient, emitter: EventEmitter, keyspace: RedisKeyspace): Promise<PresenceService> {
  const feedChannel = presenceFeedChannel(keyspace);
  let subscriber: PresenceRedisClient | null = null;
  try {
    const dup = duplicateWithErrorHandler(redis, 'presence pub/sub subscriber');
    await dup.connect();
    subscriber = dup;
    await dup.subscribe(feedChannel, (message: string) => {
      let envelope: FeedEnvelope | null = null;
      try {
        const parsed = JSON.parse(message) as Partial<FeedEnvelope> | null;
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          typeof parsed.feed === 'string' &&
          KNOWN_PRESENCE_FEEDS.has(parsed.feed) &&
          typeof parsed.pageId === 'string'
        ) {
          envelope = parsed as FeedEnvelope;
        }
      } catch {
        // Not JSON — drop below.
      }
      if (!envelope) {
        // The presence feed channel is a brand-new channel name
        // (feature-presence-generic-feed-bus) the pre-consolidation code
        // never published to, and Q3's default is a single-release
        // cutover with no rolling-deploy grace period — so there is no
        // "old process still on the legacy wire format" scenario to be
        // compatible with here (an old process publishes bare pageIds
        // on the OLD, now-unsubscribed channel, not this one). A
        // non-envelope message on THIS channel can only be corrupt /
        // unexpected data; drop it rather than guessing a feed for it.
        debug('dropping unparseable presence feed message: %s', message);
        return;
      }
      emitFeed(emitter, envelope.feed, envelope.pageId, envelope.payload);
    });
    debug('presence pub/sub subscriber connected on %s', feedChannel);
  } catch (err) {
    // A subscriber failure degrades presence to single-instance
    // behaviour for *this* process — local clients still work, but
    // cross-instance fan-out is lost. Never fatal.
    console.warn('[crowi:presence] pub/sub subscriber setup failed — cross-instance fan-out disabled:', (err as Error).message);
  }

  /**
   * Publish a message on `feed` — the generic bus primitive every
   * `publishXxx` method (and the public `publish`) delegates to. Emits
   * locally first so the publishing instance's own listeners get the
   * lowest-latency delivery, then publishes to Redis so the OTHER
   * instances' subscriber picks it up. Redis loops the publish back to
   * this instance's own subscriber too, so a local listener sees the
   * message TWICE on the origin instance — harmless: the viewer-list
   * re-broadcast sends an identical list, and page-updated /
   * comment-changed are deduped client-side (debounce + a
   * `revision.createdAt` monotonicity guard / idempotent re-fetch — see
   * feature-live-page-content-sync / feature-live-page-comment-sync
   * specs §"double-send"). Kept symmetric across every feed rather than
   * optimised to a single leg.
   */
  const publish = async (feed: PresenceFeed, pageId: string, payload?: unknown): Promise<void> => {
    emitFeed(emitter, feed, pageId, payload);
    try {
      await redis.publish(feedChannel, JSON.stringify({ feed, pageId, payload }));
    } catch (err) {
      console.warn(`[crowi:presence] publish failed for feed=${feed} page=${pageId}:`, (err as Error).message);
    }
  };

  /**
   * Read + parse the viewer hash, dropping fields that fail to parse.
   * Keyed by the raw `<userId>:<connectionId>` FIELD (feature-presence-
   * consistency-fixes defect 1) — one entry per live connection, not
   * per user; `listViewers` groups these by `compositeFieldUserId`.
   */
  const readHash = async (pageId: string): Promise<Map<string, StoredViewer>> => {
    const raw = await redis.hGetAll(viewerHashKey(pageId, keyspace));
    const out = new Map<string, StoredViewer>();
    for (const [field, json] of Object.entries(raw ?? {})) {
      try {
        const parsed = JSON.parse(json) as StoredViewer;
        if (parsed && typeof parsed.lastHeartbeatAt === 'number') {
          out.set(field, parsed);
        }
      } catch {
        // Corrupt field — ignore; it expires with the hash TTL.
        debug('dropping unparseable viewer field=%s page=%s', field, pageId);
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
      const raw = await redis.hGetAll(editingHashKey(pageId, keyspace));
      const ids = new Set<string>();
      const stale: string[] = [];
      const cutoff = Date.now() - EDITING_TTL_MS;
      for (const [field, value] of Object.entries(raw ?? {})) {
        const lastSeenAt = Number(value);
        if (!Number.isFinite(lastSeenAt) || lastSeenAt < cutoff) {
          stale.push(field);
          continue;
        }
        ids.add(compositeFieldUserId(field));
      }
      if (stale.length > 0) {
        try {
          await redis.hDel(editingHashKey(pageId, keyspace), stale);
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
    const key = editingHashKey(pageId, keyspace);
    try {
      await redis.hSet(key, compositeField(userId, socketId), String(Date.now()));
      await redis.expire(key, EDITING_HASH_TTL_SECONDS);
    } catch (err) {
      console.warn(`[crowi:presence] editing-hash write failed for page ${pageId}:`, (err as Error).message);
    }
  };

  return {
    async join(pageId, viewer, connectionId) {
      const key = viewerHashKey(pageId, keyspace);
      const field = compositeField(viewer.userId, connectionId);
      const now = Date.now();
      // Preserve this CONNECTION's original joinedAt across re-joins
      // (e.g. the heartbeat-triggered re-join below) so its ordering
      // contribution stays stable; a genuinely NEW connection (a new
      // tab) gets its own fresh `joinedAt` — `listViewers` takes the
      // MINIMUM across a user's connections, so the user's rendered
      // position is governed by their earliest tab regardless.
      let joinedAt = now;
      try {
        const existingRaw = await redis.hGet(key, field);
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
      await redis.hSet(key, field, JSON.stringify(stored));
      await redis.expire(key, VIEWER_HASH_TTL_SECONDS);
      await publish('viewers', pageId);
    },

    async heartbeat(pageId, userId, connectionId) {
      const key = viewerHashKey(pageId, keyspace);
      const field = compositeField(userId, connectionId);
      const existingRaw = await redis.hGet(key, field);
      if (!existingRaw) return false;
      let existing: StoredViewer;
      try {
        existing = JSON.parse(existingRaw) as StoredViewer;
      } catch {
        return false;
      }
      existing.lastHeartbeatAt = Date.now();
      await redis.hSet(key, field, JSON.stringify(existing));
      await redis.expire(key, VIEWER_HASH_TTL_SECONDS);
      // A heartbeat doesn't change *who* is here, so no broadcast — it
      // only refreshes the TTL.
      return true;
    },

    async leave(pageId, userId, connectionId) {
      // Removes only THIS connection's field — a sibling connection for
      // the same userId (another tab, or the same tab on another
      // replica sharing this Redis) is untouched (feature-presence-
      // consistency-fixes defect 1).
      const removed = await redis.hDel(viewerHashKey(pageId, keyspace), compositeField(userId, connectionId));
      if (removed > 0) {
        await publish('viewers', pageId);
      }
    },

    async listViewers(pageId) {
      const [hash, editing] = await Promise.all([readHash(pageId), editingUserIds(pageId)]);
      const cutoff = Date.now() - VIEWER_TTL_MS;
      const stale: string[] = [];
      // Group live connection fields by userId — one PresenceViewer per
      // user, present as long as ANY of their connections is fresh
      // (feature-presence-consistency-fixes defect 1).
      const byUser = new Map<string, StoredViewer[]>();
      for (const [field, entry] of hash) {
        if (entry.lastHeartbeatAt < cutoff) {
          stale.push(field);
          continue;
        }
        const userId = compositeFieldUserId(field);
        const group = byUser.get(userId);
        if (group) {
          group.push(entry);
        } else {
          byUser.set(userId, [entry]);
        }
      }
      const out: PresenceViewer[] = [];
      for (const [userId, entries] of byUser) {
        // The MINIMUM joinedAt across the group is the user's earliest
        // tab — keeps ordering stable regardless of which connection
        // opened/closed most recently.
        const canonical = entries.reduce((min, e) => (e.joinedAt < min.joinedAt ? e : min));
        out.push({
          userId,
          username: canonical.username,
          displayName: canonical.displayName,
          avatarUrl: canonical.avatarUrl,
          isEditing: editing.has(userId),
          joinedAt: canonical.joinedAt,
        });
      }
      // Sweep stale fields so an abandoned page eventually empties its
      // hash even with HEXPIRE unavailable.
      if (stale.length > 0) {
        try {
          await redis.hDel(viewerHashKey(pageId, keyspace), stale);
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
      await publish('viewers', pageId);
    },

    async refreshEditing(pageId, userId, socketId) {
      // Keep-alive for a live editor connection. NO publish: the editing
      // set is unchanged, so a refresh must not trigger a redundant
      // viewer-list broadcast.
      await writeEditingField(pageId, userId, socketId);
    },

    async unmarkEditing(pageId, userId, socketId) {
      try {
        await redis.hDel(editingHashKey(pageId, keyspace), compositeField(userId, socketId));
      } catch (err) {
        console.warn(`[crowi:presence] unmarkEditing delete failed for page ${pageId}:`, (err as Error).message);
      }
      debug('unmarkEditing page=%s user=%s socket=%s — publishing viewer-list change', pageId, userId, socketId);
      await publish('viewers', pageId);
    },

    async publishPageUpdated(pageId, payload) {
      await publish('page-updated', pageId, payload);
    },

    async publishCommentChanged(pageId, payload) {
      await publish('comment-changed', pageId, payload);
    },

    ...createFeedSubscribers(emitter),

    publish,

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
  // `createPresenceService`'s overloads require a `RedisKeyspace` whenever
  // `redis` is non-null — narrowing `redis` here (rather than passing
  // `resolveRedisKeyspaceIfEnabled(crowi)` alongside a possibly-null
  // `redis`) is what lets the overload actually enforce that at the
  // call site instead of via a runtime assertion.
  cachedService = redis === null ? createPresenceService(null) : createPresenceService(redis, resolveRedisKeyspace(crowi));
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

export { EDITING_REFRESH_MS, EDITING_TTL_MS, VIEWER_TTL_MS };
