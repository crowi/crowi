import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { NotificationsServerMessageSchema, WS_CLOSE_CODES } from '@crowi/api-contract';
import Debug from 'debug';
import type Crowi from 'src/crowi';
import { createNotificationsTokenUtil } from 'src/util/notifications-token';
import { resolveRedisKeyspaceIfEnabled } from 'src/util/redis-keyspace';
import { duplicateWithErrorHandler } from 'src/util/redis-opts';
import { attachWsNamespace, politeCloseWithReason, splitUrl } from 'src/ws/attach-namespace';
import type { WebSocket as WsWebSocket } from 'ws';
import { channelForUser } from './channel';

const debug = Debug('crowi:notifications:attach');

/**
 * Path namespace the notifications WebSocket answers on. The browser
 * dials `/notifications/<userId>?token=<notificationsToken>`; the
 * upgrade filter accepts both the bare `/notifications` and
 * `/notifications/...` so the design mirrors `presence/attach.ts` /
 * `collab/attach.ts` exactly (sibling upgrade handlers coexist on one
 * http.Server listener).
 */
const NOTIFICATIONS_PATH = '/notifications';

/**
 * Minimum node-redis v4 surface the notifications handler leans on.
 * Keeping this structural interface narrow lets the attach test inject
 * a deterministic in-memory fake without pulling in the real redis
 * client. The shape matches `PresenceRedisClient` (service/presence.ts)
 * so a future skeleton-extract pass can dedupe them — see the spec's
 * "■ Skeleton 抽出は今回スコープ外" note for why that does not happen
 * in this task.
 */
