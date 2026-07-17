import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { PresenceViewer } from '@crowi/api-contract';
import { PresenceClientMessageSchema, WS_CLOSE_CODES } from '@crowi/api-contract';
import Debug from 'debug';
import type Crowi from 'src/crowi';
import type { PageDocument } from 'src/models/page';
import type { UserDocument } from 'src/models/user';
import { type CommentChangedPayload, getPresenceService, type PageUpdatedPayload, type PresenceService } from 'src/service/presence';
import { createPresenceTokenUtil } from 'src/util/presence-token';
import { attachWsNamespace, politeCloseWithReason, splitUrl } from 'src/ws/attach-namespace';
import type { WebSocket as WsWebSocket } from 'ws';

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
 * WebSocket close codes the presence handler uses — the shared
 * `@crowi/api-contract` export, single source with the notifications
 * handler and every client reconnect consumer. `NO_ACCESS` is a locally
 * meaningful alias for the generic `FORBIDDEN` code: presence's
 * grant-based rejection reads better under that name (see
 * `WS_CLOSE_CODES`'s own doc for the full rationale).
 */
const { INVALID_TOKEN, FORBIDDEN: NO_ACCESS, SHUTDOWN } = WS_CLOSE_CODES;

/**
 * Per-connection read-permission cache TTL. After a viewer's read
 * grant is confirmed once, subsequent heartbeats skip the Mongo lookup
 * for this long; a heartbeat after the window re-checks, so a mid-
 * session permission revocation is detected within ~60s + one
 * heartbeat interval. RFC-0005 §"Permission boundary".
 */
const PERMISSION_CACHE_TTL_MS = 60_000;

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

/** Denormalised viewer identity resolved once during `authenticate`. */
interface ViewerIdentity {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * One live presence connection. Doubles as the `attachWsNamespace`
 * context: built by `authenticate` once the token / permission checks
 * pass, then threaded through `onOpen` / `onClose` unchanged.
 */
interface PresenceConnection {
  ws: WsWebSocket;
  userId: string;
  pageId: string;
  /** epoch-ms after which the read-grant must be re-verified. */
  permittedUntil: number;
  identity: ViewerIdentity;
}

/**
 * Wire the RFC-0005 `/presence` WebSocket into the api's existing
 * Express http.Server, using the `ws` library's `noServer` mode — same
 * process, same event loop, same Mongoose connection, same Redis
 * client as `/collab`. The upgrade filter / shutdown drain / pre-auth
 * close-registration race fix are provided by the shared
 * `attachWsNamespace` primitive (`src/ws/attach-namespace.ts`); this
 * module supplies the presence-specific authentication and business
 * logic (join/leave, viewer-list broadcast).
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

  // Every live connection, keyed by socket. Used to broadcast a page's
  // viewer list to exactly its connected clients and for the multi-tab
  // dedup check in `handleClose`.
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

  /**
   * Push a comment-changed signal to every locally-connected client for
   * `pageId` (feature-live-page-comment-sync). The sibling of
   * `broadcastPageUpdated`: identity-only payload, no presence re-read,
   * so collecting the targets synchronously is safe. The client
   * re-fetches the comment list from the permission-checked
   * `GET /comments?page_id=` — the body never rides this frame.
   */
  const broadcastCommentChanged = (pageId: string, payload: CommentChangedPayload): void => {
    const message = {
      type: 'comment-changed' as const,
      pageId: payload.pageId,
      changeType: payload.changeType,
      commentId: payload.commentId,
      ...(payload.actorUserId !== undefined ? { actorUserId: payload.actorUserId } : {}),
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

  // Subscribe to comment-changed signals (local + cross-instance) and
  // fan them out to this instance's viewer sockets. Unsubscribed on
  // shutdown.
  const unsubscribeCommentChanged = presence.onCommentChanged((pageId: string, payload: CommentChangedPayload) => {
    broadcastCommentChanged(pageId, payload);
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
  const loadViewerIdentity = async (userId: string): Promise<ViewerIdentity | null> => {
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
   * `attachWsNamespace`'s `resolveContext` callback: token verify + path
   * check + permission/identity re-check (former steps 1-4 of
   * `wireConnection`). A `null` return means the socket was already
   * closed with the appropriate code — the primitive sends none of its
   * own.
   */
  const authenticate = async (request: IncomingMessage, ws: WsWebSocket): Promise<PresenceConnection | null> => {
    const { pathname, query } = splitUrl(request.url ?? '');
    const token = new URLSearchParams(query).get('token') ?? '';

    // 1. token present + verifies (signature, issuer, schema).
    const claims = token.length > 0 ? presenceTokenUtil.verifyPresenceToken(token) : null;
    if (!claims) {
      debug('reject: presence token missing / invalid');
      ws.close(INVALID_TOKEN, 'invalid token');
      return null;
    }

    // 2. `/presence/<pageId>` path segment, when present, must match
    //    the token. The bare `/presence` form is also accepted (the
    //    token is the authoritative pageId source).
    const pathSegment = pathname.startsWith(`${PRESENCE_PATH}/`) ? pathname.slice(PRESENCE_PATH.length + 1) : '';
    if (pathSegment.length > 0 && pathSegment !== claims.pageId) {
      debug('reject: path pageId %s != token pageId %s', pathSegment, claims.pageId);
      ws.close(INVALID_TOKEN, 'invalid token');
      return null;
    }

    // 3. re-check read permission (token was minted up to 5 min ago).
    const permitted = await hasReadPermission(claims.pageId, claims.userId);
    if (!permitted) {
      debug('reject: user %s lost read grant on page %s', claims.userId, claims.pageId);
      ws.close(NO_ACCESS, 'no access');
      return null;
    }

    const identity = await loadViewerIdentity(claims.userId);
    if (!identity) {
      debug('reject: connecting user %s not found', claims.userId);
      ws.close(NO_ACCESS, 'no access');
      return null;
    }

    return {
      ws,
      userId: claims.userId,
      pageId: claims.pageId,
      permittedUntil: Date.now() + PERMISSION_CACHE_TTL_MS,
      identity,
    };
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
        conn.ws.close(NO_ACCESS, 'no access');
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
   * `attachWsNamespace`'s `onOpen`: former steps 5-6 of `wireConnection`
   * (register + join). Runs after `authenticate` resolved and the
   * primitive confirmed the socket is still open.
   */
  const openConnection = async (ws: WsWebSocket, conn: PresenceConnection): Promise<void> => {
    connections.set(ws, conn);
    ws.on('message', (data: Buffer | ArrayBuffer) => {
      void handleClientMessage(conn, data);
    });

    // Register the viewer. `join` publishes a viewer-list change, which
    // flows back through `onViewersChanged` → `broadcastViewers`, so
    // this socket (and every other on the page) gets the fresh list.
    try {
      await presence.join(conn.pageId, conn.identity);
    } catch (err) {
      console.warn(`[crowi:presence] join failed for page ${conn.pageId}:`, (err as Error).message);
    }

    // The socket closed while `join` was in flight. The primitive's own
    // close listener (registered right before this `onOpen` call) will
    // have already run `handleClose` once — this reconciles by running
    // it again now that `join` is guaranteed to have settled, in case
    // `join` raced a premature `leave` and re-wrote the entry.
    if (ws.readyState !== ws.OPEN) {
      debug('presence socket closed during join user=%s page=%s', conn.userId, conn.pageId);
      void handleClose(conn);
      return;
    }

    debug('presence connected user=%s page=%s', conn.userId, conn.pageId);
  };

  const wsNamespace = attachWsNamespace<PresenceConnection>(httpServer, {
    path: PRESENCE_PATH,
    resolveContext: authenticate,
    onOpen: (ws, conn) => {
      void openConnection(ws, conn);
    },
    onClose: (conn) => {
      void handleClose(conn);
    },
    politeClose: politeCloseWithReason(SHUTDOWN, 'server shutting down'),
  });

  debug('presence attached to http.Server (path=%s)', PRESENCE_PATH);

  let didShutdown = false;
  return {
    async shutdown() {
      if (didShutdown) return;
      didShutdown = true;

      // Stop reacting to viewer-list + page-updated + comment-changed
      // changes BEFORE the drain sequence starts closing sockets.
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
      try {
        unsubscribeCommentChanged();
      } catch {
        // best-effort
      }

      // off upgrade → politely close every live socket → drain wait →
      // force-terminate stragglers → wss.close().
      await wsNamespace.shutdown();

      // Tear down the presence service's pub/sub subscriber.
      try {
        await presence.shutdown();
      } catch (err) {
        console.error('[crowi:presence] presence.shutdown failed:', err);
      }
    },
  };
}
