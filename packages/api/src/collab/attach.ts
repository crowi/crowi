import type { Server as HttpServer, IncomingMessage } from 'node:http';
// Runtime values are loaded lazily inside `attachCollabServer` so the
// transitive `crossws` ESM-only dependency of `@hocuspocus/server`
// doesn't break Jest at test-collect time. Only TS types are imported
// statically here (type imports are erased at runtime).
import type {
  CollabContentSequenceAllocator,
  CollabDraftPublisher,
  CollabModels,
  CollabPageEventPublisher,
  CollabWsTokenUtil,
  EditorCapCounter,
  InvalidateReason,
} from '@crowi/collab';
import type { Extension } from '@hocuspocus/server';
import Debug from 'debug';
import type Crowi from 'src/crowi';
import { publishDraftPage } from 'src/service/page-history/commands/publish-draft';
import { allocateContentSequence } from 'src/service/page-history/content-sequence';
import { createPresenceCollabDeps } from 'src/service/presence';
import { getEditorCapCounter } from 'src/util/collab-cap';
import { isMultiInstanceDeclared } from 'src/util/env-schema';
import { createWsTokenUtil, isWsTokenSecretFromEnv } from 'src/util/ws-token';
import { attachWsNamespace } from 'src/ws/attach-namespace';
import type { WebSocket as WsWebSocket } from 'ws';
import { buildCollabRedisExtension } from './extension-redis';

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
  /**
   * feature-editor-preview-reliability G1 — invalidate the live collab
   * doc(s) for the given pages after an external edit committed (an HTTP /
   * MCP / in-process `Page.updatePage` that nulled `yjsState` + bumped
   * `currentRevision`). Broadcasts `crowi:force-reload`, tombstones the doc
   * base so an in-flight stale save CONFLICTs, gates new connections during
   * the drain, and force-closes the stale connections after a short grace.
   *
   * In-process / single-instance ONLY: a live doc on a DIFFERENT replica is
   * not reachable here (RFC-0003 §5b — documented limitation). Best-effort:
   * never throws back into the triggering write.
   */
  invalidatePages(pageIds: string[], reason: InvalidateReason): Promise<void>;
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
/**
 * Explicit "I run more than one api replica" declaration. This is the
 * GENUINE multi-instance signal the WS_TOKEN_SECRET boot guard keys off —
 * NOT the mere presence of `REDIS_URL` (E1): Redis is configured in plenty
 * of single-replica deployments (sessions / Socket.IO), so failing on
 * `REDIS_URL` alone over-triggers. Any truthy value (`1`, `true`, a replica
 * count > 1) declares multi-instance. Truth table lives in
 * `src/util/env-schema.ts#isMultiInstanceDeclared` — also consumed by the
 * federated-link completion store's topology selection.
 */
const MULTI_INSTANCE_ENV = 'CROWI_MULTI_INSTANCE';

/**
 * editor-preview-reliability §4 / E1 — fail fast when a GENUINELY
 * multi-instance deployment is missing a stable `WS_TOKEN_SECRET`.
 *
 * A per-process random `WS_TOKEN_SECRET` is fatal across replicas: replica
 * B cannot verify a token minted by replica A, so half the connections
 * silently fail `onAuthenticate` and users see "WebSocket closed before the
 * connection was established".
 *
 * E1 fix — the multi-instance signal is the EXPLICIT `CROWI_MULTI_INSTANCE`
 * declaration, not `REDIS_URL` presence. So:
 *   - single-instance dev (no declaration) boots fine even with NO
 *     `WS_TOKEN_SECRET` — `.env.example` ships no secret; the per-process
 *     random fallback is harmless for one replica (`ws-token.ts` already
 *     logged the fallback warning).
 *   - a declared multi-instance deployment with no env secret → throw to
 *     abort boot.
 *
 * `isWsTokenSecretFromEnv()` is the single source of truth for "configured"
 * — `.env.example` ships no value, so a fresh copy that never set a real
 * secret reads as "not from env" and the guard only bites once the operator
 * declares multi-instance.
 */
