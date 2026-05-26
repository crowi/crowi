import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import Debug from 'debug';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';
import type Crowi from 'src/crowi';
import { createNotificationsTokenUtil } from 'src/util/notifications-token';

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
 * Redis pub/sub channel prefix for per-user notification invalidation
 * signals. Channel names are `crowi:notifications:user:<userId>`; one
 * channel per recipient so a publish only reaches instances that
 * actually have that user connected (and the WebSocket fan-out stays
 * bounded). The model layer's `notificationEvent` listener (see
 * `models/notification.ts`) is what publishes to these channels.
 */
const CHANNEL_PREFIX = 'crowi:notifications:user:';

const channelForUser = (userId: string): string => `${CHANNEL_PREFIX}${userId}`;

/**
 * WebSocket close codes the notifications handler uses. 4401 / 4403
 * are in the 4000–4999 application-private range and mirror the
 * presence handler so a shared client backoff layer can interpret
 * them consistently; 1001 ("going away") is the standard code for a
 * graceful server shutdown.
 */
const WS_CLOSE = {
  INVALID_TOKEN: 4401,
  FORBIDDEN: 4403,
  SHUTDOWN: 1001,
} as const;

/**
 * Grace window between asking sockets to close politely and force-
 * terminating stragglers on shutdown. Mirrors presence / collab.
 */
const SHUTDOWN_DRAIN_MS = 500;

/** Split a request URL into its pathname and raw query string. */
const splitUrl = (rawUrl: string): { pathname: string; query: string } => {
  const queryIdx = rawUrl.indexOf('?');
  return queryIdx < 0 ? { pathname: rawUrl, query: '' } : { pathname: rawUrl.slice(0, queryIdx), query: rawUrl.slice(queryIdx + 1) };
};

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

/** One live notifications connection. `userId` is populated once the token verifies. */
interface NotificationsConnection {
  ws: WsWebSocket;
  userId: string;
}

