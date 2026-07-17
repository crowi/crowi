import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WS_CLOSE_CODES } from '@crowi/api-contract';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';

/**
 * Grace window between asking sockets to close politely and force-
 * terminating stragglers on shutdown. `collab/attach.ts` /
 * `presence/attach.ts` / `notifications/attach.ts` all agreed on 500ms
 * independently before this primitive existed; kept as the default here,
 * overridable per namespace via `options.drainMs`.
 */
const DEFAULT_DRAIN_MS = 500;

/**
 * Split a request URL into its pathname and raw query string. Exported so
 * namespaces that need the query string too (presence / notifications, for
 * their `?token=` param) share this instead of keeping their own copy.
 */
export function splitUrl(rawUrl: string): { pathname: string; query: string } {
  const queryIdx = rawUrl.indexOf('?');
  return queryIdx < 0 ? { pathname: rawUrl, query: '' } : { pathname: rawUrl.slice(0, queryIdx), query: rawUrl.slice(queryIdx + 1) };
}

/**
 * Build a `politeClose` for the common "just `ws.close(code, reason)` per
 * socket" shape — what `presence/attach.ts` and `notifications/attach.ts`
 * both need (unlike collab's engine-wide `hocuspocus.closeConnections()`,
 * which ignores its arguments entirely). The `context` parameter is typed
 * `unknown` rather than generic: the returned function ignores it, and a
 * function accepting `unknown` is assignable to any namespace's narrower
 * `politeClose: (context: TContext, ws: WsWebSocket) => void` shape.
 */
export function politeCloseWithReason(code: number, reason: string): (context: unknown, ws: WsWebSocket) => void {
  return (_context, ws) => {
    try {
      ws.close(code, reason);
    } catch {
      // ignore — best-effort
    }
  };
}

export interface AttachWsNamespaceOptions<TContext> {
  /**
   * Path this namespace answers on. The upgrade filter accepts both the
   * bare path and `${path}/...` (a document/resource id segment) — a
   * non-matching request is NOT `socket.destroy()`-ed, so sibling
   * upgrade handlers on the same `http.Server` (other namespaces) get a
   * chance to claim it.
   */
  path: string;
  /**
   * Resolve the per-connection context (e.g. verified token claims +
   * whatever the namespace needs for its business logic) from the upgrade
   * request. Return `null` to reject the connection — sending a close frame
   * with the appropriate code/reason is the CALLER's responsibility (`ws`
   * is passed in exactly so the resolver can call `ws.close(...)` itself;
   * namespaces disagree on which code means what, so the primitive never
   * picks one on their behalf).
   *
   * A namespace whose auth is handled downstream of the raw socket (collab:
   * Hocuspocus's own `onAuthenticate` hook, invoked from inside `onOpen`'s
   * `handleMessage` wiring) accepts every upgrade by returning the request
   * itself — `async (request) => request` with `TContext = IncomingMessage`
   * — rather than gating here.
   *
   * The primitive registers the socket's `close` / `error` listeners
   * BEFORE calling `resolveContext`, and re-checks `ws.readyState` the
   * moment it resolves — so a socket that disconnects mid-await is never
   * handed to `onOpen` (AC-3's race fix, generalized once here instead of
   * copy-pasted per namespace; see `presence/attach.ts`'s original
   * `wireConnection` doc comment for the phantom-connection failure mode
   * this prevents).
   */
  resolveContext: (request: IncomingMessage, ws: WsWebSocket) => Promise<TContext | null>;
  /** Called once a connection is accepted (context resolved, and still open at that point). */
  onOpen: (ws: WsWebSocket, context: TContext) => void;
  /** Called when an accepted connection's socket closes. */
  onClose?: (context: TContext) => void;
  /**
   * Invoked once per currently-tracked connection at shutdown, before
   * the drain wait (`ws.close(code, reason)` for presence /
   * notifications). A namespace whose "polite close" is a single
   * engine-wide API instead of a per-connection one (collab's
   * `hocuspocus.closeConnections()`) can just ignore both arguments —
   * calling it once per open connection is redundant but harmless
   * (closing an already-closing Hocuspocus connection is a no-op).
   * Never invoked when there are no live connections.
   */
  politeClose: (context: TContext, ws: WsWebSocket) => void;
  /**
   * Optional hook run after the drain wait, before force-terminating
   * stragglers. Exists for collab's `hocuspocus.flushPendingStores()` —
   * flushing the engine's debounced document persistence needs to run
   * after clients had their drain window to deliver a final `update`
   * frame, but before sockets are torn down. Namespaces without an
   * equivalent step omit this.
   */
  afterDrain?: () => void | Promise<void>;
  /** Grace window (ms) between `politeClose` and force-terminate. Default 500. */
  drainMs?: number;
}

