import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import Debug from 'debug';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';
// Runtime values are loaded lazily inside `attachCollabServer` so the
// transitive `crossws` ESM-only dependency of `@hocuspocus/server`
// doesn't break Jest at test-collect time. Only TS types are imported
// statically here (type imports are erased at runtime).
import type { CollabModels, CollabPageEventPublisher, EditorCapCounter, CollabWsTokenUtil } from '@crowi/collab';
import type Crowi from 'src/crowi';
import { getEditorCapCounter } from 'src/util/collab-cap';
import { createWsTokenUtil } from 'src/util/ws-token';

const debug = Debug('crowi:collab:attach');

/**
 * Path namespace the Hocuspocus engine answers on. HocuspocusProvider
 * uses `url` verbatim as the WebSocket endpoint and sends the document
 * name (= pageId) through the protocol after the handshake, so the
 * path the browser hits is `/collab` (no document segment). The
 * upgrade filter accepts both `/collab` and `/collab/...` so future
 * variants that *do* include the document in the path keep working,
 * and so sibling WebSocket handlers (socket.io etc.) can coexist on
 * the same listener.
 */
const COLLAB_PATH = '/collab';

/**
 * Default Hocuspocus debounce window (ms) — matches the upstream v4
 * default (`debounce: 2000`). Re-declared here so the api-side attach
 * can pin it explicitly without importing private upstream constants.
 */
const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_MAX_DEBOUNCE_MS = 10000;

/**
 * Graceful-drain window between asking sockets to close politely and
 * force-terminating any stragglers. Clients normally close within a
 * round-trip; this gives them ~500 ms to flush their final `update`
 * frame before SIGINT kicks them off.
 */
const SHUTDOWN_DRAIN_MS = 500;

/**
 * Public surface returned from `attachCollabServer`. The api boot
 * keeps the handle so SIGINT teardown can flush pending stores,
 * destroy the engine, and disconnect the cap counter before mongoose
 * shuts down.
 */
export interface AttachedCollab {
  /**
   * Detach + tear down the Hocuspocus engine. Idempotent and safe to
   * call from a SIGINT handler that also calls other shutdown hooks.
   * `flushPendingStores` is fired so the next-after-debounce
   * `onStoreDocument` actually runs before the engine drops references
   * to live Y.Docs.
   */
  shutdown(): Promise<void>;
}

/**
 * Wire the `@crowi/collab` Hocuspocus engine into the api's existing
 * Express http.Server. The engine handles `ws://<api-host>/collab/:pageId?token=<wsToken>`
 * via the `ws` library's `noServer` mode — same Node process, same
 * event loop, same Mongoose connection, same Redis client.
 *
 * Replaces the standalone `@crowi/collab` CLI from RFC-0003 Phase 3-8.
 * The motivation + design lives in `.feature-state/specs/feature-collab-embed-into-api.md`.
 *
 * Boot order: must be called **after** `setupModels` + `setupRenderer`
 * (renderer pipeline is read by `Revision.prepareRevision` from the
 * save flow). The api's `Crowi.start` invokes this right before
 * `server.listen`.
 */
