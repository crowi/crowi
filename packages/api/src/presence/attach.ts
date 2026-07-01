import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import Debug from 'debug';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';
import { PresenceClientMessageSchema } from '@crowi/api-contract';
import type { PresenceViewer } from '@crowi/api-contract';
import type Crowi from 'src/crowi';
import type { UserDocument } from 'src/models/user';
import type { PageDocument } from 'src/models/page';
import { createPresenceTokenUtil } from 'src/util/presence-token';
import { getPresenceService, type PresenceService, type PageUpdatedPayload } from 'src/service/presence';

const debug = Debug('crowi:presence:attach');

/**
 * Path namespace the presence WebSocket answers on. The browser dials
 * `/presence/<pageId>?token=<presenceToken>`; the upgrade filter
 * accepts both the bare `/presence` and `/presence/...` so the design
 * mirrors `collab/attach.ts` exactly (sibling upgrade handlers — collab
 * at `/collab`, presence at `/presence` — coexist on one listener).
 */
const PRESENCE_PATH = '/presence';

/**
 * WebSocket close codes the presence handler uses. 4401 / 4403 are in
 * the 4000–4999 application-private range; 1001 ("going away") is the
 * standard code for a graceful server shutdown.
 */
const WS_CLOSE = {
  INVALID_TOKEN: 4401,
  NO_ACCESS: 4403,
  SHUTDOWN: 1001,
} as const;

/** Split a request URL into its pathname and raw query string. */
const splitUrl = (rawUrl: string): { pathname: string; query: string } => {
  const queryIdx = rawUrl.indexOf('?');
  return queryIdx < 0 ? { pathname: rawUrl, query: '' } : { pathname: rawUrl.slice(0, queryIdx), query: rawUrl.slice(queryIdx + 1) };
};

/**
 * Per-connection read-permission cache TTL. After a viewer's read
 * grant is confirmed once, subsequent heartbeats skip the Mongo lookup
 * for this long; a heartbeat after the window re-checks, so a mid-
 * session permission revocation is detected within ~60s + one
 * heartbeat interval. RFC-0005 §"Permission boundary".
 */
const PERMISSION_CACHE_TTL_MS = 60_000;

/**
 * Grace window between asking sockets to close politely and force-
 * terminating stragglers on shutdown. Mirrors `collab/attach.ts`.
 */
const SHUTDOWN_DRAIN_MS = 500;

/**
 * Public surface returned from `attachPresenceServer`. The api boot
 * keeps the handle so SIGINT teardown can drain sockets and tear down
 * the presence pub/sub subscriber.
 */
export interface AttachedPresence {
  /** Detach + tear down. Idempotent; safe to call from a SIGINT handler. */
  shutdown(): Promise<void>;
}

/** Minimal Page-model surface the handler touches (grant re-check). */
interface PresencePageModel {
  findById(id: string): { exec(): Promise<PageDocument | null> };
}

/**
 * One live presence connection. `userId` / `pageId` are populated once
 * the token verifies; `permittedUntil` memoises the read-grant check.
 */
interface PresenceConnection {
  ws: WsWebSocket;
  userId: string;
  pageId: string;
  /** epoch-ms after which the read-grant must be re-verified. */
  permittedUntil: number;
}

/**
 * Wire the RFC-0005 `/presence` WebSocket into the api's existing
 * Express http.Server, using the `ws` library's `noServer` mode — same
 * process, same event loop, same Mongoose connection, same Redis
 * client as `/collab`.
 *
 * Connection lifecycle:
 *   1. Upgrade filter accepts `/presence` / `/presence/*`.
 *   2. Verify the `?token=` presence JWT (signature + issuer).
 *   3. Verify `token.pageId` matches the `/presence/<pageId>` path
 *      segment when one is present.
 *   4. Re-check read permission against Mongo (the token was minted up
 *      to 5 min ago — grants can be revoked in between).
 *   5. `presence.join` registers the viewer; the page's viewer list is
 *      broadcast to every connected client (this instance + others via
 *      Redis pub/sub).
 *   6. Client heartbeats every 15s refresh the Redis TTL; a heartbeat
 *      past the permission-cache window re-checks read grant and
 *      disconnects a revoked viewer.
 *   7. On close, `presence.leave` removes the viewer and re-broadcasts.
 *
 * Boot order: call after `setupModels`. The api's `Crowi.start`
 * invokes this right before `server.listen`, next to `attachCollabServer`.
 */
