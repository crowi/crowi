import { EventEmitter } from 'node:events';
import type { PresenceCommentChangedMessage, PresenceViewer } from '@crowi/api-contract';
import Debug from 'debug';
import type Crowi from 'src/crowi';
import type { PresenceFeed } from 'src/presence/attach';

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
 *   - Pub/sub (feature-presence-generic-feed-bus): every read-side feed
 *     (viewer-list / page-updated / comment-changed) rides ONE Redis
 *     channel, `PRESENCE_FEED_CHANNEL`, as a JSON envelope
 *     `{ feed, pageId, payload }`. When a viewer joins / leaves on api
 *     instance A, A publishes the envelope; every instance (including
 *     A) re-broadcasts the fresh viewer list to its locally-connected
 *     clients. Same Redis-as-shared-state pattern as RFC-0003.
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
/**
 * Redis pub/sub channel every `PresenceFeed` rides
 * (feature-presence-generic-feed-bus). Carries a JSON envelope
 * `{ feed, pageId, payload }`; ONE dedicated subscriber connection
 * multiplexes every feed (viewer-list, page-updated, comment-changed —
 * and any future feed), replacing the pre-consolidation split between a
 * bare-pageId-string channel (viewer-list) and a JSON channel
 * (page-updated / comment-changed).
 */
const PRESENCE_FEED_CHANNEL = 'crowi:presence:feed';
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
   * soft-refresh can swap the body in place. Delegates to the generic
   * `publish('page-updated', ...)` — the viewer-list feed is untouched.
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
   * append / drop the entry in place. Delegates to the generic
   * `publish('comment-changed', ...)` — the viewer-list and page-updated
   * feeds are untouched.
   */
  publishCommentChanged(pageId: string, payload: CommentChangedPayload): Promise<void>;
  /**
   * Subscribe to comment-changed signals. The listener is invoked with
   * the `pageId` + full `CommentChangedPayload` whenever a comment was
   * added / removed on a page (local or cross-instance). Returns an
   * unsubscribe fn.
   */
  onCommentChanged(listener: (pageId: string, payload: CommentChangedPayload) => void): () => void;
  /**
   * Generic feed bus (feature-presence-generic-feed-bus) — subscribe to
   * one `PresenceFeed`. `payload` is `undefined` for the `'viewers'`
   * feed (callers re-read via `listViewers` instead); it carries the
   * feed's full payload for `'page-updated'` / `'comment-changed'`.
   * Every named `onXxx` method above is a thin, feed-filtered wrapper
   * over this. Returns an unsubscribe fn.
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
 * Internal EventEmitter event name every `PresenceFeed` message rides
 * (feature-presence-generic-feed-bus). Both the in-process and the
 * Redis implementation emit every feed — viewer-list, page-updated,
 * comment-changed — on this ONE event name, `(feed, pageId, payload)`;
 * `subscribeFeed` / `emitFeed` below are the generic bus primitive every
 * named method and the public `subscribe`/`publish` build on.
 */
const FEED_EVENT = 'feed';

/**
 * Register a `feed`-filtered listener on the shared feed bus. The
 * primitive every named `onXxx` method (and the generic `subscribe`)
 * wraps.
 */
const subscribeFeed = (emitter: EventEmitter, feed: PresenceFeed, listener: (pageId: string, payload: unknown) => void): (() => void) => {
  const handler = (eventFeed: PresenceFeed, pageId: string, payload: unknown): void => {
    if (eventFeed === feed) listener(pageId, payload);
  };
  emitter.on(FEED_EVENT, handler);
  return () => emitter.off(FEED_EVENT, handler);
};

/**
 * Emit a feed message on the shared bus. The primitive every named
 * `publishXxx` method (and the generic `publish`) builds on.
 */
const emitFeed = (emitter: EventEmitter, feed: PresenceFeed, pageId: string, payload?: unknown): void => {
  emitter.emit(FEED_EVENT, feed, pageId, payload);
};

/**
 * The named `onXxx` listener registrations + the generic `subscribe` —
 * identical `subscribeFeed(emitter, ...)` wiring in both the in-process
 * and the Redis implementation, since both share the same feed-bus
 * contract over their own `emitter`. Factored out once so the two
 * factories below don't each type out the same four one-line wrappers.
 */