export async function attachCollabServer(httpServer: HttpServer, crowi: Crowi): Promise<AttachedCollab> {
  // Reach for the api-side models — they were already wired by
  // `setupModels` against the same Mongoose connection collab will
  // use, so save / load / compaction all operate on the same row
  // identities the HTTP path observes.
  const models: CollabModels = {
    Page: crowi.model('Page'),
    Revision: crowi.model('Revision'),
    PageYjsUpdate: crowi.model('PageYjsUpdate'),
    User: crowi.model('User'),
    PluginRenderCache: crowi.model('PluginRenderCache'),
  };

  // Same sign+verify pair the wsToken HTTP handler uses. In the
  // RFC-0003 same-process attach world, the api signs in
  // `routes/ts-rest/page-collab.ts` and verifies here against the
  // **same closure-captured secret** — no env distribution drift.
  const wsTokenUtil: CollabWsTokenUtil = createWsTokenUtil();

  // Process-wide cap counter shared with the wsToken HTTP handler
  // (`util/collab-cap.ts:checkEditorCap`). Both call sites route
  // through `getEditorCapCounter(crowi)` so sign-time `peek` and
  // connect-time `tryAcquire` operate on the same instance — one
  // Redis client, one cap key, one in-process cache. When
  // `crowi.redis` is null (REDIS_URL unset) the counter degrades to
  // its built-in no-op shape (same fail-open posture as Phase 6).
  const editorCapCounter: EditorCapCounter = await getEditorCapCounter(crowi);

  // pageEvent in-process adapter: the collab save flow publishes
  // `update` after a successful checkpoint, and we forward it to the
  // api's local `EventEmitter` so render-cache invalidation /
  // mention-dispatch / search indexing react as if the save had
  // happened over HTTP. Re-fetching Page + User mirrors what the
  // cross-process subscriber did in `service/page-event-pubsub.ts`,
  // so listeners can read the latest state without worrying about
  // BSON ↔ JSON round-trips dropping fields.
  const pageEventPublisher: CollabPageEventPublisher = {
    async publish(eventName, payload) {
      try {
        const Page = crowi.model('Page');
        const User = crowi.model('User');
        const [pageDoc, userDoc] = await Promise.all([Page.findById(payload.pageId).exec(), User.findById(payload.userId).exec()]);
        if (!pageDoc) {
          debug('pageEventPublisher: page %s not found, skipping emit', payload.pageId);
          return;
        }
        // Same wire shape as `Page.updatePage` / `Page.createPage` so
        // api-side listeners (events/page.ts, events/render-cache.ts,
        // events/mention-dispatch.ts) don't need a collab-specific
        // branch.
        crowi.event('Page').emit(eventName, pageDoc, userDoc, payload.bookmarkCount ?? 0);
        debug('pageEventPublisher: emitted %s for page %s', eventName, payload.pageId);
      } catch (err) {
        // Save already committed — fan-out is best-effort.
        console.warn(`[crowi:collab] pageEventPublisher.publish failed for page ${payload.pageId}:`, (err as Error).message);
      }
    },
  };

  // Phase 6 cap peek used by `on-authenticate`. The collab hook OR's
  // this peek result with the token's readonly bit, so a Redis-reported
  // cap-reached reading downgrades the connection to readonly even
  // when the token was minted editable. Same `peek` implementation
  // the wsToken endpoint uses → no drift between sign-time and
  // connect-time cap state.
  const checkEditorCap = async (pageId: string): Promise<{ readonly: boolean }> => {
    const { count, cap } = await editorCapCounter.peek(pageId);
    return { readonly: count >= cap };
  };

  // Lazy `require()` so Jest never tries to parse `crossws`'s ESM
  // bundle during test collection (the api boot graph reaches this
  // file via `src/crowi/index.ts` even when tests don't actually
  // call `start()`). The collab dist is plain CJS so the require
  // resolves cleanly under both jest and the dev runner.
  //
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const collab = require('@crowi/collab') as typeof import('@crowi/collab');
  const hocuspocus = collab.createCollabServer({
    models,
    wsTokenUtil,
    debounce: DEFAULT_DEBOUNCE_MS,
    maxDebounce: DEFAULT_MAX_DEBOUNCE_MS,
    checkEditorCap,
    editorCapCounter,
    pageEventPublisher,
  });

  // `noServer: true` — the upgrade handshake is owned by the api
  // process; we forward only `/collab/*` upgrades into Hocuspocus.
  const wss = new WebSocketServer({ noServer: true });

  // Track sockets so `shutdown` can terminate any still-open
  // connections without waiting for them to drain (test harnesses
  // / abnormal client behaviour leave sockets in CLOSE_WAIT
  // otherwise, and `server.close()` would hang).
  const liveSockets = new Set<WsWebSocket>();

  /**
   * Wire one `ws.WebSocket` to its Hocuspocus `ClientConnection`.
   * Hocuspocus delivers events into the connection via
   * `handleMessage` / `handleClose` — when running through the
   * `Server` wrapper (crossws) it's done by the adapter; here we do
   * it manually so the dependency on `ws` stays narrow.
   *
   * Buffer → Uint8Array: the default `binaryType` for the `ws`
   * server is `nodebuffer`, and Hocuspocus expects `Uint8Array` in
   * `handleMessage`. `Buffer` inherits from `Uint8Array` so a
   * direct pass-through is structurally valid, but we coerce
   * explicitly so a future `binaryType` flip stays safe.
   */
  const wireConnection = (ws: WsWebSocket, request: IncomingMessage): void => {
    liveSockets.add(ws);
    const clientConnection = hocuspocus.handleConnection(ws as never, request as never);
    ws.on('message', (data: Buffer | ArrayBuffer) => {
      // `ws` default `binaryType: 'nodebuffer'` → Buffer (extends
      // Uint8Array, structurally compatible with Hocuspocus). The
      // ArrayBuffer branch covers `binaryType: 'arraybuffer'` if it
      // ever flips. We don't request `'fragments'` mode, so the
      // `Buffer[]` shape never reaches us.
      const view: Uint8Array = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      clientConnection.handleMessage(view);
    });
    ws.on('close', (code: number, reason: Buffer) => {
      liveSockets.delete(ws);
      clientConnection.handleClose({ code, reason: reason?.toString?.() ?? '' });
    });
    ws.on('error', (err: Error) => {
      // Don't crash the api process on a single bad socket. Mirror
      // Hocuspocus's upstream Server behaviour (`console.error` +
      // continue).
      console.error('[crowi:collab] websocket error', err);
    });
  };

  /**
   * `'upgrade'` event handler. Path filter the request first so
   * sibling upgrade handlers (none today, but planned: socket.io for
   * notifications) keep their slots. `socket.destroy()` is **not**
   * called on a no-match — letting Node.js move on to the next
   * registered listener is the documented behaviour for cooperating
   * upgrade handlers.
   */
  const upgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // HTTP request lines look like `/path?query` — strip at the
    // first `?` to get the pathname. A full WHATWG URL parse here
    // would allocate on every upgrade for no extra correctness.
    const rawUrl = request.url ?? '';
    const queryIdx = rawUrl.indexOf('?');
    const pathname = queryIdx < 0 ? rawUrl : rawUrl.slice(0, queryIdx);
    // Accept the bare path (`/collab`, what HocuspocusProvider hits
    // today) and the namespaced path (`/collab/anything`) — leaves
    // room for a future variant that includes the document name in
    // the URL without forcing a server-side migration.
    if (pathname !== COLLAB_PATH && !pathname.startsWith(`${COLLAB_PATH}/`)) {
      // Not ours — let other handlers attempt the upgrade.
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wireConnection(ws, request);
    });
  };

  httpServer.on('upgrade', upgradeHandler);
  debug('collab attached to http.Server (path=%s)', COLLAB_PATH);

  let didShutdown = false;
  return {
    async shutdown() {
      // Re-entry from a second SIGINT (operator impatient with Ctrl-C)
      // or from app.ts orchestration. The first call owns the teardown.
      if (didShutdown) return;
      didShutdown = true;

      // 1. Refuse new connections first so the rest of the sequence
      //    operates on a closed front door — no `'upgrade'` event can
      //    add to `liveSockets` while we drain.
      try {
        httpServer.off('upgrade', upgradeHandler);
      } catch {
        // best-effort — the api may already be tearing the server down
      }

      // 2. Ask Hocuspocus to close connections politely. Clients see
      //    a normal close frame and can flush their last `update`
      //    message to the server before they disconnect — which the
      //    next step then persists.
      try {
        hocuspocus.closeConnections();
      } catch (err) {
        console.error('[crowi:collab] closeConnections failed during shutdown:', err);
      }

      // 3. Brief drain window so any in-flight client `update` frames
      //    actually deliver before we terminate sockets. Cheap insurance
      //    against the "SIGINT mid-edit" data-loss window.
      if (liveSockets.size > 0) {
        await new Promise<void>((resolveDrain) => setTimeout(resolveDrain, SHUTDOWN_DRAIN_MS));
      }

      // 4. Flush any in-flight `onStoreDocument` debounces now that
      //    sockets have had a chance to deliver their final updates.
      //    The next-after-debounce `onStoreDocument` actually runs
      //    before we drop references to the Y.Docs.
      try {
        hocuspocus.flushPendingStores();
      } catch (err) {
        console.error('[crowi:collab] flushPendingStores failed during shutdown:', err);
      }

      // 5. Force-terminate any straggler sockets. Required because
      //    `wss.close()` waits for normal close handshakes otherwise,
      //    which can hang on abnormal teardown (test harness with a
      //    dropped client, mis-behaving browser).
      try {
        for (const ws of liveSockets) {
          try {
            ws.terminate();
          } catch {
            // ignore — best-effort
          }
        }
        liveSockets.clear();
        wss.close();
      } catch (err) {
        console.error('[crowi:collab] wss.close failed during shutdown:', err);
      }

      // 6. Disconnect the cap counter last. With a shared `crowi.redis`
      //    this is a documented no-op, but we still await it so a
      //    future per-counter client doesn't silently regress this
      //    ordering.
      try {
        await editorCapCounter.disconnect();
      } catch (err) {
        console.error('[crowi:collab] editorCapCounter.disconnect failed during shutdown:', err);
      }
    },
  };
}