export interface NotificationsRedisClient {
  publish(channel: string, message: string): Promise<number>;
  duplicate(): NotificationsRedisClient;
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  subscribe(channel: string, listener: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
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
 * Public surface returned from `attachNotificationsServer`. The api
 * boot keeps the handle so SIGINT teardown can drain sockets and tear
 * down the Redis subscriber.
 */
export interface AttachedNotifications {
  /** Detach + tear down. Idempotent; safe to call from a SIGINT handler. */
  shutdown(): Promise<void>;
}

/**
 * One live notifications connection. Doubles as the `attachWsNamespace`
 * context: built by `authenticate` once the token / path checks pass.
 */
interface NotificationsConnection {
  ws: WsWebSocket;
  userId: string;
}

/**
 * Wire the RFC `/notifications` WebSocket into the api's existing
 * `http.Server`, using `ws`'s `noServer` mode — same process, same
 * event loop, same Redis client as `/collab` and `/presence`. The
 * upgrade filter / shutdown drain / pre-auth close-registration race
 * fix are provided by the shared `attachWsNamespace` primitive
 * (`src/ws/attach-namespace.ts`); this module supplies the
 * notifications-specific authentication and subscribe/unsubscribe
 * business logic.
 *
 * Connection lifecycle:
 *   1. Upgrade filter accepts `/notifications` / `/notifications/*`.
 *   2. Verify the `?token=` notifications JWT (signature + issuer).
 *   3. Verify `token.selfUserId` matches the `/notifications/<userId>`
 *      path segment — a token for user A cannot subscribe to user B's
 *      channel even when validly signed.
 *   4. The first connection for a given userId in this process
 *      `subscribe`s that user's Redis channel; later connections for
 *      the same userId reuse the subscription (one Redis subscribe
 *      regardless of tab count).
 *   5. On message receive, fan the `{type:'changed'}` payload out to
 *      every locally-connected socket for that userId.
 *   6. On close, unregister the connection; the last `close` for a
 *      userId `unsubscribe`s the Redis channel so the subscriber's
 *      working set stays bounded.
 *
 * Degrade: when `crowi.redis === null` (single-instance dev with
 * `REDIS_URL` unset) we skip subscribe/unsubscribe entirely. The
 * WebSocket still accepts connections — the model layer's publish
 * also no-ops — so the channel is silent but the API + handler boot
 * cleanly and the dev experience is "no realtime invalidation, next
 * user action triggers react-query refetch".
 *
 * Boot order: call after `setupModels` + `setupRedisClient`. The api's
 * `Crowi.start` invokes this right next to `attachCollabServer` /
 * `attachPresenceServer`.
 */
export async function attachNotificationsServer(httpServer: HttpServer, crowi: Crowi): Promise<AttachedNotifications> {
  const tokenUtil = createNotificationsTokenUtil();

  // `crowi.redis` is typed `any` on the Crowi class; narrow to the
  // structural client surface (or null) the handler expects. When
  // Redis is unavailable the handler runs in degraded mode (no pub/sub).
  const primaryRedis = (crowi.redis as NotificationsRedisClient | null) ?? null;

  // Instance-scoped channel naming (feature-redis-key-prefix §1/§2), matching
  // `models/notification.ts`'s `publishNotificationsChange` (both sides must
  // agree on the same `crowi:<slug>:notifications:user:<userId>` channel for
  // a given `crowi`).
  const keyspace = resolveRedisKeyspaceIfEnabled(crowi);

  // Dedicated subscriber client — node-redis v4 puts a connection into
  // subscriber mode on `subscribe`, after which it can no longer issue
  // regular commands. publish happens on the original `crowi.redis`
  // (see `models/notification.ts`), subscribe on this duplicate.
  let subscriber: NotificationsRedisClient | null = null;
  if (primaryRedis !== null) {
    try {
      const dup = duplicateWithErrorHandler(primaryRedis, 'notifications pub/sub subscriber');
      await dup.connect();
      subscriber = dup;
      debug('notifications pub/sub subscriber connected');
    } catch (err) {
      // A subscriber failure degrades notifications to single-instance
      // behaviour for *this* process — locally-connected clients still
      // miss invalidations published from elsewhere. Never fatal.
      console.warn('[crowi:notifications] pub/sub subscriber setup failed — cross-instance fan-out disabled:', (err as Error).message);
    }
  }

  // userId → set of live sockets for that user (multi-tab). Drives:
  //  - the lazy subscribe/unsubscribe of Redis channels (first/last
  //    socket for a userId triggers it),
  //  - the per-channel fan-out (resolve receiver sockets by userId),
  //  - the shutdown drain (iterate every socket once).
  const connectionsByUser = new Map<string, Set<NotificationsConnection>>();

  /**
   * Per-user serialisation chain for Redis subscribe / unsubscribe.
   *
   * Race scenario we are guarding against:
   *   1. User A's last tab closes → handleClose schedules an async
   *      `unsubscribe`.
   *   2. Before that unsubscribe completes, user A's NEW tab opens →
   *      `openConnection` sees an empty set and schedules a `subscribe`.
   *   3. The two ops can land in any order on the Redis subscriber;
   *      if unsubscribe wins, the new tab is left without a live
   *      subscription and silently misses every invalidation.
   *
   * Fix: chain every subscribe/unsubscribe for a given userId through
   * a single promise so they run FIFO. The chain entry is deleted
   * after the op resolves and the chain is empty, so the map does
   * not leak. We do not care about retaining the resolved value —
   * `.then(() => actualOp())` is enough to ensure ordering.
   */
  const channelOps = new Map<string, Promise<void>>();
  const chainChannelOp = (userId: string, op: () => Promise<void>): Promise<void> => {
    const prev = channelOps.get(userId) ?? Promise.resolve();
    // `.then(op)` schedules `op` after `prev` settles successfully;
    // since every chain link below catches its own errors, the
    // previous link always resolves, so the next link always runs.
    const next = prev.then(op).catch(() => {
      // Errors are already logged inside ensureSubscribed /
      // ensureUnsubscribed — swallow here so a single failure does
      // not break the chain for subsequent ops on the same user.
    });
    channelOps.set(userId, next);
    void next.finally(() => {
      // Best-effort cleanup so a long-lived process does not retain
      // a settled promise per user forever.
      if (channelOps.get(userId) === next) {
        channelOps.delete(userId);
      }
    });
    return next;
  };

  /** Send a JSON message to one socket; ignore a dead socket. */
  const sendJson = (ws: WsWebSocket, payload: unknown): void => {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      debug('send failed: %s', (err as Error).message);
    }
  };

  /**
   * Redis subscriber message handler — fan the `changed` signal out
   * to every locally-connected socket for the receiving userId. The
   * payload from Redis is the JSON `{type:'changed'}` string the
   * model layer publishes; we parse it once as a JSON-validation gate
   * (a non-JSON publish is necessarily not ours and is dropped) and
   * then schema-validate against `NotificationsServerMessageSchema`
   * before re-serialising via `sendJson` for each receiver. Defence
   * in depth: a foreign / malformed publish on the channel never
   * reaches the browser, regardless of what put it there.
   */
  const handleRedisMessage = (userId: string, message: string): void => {
    const sockets = connectionsByUser.get(userId);
    if (!sockets || sockets.size === 0) return;
    let payload: unknown;
    try {
      payload = JSON.parse(message);
    } catch {
      // Drop a malformed publish — the broadcast contract is JSON, so
      // a non-JSON message is necessarily not ours.
      debug('drop non-JSON publish on user %s channel', userId);
      return;
    }
    const parsed = NotificationsServerMessageSchema.safeParse(payload);
    if (!parsed.success) {
      // A shape that doesn't match the contract is necessarily not the
      // model layer's publish — drop it rather than leaking arbitrary
      // JSON to the browser.
      debug('drop schema-invalid publish on user %s channel: %s', userId, parsed.error.issues.map((i) => i.message).join('; '));
      return;
    }
    for (const conn of sockets) {
      sendJson(conn.ws, parsed.data);
    }
  };

  /**
   * Subscribe this process to a user's channel on first connection.
   * No-ops when the subscriber is unavailable (degrade mode).
   *
   * Serialised through the per-user `channelOps` chain so a pending
   * unsubscribe completes before we attempt the subscribe — see the
   * `channelOps` block above for the race rationale.
   */
  const ensureSubscribed = (userId: string): Promise<void> => {
    if (subscriber === null) return Promise.resolve();
    return chainChannelOp(userId, async () => {
      try {
        // `keyspace` is mandatory on `channelForUser` (feature-redis-key-prefix
        // §1/§2) — `subscriber` is only ever non-null when `primaryRedis` was
        // non-null above, which is exactly the condition under which
        // `resolveRedisKeyspaceIfEnabled` resolved a real keyspace instead of
        // `undefined`, so this assertion reflects an invariant, not a guess.
        await subscriber!.subscribe(channelForUser(userId, keyspace!), (message: string) => {
          handleRedisMessage(userId, message);
        });
        debug('subscribed user %s channel', userId);
      } catch (err) {
        console.warn(`[crowi:notifications] subscribe failed for user ${userId}:`, (err as Error).message);
      }
    });
  };

  /**
   * Unsubscribe a user's channel when the last connection closes.
   * No-ops when the subscriber is unavailable (degrade mode).
   *
   * Serialised through the per-user `channelOps` chain (see
   * `ensureSubscribed`).
   */
  const ensureUnsubscribed = (userId: string): Promise<void> => {
    if (subscriber === null) return Promise.resolve();
    return chainChannelOp(userId, async () => {
      try {
        // See `ensureSubscribed`'s comment — same invariant applies here.
        await subscriber!.unsubscribe(channelForUser(userId, keyspace!));
        debug('unsubscribed user %s channel', userId);
      } catch (err) {
        debug('unsubscribe failed for user %s: %s', userId, (err as Error).message);
      }
    });
  };

  /**
   * `attachWsNamespace`'s `resolveContext` callback: token verify + path
   * check (former steps 1-2 of `wireConnection`). A `null` return means
   * the socket was already closed with the appropriate code — the
   * primitive sends none of its own.
   */
  const authenticate = async (request: IncomingMessage, ws: WsWebSocket): Promise<NotificationsConnection | null> => {
    const { pathname, query } = splitUrl(request.url ?? '');
    const token = new URLSearchParams(query).get('token') ?? '';

    // 1. Token must verify (signature + issuer + schema).
    const claims = token.length > 0 ? tokenUtil.verifyNotificationsToken(token) : null;
    if (!claims) {
      debug('reject: notifications token missing / invalid');
      ws.close(WS_CLOSE_CODES.INVALID_TOKEN, 'invalid token');
      return null;
    }

    // 2. `/notifications/<userId>` path segment, when present, must
    //    match the token. The bare `/notifications` form is also
    //    accepted (the token is the authoritative userId source).
    //
    //    Path handling:
    //      - decodeURIComponent on the raw segment so a userId that
    //        contains URI-reserved characters (e.g. SSO ids like
    //        `user%40foo`) is compared to `selfUserId` in its decoded
    //        form (otherwise an encoded form would never match a
    //        plain-text token claim).
    //      - Strip a trailing slash so `/notifications/<id>/` (some
    //        reverse proxies normalise to this) is accepted as
    //        equivalent to `/notifications/<id>`.
    //      - Reject any extra path segment (`/notifications/<id>/...`)
    //        — it is outside the spec and we'd rather be explicit
    //        than silently accept whatever a misbehaving proxy sends.
    const rawSegment = pathname.startsWith(`${NOTIFICATIONS_PATH}/`) ? pathname.slice(NOTIFICATIONS_PATH.length + 1) : '';
    let pathSegment = '';
    if (rawSegment.length > 0) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(rawSegment);
      } catch {
        debug('reject: malformed percent-encoding in path segment %s', rawSegment);
        ws.close(WS_CLOSE_CODES.FORBIDDEN, 'forbidden');
        return null;
      }
      const normalised = decoded.replace(/\/+$/, '');
      if (normalised.includes('/')) {
        debug('reject: extra path segment after userId: %s', normalised);
        ws.close(WS_CLOSE_CODES.FORBIDDEN, 'forbidden');
        return null;
      }
      pathSegment = normalised;
    }
    if (pathSegment.length > 0 && pathSegment !== claims.selfUserId) {
      debug('reject: path userId %s != token selfUserId %s', pathSegment, claims.selfUserId);
      ws.close(WS_CLOSE_CODES.FORBIDDEN, 'forbidden');
      return null;
    }