export function assertWsTokenSecretForMultiInstance(_crowi: Crowi): void {
  if (isWsTokenSecretFromEnv()) return;
  if (!isMultiInstanceDeclared(process.env)) return;

  throw new Error(
    `[crowi:collab] ${MULTI_INSTANCE_ENV} declares a multi-instance deployment but WS_TOKEN_SECRET is not set. ` +
      'A per-process random secret cannot be cross-verified by other api replicas, so wsToken authentication ' +
      'fails intermittently ("WebSocket closed before the connection was established"). Set WS_TOKEN_SECRET to a ' +
      'stable base64-encoded 32-byte value (`openssl rand -base64 32`) shared across all replicas, or unset ' +
      `${MULTI_INSTANCE_ENV} if you actually run a single replica.`,
  );
}

export async function attachCollabServer(httpServer: HttpServer, crowi: Crowi): Promise<AttachedCollab> {
  // editor-preview-reliability §4 — guard a multi-instance deployment
  // against a non-shared (random) wsToken secret before we wire any
  // sockets. Runs first so the failure is unambiguous at boot rather
  // than as scattered onAuthenticate rejections later.
  assertWsTokenSecretForMultiInstance(crowi);

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

  // Independent `createWsTokenUtil()` call from the one
  // `hono/handlers/page-collab.ts` builds for signing — each resolves
  // its own secret via `util/signed-token-factory.ts`, but both agree
  // on the same value (read `WS_TOKEN_SECRET` fresh from the same env,
  // or share the same process-wide random fallback when it's unset), so
  // sign / verify can never drift apart within one process. No env
  // distribution drift either way.
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
        // `revision` MUST be populated: `Page.updatePage` / `pushRevision`
        // emit the event with `revision` as the full Revision document,
        // and listeners rely on it — `events/page.ts` reads
        // `revision.body` to build backlinks, `mention-dispatch` reads
        // `revision.meta`. A bare ObjectId here makes those silently
        // no-op (the backlink builder throws "no revision/body" and the
        // error is swallowed at debug level).
        const [pageDoc, userDoc] = await Promise.all([Page.findById(payload.pageId).populate('revision').exec(), User.findById(payload.userId).exec()]);
        if (!pageDoc) {
          debug('pageEventPublisher: page %s not found, skipping emit', payload.pageId);
          return;
        }
        // Same wire shape as `Page.updatePage` / `Page.createPage` so
        // api-side listeners (events/page.ts, events/render-cache.ts,
        // events/mention-dispatch.ts) don't need a collab-specific
        // branch. The 4th arg flags "a new revision was created": a collab
        // save always pushes a new revision (save-flow Step 2), so
        // forward `true` for 'update' so events/page.ts fans out an UPDATE
        // notification on the realtime path too.
        crowi.event('Page').emit(eventName, pageDoc, userDoc, payload.bookmarkCount ?? 0, eventName === 'update');
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

  // Phase 9 — when this api process has a Redis client wired
  // (`REDIS_URL` set), attach `@hocuspocus/extension-redis` so cross-
  // instance Y.Doc updates + awareness fan out via Redis pub/sub.
  // When `crowi.redis === null` (single-instance dev) the extensions
  // array stays empty and Hocuspocus runs in standalone mode — same
  // shape as Phase 8.5 landed.
  //
  // The extension creates its own ioredis clients (pub + sub) via the
  // `createClient` callback we provide; api's existing node-redis v4
  // client is not shared (the two libraries have incompatible APIs).
  const extensions: Extension[] = [];
  const redisExtension = buildCollabRedisExtension(crowi);
  if (redisExtension !== null) {
    extensions.push(redisExtension);
  }

  // Lazy `require()` so Jest never tries to parse `crossws`'s ESM
  // bundle during test collection (the api boot graph reaches this
  // file via `src/crowi/index.ts` even when tests don't actually
  // call `start()`). The collab dist is plain CJS so the require
  // resolves cleanly under both jest and the dev runner.
  //
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const collab = require('@crowi/collab') as typeof import('@crowi/collab');
  // RFC-0005 — the api-side presence adapter so a collab connect /
  // disconnect records a short-lived editing signal (the `✏️` badge).
  // `@crowi/collab` is crowi-agnostic; this adapter resolves the
  // process-shared presence service lazily and swallows failures. It
  // also owns a periodic refresher whose timer must be stopped on
  // shutdown — hence the handle is kept (see `shutdown()` below).
  const presenceDeps = createPresenceCollabDeps(crowi);
  // RFC-0021 §D-7 (Phase 2a) — the collab library never imports
  // `@crowi/api`, so the real allocator is bound here, in the api process,
  // and handed through as a verbatim function (same shape as
  // `CollabRenderer`). `CollabContentSequenceAllocator` returns `unknown`
  // (collab never inspects the result, §D-6/§D-7), so the outcome-aware
  // debug logging the spec's operator-output contract calls for
  // (pageId/revisionId/reason only) has to happen HERE, not inside
  // `@crowi/collab`'s own generic-defensive catch around this call.
  const contentSequenceAllocator: CollabContentSequenceAllocator = async (pageId, revisionId) => {
    const outcome = await allocateContentSequence(crowi, pageId, revisionId);
    if (!outcome.allocated) {
      debug('contentSequenceAllocator: allocateContentSequence did not allocate for page %s revision %s: %s', pageId, revisionId, outcome.reason);
    }
    return outcome;
  };
  // RFC-0021 §6.3/DC-6 (Phase 2c-1) — same injection shape as
  // `contentSequenceAllocator` above: `@crowi/collab` never imports
  // `@crowi/api`, so `publishDraftPage` is bound here and handed through as
  // a verbatim function. `PageEventCommandOutcome` is a superset of what
  // `CollabDraftPublisher`'s `unknown` return promises (collab never
  // inspects it — a publish failure never fails the save, DC-1/F-5 step 5),
  // so the outcome-aware debug logging happens HERE.
  const draftPublisher: CollabDraftPublisher = async (pageId, actorId) => {
    const outcome = await publishDraftPage(crowi, { pageId, actor: actorId });
    if (outcome.status !== 'committed') {
      const reason = 'reason' in outcome ? outcome.reason : '(none)';
      debug('draftPublisher: publishDraftPage did not commit for page %s: status=%s reason=%s', pageId, outcome.status, reason);
    }
    return outcome;
  };
  const { hocuspocus, invalidator } = collab.createCollabServer({
    models,
    wsTokenUtil,
    debounce: DEFAULT_DEBOUNCE_MS,
    maxDebounce: DEFAULT_MAX_DEBOUNCE_MS,
    checkEditorCap,
    editorCapCounter,
    pageEventPublisher,
    extensions,
    presence: presenceDeps,
    contentSequenceAllocator,
    draftPublisher,
  });

  /**
   * `attachWsNamespace`'s `onOpen` — collab's `resolveContext` is the
   * identity (no attach-time auth; Hocuspocus's own `onAuthenticate` hook
   * does auth downstream, from inside `handleMessage`), so the primitive
   * hands `onOpen` the raw `IncomingMessage` as its context and calls it
   * immediately. Wires one
   * `ws.WebSocket` to its Hocuspocus `ClientConnection`. Hocuspocus
   * delivers events into the connection via `handleMessage` /
   * `handleClose` — when running through the `Server` wrapper (crossws)
   * it's done by the adapter; here we do it manually so the dependency
   * on `ws` stays narrow.
   *
   * Buffer → Uint8Array: the default `binaryType` for the `ws`
   * server is `nodebuffer`, and Hocuspocus expects `Uint8Array` in
   * `handleMessage`. `Buffer` inherits from `Uint8Array` so a
   * direct pass-through is structurally valid, but we coerce
   * explicitly so a future `binaryType` flip stays safe.
   *
   * No `ws.on('error', ...)` here — the primitive already registers a
   * generic one (before `onOpen` runs) so a single bad socket can never
   * crash the process.
   */
  const onOpen = (ws: WsWebSocket, request: IncomingMessage): void => {
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
      clientConnection.handleClose({ code, reason: reason?.toString?.() ?? '' });
    });
  };

  const wsNamespace = attachWsNamespace<IncomingMessage>(httpServer, {
    path: COLLAB_PATH,
    // Identity resolver — collab does no attach-time auth (Hocuspocus owns
    // it via its own `onAuthenticate` hook, invoked downstream from
    // `onOpen`), so every upgrade is accepted with the raw request as its
    // context.
    resolveContext: async (request) => request,
    onOpen,
    // Ask Hocuspocus to close connections politely. The primitive calls this
    // once per currently-open connection, but `closeConnections()` is
    // Hocuspocus's own engine-wide API (no single-connection variant) — it
    // already closes ALL connections, so a one-shot guard runs it exactly once
    // instead of O(N) times (each of which re-walks every connection). Clients
    // see a normal close frame and can flush their last `update` before
    // disconnecting, which `afterDrain`'s flush then persists.
    politeClose: (() => {
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        hocuspocus.closeConnections();
      };
    })(),
    // Flush any in-flight `onStoreDocument` debounces once sockets have
    // had the drain window to deliver their final updates, before
    // stragglers are force-terminated. The next-after-debounce
    // `onStoreDocument` actually runs before we drop references to the
    // Y.Docs.
    afterDrain: () => {
      hocuspocus.flushPendingStores();
    },
  });

  debug('collab attached to http.Server (path=%s)', COLLAB_PATH);

  let didShutdown = false;
  return {
    async invalidatePages(pageIds, reason) {
      await invalidator.invalidatePages(pageIds, reason);
    },
    async shutdown() {
      // Re-entry from a second SIGINT (operator impatient with Ctrl-C)
      // or from app.ts orchestration. The first call owns the teardown.
      if (didShutdown) return;
      didShutdown = true;

      // off upgrade → closeConnections (politely) → drain wait →
      // flushPendingStores → force-terminate stragglers → wss.close().
      await wsNamespace.shutdown();

      // Stop the RFC-0005 presence editing-hash refresher so its
      // `setInterval` does not outlive the collab engine. The timer is
      // already `.unref()`-d (it never blocks process exit), but a test
      // harness that calls `shutdown()` and keeps the process alive
      // would otherwise see it tick on.
      try {
        presenceDeps.shutdown();
      } catch (err) {
        console.error('[crowi:collab] presence refresher shutdown failed:', err);
      }

      // Disconnect the cap counter last. With a shared `crowi.redis`
      // this is a documented no-op, but we still await it so a
      // future per-counter client doesn't silently regress this
      // ordering.
      //
      // Note (Phase 9): registered Hocuspocus extensions
      // (`@hocuspocus/extension-redis`) define `onDestroy` lifecycle
      // hooks, but the pure `Hocuspocus` engine we use here doesn't
      // expose a `destroy()` method — only the wrapping `Server`
      // class (= the crossws adapter we replaced with our own ws
      // attach) calls extension `onDestroy`. The extension's pub +
      // sub ioredis clients therefore live until process exit,
      // which the OS reaps along with everything else. Test
      // harnesses that call `shutdown()` and keep the process alive
      // are the only ones that observe the leak; jest exits its
      // worker after the suite anyway, so this is acceptable.
      try {
        await editorCapCounter.disconnect();
      } catch (err) {
        console.error('[crowi:collab] editorCapCounter.disconnect failed during shutdown:', err);
      }
    },
  };
}