export interface AttachedWsNamespace {
  /** Detach + tear down. Idempotent; safe to call from a SIGINT handler. */
  shutdown(): Promise<void>;
}

/**
 * Shared WebSocket "upgrade → accept-or-reject → track → drain-on-
 * shutdown" skeleton for a `noServer: true` namespace on the api's
 * `http.Server`. Extracted from the near-identical `wireConnection` /
 * `upgradeHandler` / `shutdown` skeletons in `collab/attach.ts`,
 * `presence/attach.ts` and `notifications/attach.ts` — see
 * `.feature-state/specs/feature-ws-namespace-attach-primitive.md` for
 * the duplication this replaces.
 *
 * What this owns:
 *   - upgrade filtering (bare/prefixed path) + `WebSocketServer({
 *     noServer: true })` + `httpServer.on('upgrade', ...)` registration.
 *   - the "register close/error before the async resolveContext await"
 *     race fix (AC-3), in one place.
 *   - a generic `error` listener so a single bad socket never crashes
 *     the process (every consumer previously re-implemented this
 *     identically).
 *   - the shutdown drain sequence: off upgrade → politeClose → wait
 *     `drainMs` → optional `afterDrain` → force-terminate stragglers →
 *     `wss.close()`.
 *
 * What this deliberately does NOT own (stays the caller's business
 * logic): per-connection state shape, join/leave or subscribe/
 * unsubscribe semantics, and any extra shutdown steps beyond the
 * generic sequence above (each namespace layers those around its own
 * call to `shutdown()` — see `presence/attach.ts` unsubscribing from
 * pub/sub before calling this, or `notifications/attach.ts` disconnecting
 * its Redis subscriber after).
 */