const createFeedSubscribers = (emitter: EventEmitter): Pick<PresenceService, 'onViewersChanged' | 'onPageUpdated' | 'onCommentChanged' | 'subscribe'> => ({
  onViewersChanged(listener) {
    return subscribeFeed(emitter, 'viewers', (pageId) => listener(pageId));
  },
  onPageUpdated(listener) {
    return subscribeFeed(emitter, 'page-updated', (pageId, payload) => listener(pageId, payload as PageUpdatedPayload));
  },
  onCommentChanged(listener) {
    return subscribeFeed(emitter, 'comment-changed', (pageId, payload) => listener(pageId, payload as CommentChangedPayload));
  },
  subscribe(feed, listener) {
    return subscribeFeed(emitter, feed, listener);
  },
});

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
  // Local EventEmitter every PresenceFeed message rides on `FEED_EVENT`.
  // In Redis mode it is fed by the pub/sub subscriber + local publishes;
  // in single-instance mode it is emitted directly.
  const emitter = new EventEmitter();
  // EventEmitter's default 10-listener cap warns once per page with
  // many connected sockets; presence legitimately has one listener per
  // connected socket, so lift the cap.
  emitter.setMaxListeners(0);

  if (redis === null) {
    return createInProcessPresenceService(emitter);
  }
  return createRedisPresenceService(redis, emitter);
}

/**
 * Single-instance (no Redis) implementation. Viewer state lives in a
 * process-local Map; the editing signal is tracked in a parallel
 * process-local Map (`editing`), keyed `<pageId>` → `<userId>:<socketId>`
 * → `lastSeenAt`, mirroring the Redis editing hash. `isEditing` is
 * therefore accurate in single-instance dev too.
 */
function createInProcessPresenceService(emitter: EventEmitter): PresenceService {
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
      emitFeed(emitter, 'viewers', pageId);
    },
    async heartbeat(pageId, userId) {
      const entry = pages.get(pageId)?.get(userId);
      if (!entry) return false;
      entry.lastHeartbeatAt = Date.now();
      return true;
    },
    async leave(pageId, userId) {
      if (pages.get(pageId)?.delete(userId)) {
        emitFeed(emitter, 'viewers', pageId);
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
      emitFeed(emitter, 'viewers', pageId);
    },
    async refreshEditing(pageId, userId, socketId) {
      // Keep-alive only — no broadcast (the editing set is unchanged).
      editingMap(pageId).set(editingField(userId, socketId), Date.now());
    },
    async unmarkEditing(pageId, userId, socketId) {
      editing.get(pageId)?.delete(editingField(userId, socketId));
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
/** Wire shape published on `PRESENCE_FEED_CHANNEL` (feature-presence-generic-feed-bus). */
type FeedEnvelope = { feed: PresenceFeed; pageId: string; payload?: unknown };

async function createRedisPresenceService(redis: PresenceRedisClient, emitter: EventEmitter): Promise<PresenceService> {
  let subscriber: PresenceRedisClient | null = null;
  try {
    const dup = redis.duplicate();
    await dup.connect();
    subscriber = dup;
    await dup.subscribe(PRESENCE_FEED_CHANNEL, (message: string) => {
      let envelope: FeedEnvelope | null = null;
      try {
        const parsed = JSON.parse(message) as Partial<FeedEnvelope> | null;
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.feed === 'string' && typeof parsed.pageId === 'string') {
          envelope = parsed as FeedEnvelope;
        }
      } catch {
        // Not JSON — drop below.
      }
      if (!envelope) {
        // `PRESENCE_FEED_CHANNEL` is a brand-new channel name
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
    debug('presence pub/sub subscriber connected on %s', PRESENCE_FEED_CHANNEL);
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
      await redis.publish(PRESENCE_FEED_CHANNEL, JSON.stringify({ feed, pageId, payload }));
    } catch (err) {
      console.warn(`[crowi:presence] publish failed for feed=${feed} page=${pageId}:`, (err as Error).message);
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
      await publish('viewers', pageId);
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
        await publish('viewers', pageId);
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
        await redis.hDel(editingHashKey(pageId), editingField(userId, socketId));
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

export { EDITING_HASH_PREFIX, EDITING_REFRESH_MS, EDITING_TTL_MS, PRESENCE_FEED_CHANNEL, VIEWER_HASH_PREFIX, VIEWER_TTL_MS };