    return { ws, userId: claims.selfUserId };
  };

  /** Handle a socket close — drop the connection and maybe unsubscribe. */
  const handleClose = async (conn: NotificationsConnection): Promise<void> => {
    const sockets = connectionsByUser.get(conn.userId);
    if (!sockets) return;
    sockets.delete(conn);
    if (sockets.size > 0) return;
    connectionsByUser.delete(conn.userId);
    await ensureUnsubscribed(conn.userId);
  };

  /**
   * `attachWsNamespace`'s `onOpen`: former steps 4-5 of `wireConnection`
   * (register + lazily subscribe). Runs after `authenticate` resolved
   * and the primitive confirmed the socket is still open.
   */
  const openConnection = async (conn: NotificationsConnection): Promise<void> => {
    const { userId, ws } = conn;
    const sockets = connectionsByUser.get(userId);
    const isFirstForUser = !sockets || sockets.size === 0;
    if (sockets) {
      sockets.add(conn);
    } else {
      connectionsByUser.set(userId, new Set([conn]));
    }

    if (isFirstForUser) {
      await ensureSubscribed(userId);
    }

    // The socket closed while subscribe was in flight. The primitive's
    // own close listener (registered right before this `onOpen` call)
    // will have already run `handleClose` once — this reconciles by
    // running it again now that the subscribe is guaranteed to have
    // settled, in case it raced a premature unsubscribe.
    if (ws.readyState !== ws.OPEN) {
      debug('notifications socket closed during setup user=%s', userId);
      void handleClose(conn);
      return;
    }

    debug('notifications connected user=%s', userId);
  };

  const wsNamespace = attachWsNamespace<NotificationsConnection>(httpServer, {
    path: NOTIFICATIONS_PATH,
    resolveContext: authenticate,
    onOpen: (_ws, conn) => {
      void openConnection(conn);
    },
    onClose: (conn) => {
      void handleClose(conn);
    },
    politeClose: politeCloseWithReason(WS_CLOSE_CODES.SHUTDOWN, 'server shutting down'),
  });

  debug('notifications attached to http.Server (path=%s, redis=%s)', NOTIFICATIONS_PATH, subscriber !== null ? 'on' : 'off');

  let didShutdown = false;
  return {
    async shutdown() {
      if (didShutdown) return;
      didShutdown = true;

      // off upgrade → politely close every live socket → drain wait →
      // force-terminate stragglers → wss.close().
      await wsNamespace.shutdown();

      // Tear down the Redis subscriber (when one was built).
      if (subscriber !== null) {
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

export { channelForUser } from './channel';