export function attachWsNamespace<TContext>(httpServer: HttpServer, options: AttachWsNamespaceOptions<TContext>): AttachedWsNamespace {
  const { path, resolveContext, onOpen, onClose, politeClose, afterDrain, drainMs = DEFAULT_DRAIN_MS } = options;

  // `noServer: true` — the upgrade handshake is owned by the api process;
  // we forward only `${path}` / `${path}/*` upgrades here.
  const wss = new WebSocketServer({ noServer: true });

  // Every currently-open, accepted connection. Backs the shutdown drain
  // (iterate once to `politeClose`, again to force-`terminate`
  // stragglers) — namespace-specific lookups (by pageId, by userId,
  // etc.) stay in the caller's own data structure; this map only exists
  // for the generic parts above.
  const connections = new Map<WsWebSocket, TContext>();

  // Set once `shutdown()` begins. Checked inside `wireConnection` AFTER the
  // async `resolveContext` await: a socket still resolving when shutdown drains
  // is not yet in `connections`, so it escapes politeClose/terminate — without
  // this guard it would then add itself + fire `onOpen` after shutdown already
  // returned, leaking a ghost viewer/subscription and an un-drained socket.
  let didShutdown = false;

  const wireConnection = async (ws: WsWebSocket, request: IncomingMessage): Promise<void> => {
    // Both `close` and `error` are registered BEFORE `resolveContext`
    // runs (AC-3): (a) an `error` event during the resolve round-trip
    // would otherwise crash the process (Node throws on an `'error'`
    // emit with zero listeners); (b) a `close` that fires mid-await
    // must be observed even though the "real" per-connection close
    // handler (the one that cleans up `connections` + calls
    // `onClose`) only gets attached once the connection is actually
    // accepted below — a listener attached AFTER `resolveContext`
    // resolves would never see a `close` that already fired during
    // the await. `closed` is set by this early listener and
    // re-checked the moment `resolveContext` settles, so a socket that
    // disconnects mid-await is never handed to `onOpen` (see
    // `presence/attach.ts`'s original `wireConnection` doc comment
    // for the phantom-connection failure mode this prevents).
    let closed = false;
    ws.on('close', () => {
      closed = true;
    });
    ws.on('error', (err: Error) => {
      console.error(`[crowi:ws${path}] websocket error`, err);
    });

    const context = await resolveContext(request, ws);
    if (context === null) {
      // Rejected — the caller already sent its own close frame/code.
      return;
    }
    if (closed || ws.readyState !== ws.OPEN) {
      // Disconnected while `resolveContext` was resolving — do not open.
      return;
    }
    if (didShutdown) {
      // Shutdown drained (and possibly returned) while this socket was still
      // resolving — it missed the drain, so close it now instead of adding a
      // ghost connection + firing `onOpen` post-shutdown.
      try {
        ws.close(WS_CLOSE_CODES.SHUTDOWN, 'server shutting down');
      } catch {
        // best-effort
      }
      return;
    }

    connections.set(ws, context);
    ws.on('close', () => {
      connections.delete(ws);
      onClose?.(context);
    });
    onOpen(ws, context);
  };

  /**
   * `'upgrade'` handler. Path-filter first so sibling namespaces on the
   * same `http.Server` keep their slot; `socket.destroy()` is
   * intentionally NOT called on a no-match so Node moves on to the next
   * listener.
   */
  const upgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const { pathname } = splitUrl(request.url ?? '');
    if (pathname !== path && !pathname.startsWith(`${path}/`)) {
      return; // not ours — let other upgrade handlers try.
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      void wireConnection(ws, request);
    });
  };

  httpServer.on('upgrade', upgradeHandler);

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

      // 2. Politely close every live connection, one `politeClose` call
      //    per tracked connection — each call is caught independently
      //    so one namespace-supplied callback throwing never skips the
      //    rest of the connections (or the later drain / terminate /
      //    wss.close steps).
      for (const [ws, context] of connections) {
        try {
          politeClose(context, ws);
        } catch (err) {
          console.error(`[crowi:ws${path}] politeClose failed during shutdown:`, err);
        }
      }

      // 3. Brief drain so close frames flush.
      if (connections.size > 0) {
        await new Promise<void>((resolveDrain) => setTimeout(resolveDrain, drainMs));
      }

      // 3b. Optional post-drain hook (collab: flush debounced stores).
      if (afterDrain) {
        try {
          await afterDrain();
        } catch (err) {
          console.error(`[crowi:ws${path}] afterDrain failed during shutdown:`, err);
        }
      }

      // 4. Force-terminate stragglers — again, one call per connection,
      //    caught independently so a single misbehaving socket can't
      //    prevent the others from being torn down or skip `wss.close()`.
      for (const ws of connections.keys()) {
        try {
          ws.terminate();
        } catch (err) {
          console.error(`[crowi:ws${path}] terminate failed during shutdown:`, err);
        }
      }
      connections.clear();

      // 5. Tear down the WebSocketServer itself.
      try {
        wss.close();
      } catch (err) {
        console.error(`[crowi:ws${path}] wss.close failed during shutdown:`, err);
      }
    },
  };
}