export async function attachPresenceServer(httpServer: HttpServer, crowi: Crowi): Promise<AttachedPresence> {
  const presenceTokenUtil = createPresenceTokenUtil();
  const presence: PresenceService = await getPresenceService(crowi);
  const Page = crowi.model('Page') as unknown as PresencePageModel;
  const User = crowi.model('User');

  // `noServer: true` — the upgrade handshake is owned by the api
  // process; we forward only `/presence/*` upgrades here.
  const wss = new WebSocketServer({ noServer: true });

  // Every live connection, keyed by socket. Used to broadcast a page's
  // viewer list to exactly its connected clients and to drain on
  // shutdown.
  const connections = new Map<WsWebSocket, PresenceConnection>();

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
   * Broadcast the current viewer list of `pageId` to every locally-
   * connected client for that page. Triggered by `presence`'s change
   * events (local writes + cross-instance pub/sub).
   */
  const broadcastViewers = async (pageId: string): Promise<void> => {
    // Collect the local sockets watching this page before the await so
    // a concurrent close doesn't matter — `sendJson` no-ops on a
    // non-OPEN socket.
    const targets: WsWebSocket[] = [];
    for (const conn of connections.values()) {
      if (conn.pageId === pageId) targets.push(conn.ws);
    }
    if (targets.length === 0) return;
    let viewers: PresenceViewer[];
    try {
      viewers = await presence.listViewers(pageId);
    } catch (err) {
      console.warn(`[crowi:presence] listViewers failed for page ${pageId}:`, (err as Error).message);
      return;
    }
    const message = { type: 'viewers' as const, viewers };
    for (const ws of targets) {
      sendJson(ws, message);
    }
  };

  /**
   * Push a page-updated signal to every locally-connected client for
   * `pageId` (feature-live-page-content-sync). Mirrors `broadcastViewers`
   * but needs no presence re-read — the payload arrives complete from
   * the publisher. `sendJson` no-ops on a non-OPEN socket, so collecting
   * the targets synchronously is safe.
   */
  const broadcastPageUpdated = (pageId: string, payload: PageUpdatedPayload): void => {
    const message = {
      type: 'page-updated' as const,
      pageId: payload.pageId,
      revisionId: payload.revisionId,
      editorUserId: payload.editorUserId,
      editorDisplayName: payload.editorDisplayName,
    };
    for (const conn of connections.values()) {
      if (conn.pageId === pageId) sendJson(conn.ws, message);
    }
  };

  // Subscribe to viewer-list changes (local + cross-instance). The
  // unsubscribe fn is invoked on shutdown.
  const unsubscribe = presence.onViewersChanged((pageId: string) => {
    void broadcastViewers(pageId);
  });

  // Subscribe to page-updated signals (local + cross-instance) and fan
  // them out to this instance's viewer sockets. Unsubscribed on shutdown.
  const unsubscribePageUpdated = presence.onPageUpdated((pageId: string, payload: PageUpdatedPayload) => {
    broadcastPageUpdated(pageId, payload);
  });

  /**
   * Re-verify that `userId` still has read grant on `pageId`. Returns
   * `false` when the page vanished or the grant was revoked. A throw
   * is treated as "no permission" (fail-closed).
   */
  const hasReadPermission = async (pageId: string, userId: string): Promise<boolean> => {
    try {
      const page = await Page.findById(pageId).exec();
      if (!page) return false;
      // `isGrantedFor` takes a user-like object; load the connecting
      // user so OWNER / GROUP grants resolve against the real record.
      const userDoc = (await User.findById(userId).exec()) as UserDocument | null;
      if (!userDoc) return false;
      return page.isGrantedFor(userDoc);
    } catch (err) {
      debug('permission re-check threw for page=%s user=%s: %s', pageId, userId, (err as Error).message);
      return false;
    }
  };

  /** Load the connecting user's denormalised identity for the hash. */
  const loadViewerIdentity = async (userId: string) => {
    const userDoc = (await User.findById(userId).exec()) as UserDocument | null;
    if (!userDoc) return null;
    return {
      userId,
      username: userDoc.username ?? '',
      displayName: userDoc.name ?? userDoc.username ?? '',
      avatarUrl: userDoc.image ?? null,
    };
  };

  /**
   * Wire one freshly-upgraded `ws.WebSocket`. Authentication runs
   * inline: a bad token / page mismatch / revoked grant closes the
   * socket immediately. A clean connection is added to `connections`
   * and gets the first viewer-list broadcast.
   */
  const wireConnection = async (ws: WsWebSocket, request: IncomingMessage): Promise<void> => {
    const { pathname, query } = splitUrl(request.url ?? '');
    const token = new URLSearchParams(query).get('token') ?? '';

    // 1. token present + verifies (signature, issuer, schema).
    const claims = token.length > 0 ? presenceTokenUtil.verifyPresenceToken(token) : null;
    if (!claims) {
      debug('reject: presence token missing / invalid');
      ws.close(WS_CLOSE.INVALID_TOKEN, 'invalid token');
      return;
    }

    // 2. `/presence/<pageId>` path segment, when present, must match
    //    the token. The bare `/presence` form is also accepted (the
    //    token is the authoritative pageId source).
    const pathSegment = pathname.startsWith(`${PRESENCE_PATH}/`) ? pathname.slice(PRESENCE_PATH.length + 1) : '';
    if (pathSegment.length > 0 && pathSegment !== claims.pageId) {
      debug('reject: path pageId %s != token pageId %s', pathSegment, claims.pageId);
      ws.close(WS_CLOSE.INVALID_TOKEN, 'invalid token');
      return;
    }

    // The token verified, so userId / pageId are known. Register the
    // close + error handlers NOW, before the async permission / identity
    // round-trips below. A socket that closes *during* those awaits (a
    // fast client navigation, React's dev double-mount) would otherwise
    // fire `'close'` into the void — the handler being attached only
    // after the awaits — leaving a phantom `connections` entry whose
    // `'close'` never runs. That phantom poisons the multi-tab
    // `userStillConnected` check in `handleClose`, so a later *real*
    // disconnect skips `presence.leave` and the viewer is stuck in the
    // hash for every other client on the page.
    const conn: PresenceConnection = {
      ws,
      userId: claims.userId,
      pageId: claims.pageId,
      permittedUntil: 0,
    };
    let closed = false;
    ws.on('close', () => {
      closed = true;
      void handleClose(conn);
    });
    ws.on('error', (err: Error) => {
      // A single bad socket must not crash the api process.
      console.error('[crowi:presence] websocket error', err);
    });

    // 3. re-check read permission (token was minted up to 5 min ago).
    const permitted = await hasReadPermission(claims.pageId, claims.userId);
    if (!permitted) {
      debug('reject: user %s lost read grant on page %s', claims.userId, claims.pageId);
      ws.close(WS_CLOSE.NO_ACCESS, 'no access');
      return;
    }

    const identity = await loadViewerIdentity(claims.userId);
    if (!identity) {
      debug('reject: connecting user %s not found', claims.userId);
      ws.close(WS_CLOSE.NO_ACCESS, 'no access');
      return;
    }

    // The socket closed while permission / identity were resolving —
    // the close handler has already run; do not register a viewer.
    if (closed) {
      debug('presence socket closed during setup user=%s page=%s', conn.userId, conn.pageId);
      return;
    }

    conn.permittedUntil = Date.now() + PERMISSION_CACHE_TTL_MS;
    connections.set(ws, conn);
    ws.on('message', (data: Buffer | ArrayBuffer) => {
      void handleClientMessage(conn, data);
    });

    // Register the viewer. `join` publishes a viewer-list change, which
    // flows back through `onViewersChanged` → `broadcastViewers`, so
    // this socket (and every other on the page) gets the fresh list.
    try {
      await presence.join(conn.pageId, identity);
    } catch (err) {
      console.warn(`[crowi:presence] join failed for page ${conn.pageId}:`, (err as Error).message);
    }

    // The socket closed while `join` was in flight — the close handler
    // ran before the viewer entry existed, so reconcile now to remove
    // the entry `join` just wrote.
    if (closed) {
      debug('presence socket closed during join user=%s page=%s', conn.userId, conn.pageId);
      void handleClose(conn);
      return;
    }

    debug('presence connected user=%s page=%s', conn.userId, conn.pageId);
  };

  /**
   * Handle a client → server frame. The only valid message is
   * `{ type: 'heartbeat' }`; anything else is ignored (forward-compat).
   */
  const handleClientMessage = async (conn: PresenceConnection, data: Buffer | ArrayBuffer): Promise<void> => {
    let parsedJson: unknown;
    try {
      const text = data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : data.toString('utf8');
      parsedJson = JSON.parse(text);
    } catch {
      debug('ignore: non-JSON client frame on page %s', conn.pageId);
      return;
    }
    const message = PresenceClientMessageSchema.safeParse(parsedJson);
    if (!message.success) {
      debug('ignore: unrecognised client message on page %s', conn.pageId);
      return;
    }

    // Heartbeat: re-verify read grant if the cache window lapsed, then
    // refresh the Redis TTL.
    if (Date.now() >= conn.permittedUntil) {
      const stillPermitted = await hasReadPermission(conn.pageId, conn.userId);
      if (!stillPermitted) {
        debug('heartbeat: user %s lost grant on page %s — disconnecting', conn.userId, conn.pageId);
        conn.ws.close(WS_CLOSE.NO_ACCESS, 'no access');
        return;
      }
      conn.permittedUntil = Date.now() + PERMISSION_CACHE_TTL_MS;
    }

    try {
      const present = await presence.heartbeat(conn.pageId, conn.userId);
      if (!present) {
        // Swept while the socket was briefly idle — re-register.
        const identity = await loadViewerIdentity(conn.userId);
        if (identity) await presence.join(conn.pageId, identity);
      }
    } catch (err) {
      debug('heartbeat failed for page %s: %s', conn.pageId, (err as Error).message);
    }
  };

  /** Handle a socket close — remove the viewer and re-broadcast. */
  const handleClose = async (conn: PresenceConnection): Promise<void> => {
    connections.delete(conn.ws);
    // Only `leave` when no *other* socket for the same user-page pair
    // remains — multi-tab dedup: closing one of three tabs must not
    // remove the user from the viewer list.
    let userStillConnected = false;
    for (const other of connections.values()) {
      if (other.userId === conn.userId && other.pageId === conn.pageId) {
        userStillConnected = true;
        break;
      }
    }
    if (userStillConnected) {
      debug('close: user %s still has another tab on page %s — keep viewer', conn.userId, conn.pageId);
      return;
    }
    try {
      await presence.leave(conn.pageId, conn.userId);
    } catch (err) {
      debug('leave failed for page %s: %s', conn.pageId, (err as Error).message);
    }
  };

  /**
   * `'upgrade'` handler. Path-filter first so the sibling `/collab`
   * handler keeps its slot; `socket.destroy()` is intentionally NOT
   * called on a no-match so Node moves on to the next listener.
   */
  const upgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const { pathname } = splitUrl(request.url ?? '');
    if (pathname !== PRESENCE_PATH && !pathname.startsWith(`${PRESENCE_PATH}/`)) {
      return; // not ours — let other upgrade handlers try.
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      void wireConnection(ws, request);
    });
  };

  httpServer.on('upgrade', upgradeHandler);
  debug('presence attached to http.Server (path=%s)', PRESENCE_PATH);

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

      // 2. Stop reacting to viewer-list + page-updated changes.
      try {
        unsubscribe();
      } catch {
        // best-effort
      }
      try {
        unsubscribePageUpdated();
      } catch {
        // best-effort
      }

      // 3. Politely close every live socket.
      for (const conn of connections.values()) {
        try {
          conn.ws.close(WS_CLOSE.SHUTDOWN, 'server shutting down');
        } catch {
          // ignore — best-effort
        }
      }

      // 4. Brief drain so close frames flush.
      if (connections.size > 0) {
        await new Promise<void>((resolveDrain) => setTimeout(resolveDrain, SHUTDOWN_DRAIN_MS));
      }

      // 5. Force-terminate stragglers.
      try {
        for (const conn of connections.values()) {
          try {
            conn.ws.terminate();
          } catch {
            // ignore
          }
        }
        connections.clear();
        wss.close();
      } catch (err) {
        console.error('[crowi:presence] wss.close failed during shutdown:', err);
      }

      // 6. Tear down the presence service's pub/sub subscriber.
      try {
        await presence.shutdown();
      } catch (err) {
        console.error('[crowi:presence] presence.shutdown failed:', err);
      }
    },
  };
}