/**
 * Wire the RFC `/notifications` WebSocket into the api's existing
 * `http.Server`, using `ws`'s `noServer` mode — same process, same
 * event loop, same Redis client as `/collab` and `/presence`.
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

  // Dedicated subscriber client — node-redis v4 puts a connection into
  // subscriber mode on `subscribe`, after which it can no longer issue
  // regular commands. publish happens on the original `crowi.redis`
  // (see `models/notification.ts`), subscribe on this duplicate.
  let subscriber: NotificationsRedisClient | null = null;
  if (primaryRedis !== null) {
    try {
      const dup = primaryRedis.duplicate();
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

  // `noServer: true` — the upgrade handshake is owned by the api
  // process; we forward only `/notifications/*` upgrades here.
  const wss = new WebSocketServer({ noServer: true });

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
   *      wireConnection sees an empty set and schedules a `subscribe`.
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
   * then re-serialise via `sendJson` for each receiver — the wire
   * format the browser sees is still the same `{type:'changed'}`
   * shape, just normalised through `JSON.stringify`.
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
    for (const conn of sockets) {
      sendJson(conn.ws, payload);
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
        await subscriber!.subscribe(channelForUser(userId), (message: string) => {
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
        await subscriber!.unsubscribe(channelForUser(userId));
        debug('unsubscribed user %s channel', userId);
      } catch (err) {
        debug('unsubscribe failed for user %s: %s', userId, (err as Error).message);
      }
    });
  };

  /**
   * Wire one freshly-upgraded `ws.WebSocket`. Authentication runs
   * inline: a bad token / userId mismatch closes the socket
   * immediately. A clean connection is registered and the user's
   * Redis channel is (lazily) subscribed.
   */
  const wireConnection = async (ws: WsWebSocket, request: IncomingMessage): Promise<void> => {
    const { pathname, query } = splitUrl(request.url ?? '');
    const token = new URLSearchParams(query).get('token') ?? '';

    // 1. Token must verify (signature + issuer + schema).
    const claims = token.length > 0 ? tokenUtil.verifyNotificationsToken(token) : null;
    if (!claims) {
      debug('reject: notifications token missing / invalid');
      ws.close(WS_CLOSE.INVALID_TOKEN, 'invalid token');
      return;
    }

    // 2. `/notifications/<userId>` path segment, when present, must
    //    match the token. The bare `/notifications` form is also
    //    accepted (the token is the authoritative userId source).
    const pathSegment = pathname.startsWith(`${NOTIFICATIONS_PATH}/`) ? pathname.slice(NOTIFICATIONS_PATH.length + 1) : '';
    if (pathSegment.length > 0 && pathSegment !== claims.selfUserId) {
      debug('reject: path userId %s != token selfUserId %s', pathSegment, claims.selfUserId);
      ws.close(WS_CLOSE.FORBIDDEN, 'forbidden');
      return;
    }

    const userId = claims.selfUserId;
    const conn: NotificationsConnection = { ws, userId };

    // Register the close handler BEFORE the await on
    // `ensureSubscribed` so a socket that closes during the subscribe
    // round-trip is reconciled cleanly — same race-window fix as
    // presence/attach.ts (see the rationale comment there).
    let closed = false;
    ws.on('close', () => {
      closed = true;
      void handleClose(conn);
    });
    ws.on('error', (err: Error) => {
      // A single bad socket must not crash the api process.
      console.error('[crowi:notifications] websocket error', err);
    });

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

    // The socket closed while subscribe was in flight — the close
    // handler may have already run before the connection was tracked.
    // Reconcile by running close cleanup once: deleting an absent
    // socket from the set is a no-op, and `handleClose` does the
    // unsubscribe when the set empties.
    if (closed) {
      debug('notifications socket closed during setup user=%s', userId);
      void handleClose(conn);
      return;
    }

    debug('notifications connected user=%s', userId);
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
   * `'upgrade'` handler. Path-filter first so the sibling `/collab` /
   * `/presence` handlers keep their slot; `socket.destroy()` is
   * intentionally NOT called on a no-match so Node moves on to the
   * next listener.
   */
  const upgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const { pathname } = splitUrl(request.url ?? '');
    if (pathname !== NOTIFICATIONS_PATH && !pathname.startsWith(`${NOTIFICATIONS_PATH}/`)) {
      return; // not ours — let other upgrade handlers try.
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      void wireConnection(ws, request);
    });
  };

  httpServer.on('upgrade', upgradeHandler);
  debug('notifications attached to http.Server (path=%s, redis=%s)', NOTIFICATIONS_PATH, subscriber !== null ? 'on' : 'off');

  let didShutdown = false;
  return {
    async shutdown() {
      if (didShutdown) return;
      didShutdown = true;

      // 1. Refuse new upgrades.
      try {
        httpServer.off('upgrade', upgradeHandler);
      } catch {
        // best-effort — server may already be tearing down.
      }

      // 2. Politely close every live socket.
      for (const sockets of connectionsByUser.values()) {
        for (const conn of sockets) {
          try {
            conn.ws.close(WS_CLOSE.SHUTDOWN, 'server shutting down');
          } catch {
            // ignore — best-effort
          }
        }
      }

      // 3. Brief drain so close frames flush.
      if (connectionsByUser.size > 0) {
        await new Promise<void>((resolveDrain) => setTimeout(resolveDrain, SHUTDOWN_DRAIN_MS));
      }

      // 4. Force-terminate stragglers.
      try {
        for (const sockets of connectionsByUser.values()) {
          for (const conn of sockets) {
            try {
              conn.ws.terminate();
            } catch {
              // ignore
            }
          }
        }
        connectionsByUser.clear();
        wss.close();
      } catch (err) {
        console.error('[crowi:notifications] wss.close failed during shutdown:', err);
      }

      // 5. Tear down the Redis subscriber (when one was built).
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

/**
 * Re-export for test fixtures + the model-layer publisher (which uses
 * the same prefix). Bundled here so a future channel-name change
 * touches one constant.
 */
export const NOTIFICATIONS_CHANNEL_PREFIX = CHANNEL_PREFIX;
export const channelForUserId = channelForUser;
