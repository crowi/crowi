import { Server } from '@hocuspocus/server';
import Debug from 'debug';
import type { CollabModels } from './models';
import type { CollabContext } from './types';
import type { CollabWsTokenUtil } from './ws-token';
import { createOnAuthenticate, type OnAuthenticateDeps } from './hooks/on-authenticate';
import { createOnLoadDocument } from './hooks/on-load-document';
import { createOnStoreDocument } from './hooks/on-store-document';
import { createOnChange } from './hooks/on-change';
import { createOnStateless } from './hooks/on-stateless';
import { createOnAwarenessUpdate } from './hooks/on-awareness-update';
import { createOnDisconnect } from './hooks/on-disconnect';
import { createCompactor } from './compaction';
import { createContributorsTracker, type ContributorsTracker } from './contributors';
import { createSaveFlow, type SaveFlow } from './save-flow';
import { type CollabPageEventPublisher } from './page-event-pubsub';
import { markEditing } from './presence';
import { type EditorCapCounter, noopEditorCapCounter } from './editor-cap';

const debug = Debug('crowi:collab:server');

/**
 * No-op publisher used as the default when `createCollabServer` is
 * constructed without one (tests that don't care about pub/sub). The
 * production boot path passes the real publisher in via
 * `startCollabServer`.
 */
const noopPageEventPublisher: CollabPageEventPublisher = {
  instanceId: 'noop',
  async publish() {
    /* drop */
  },
  async disconnect() {
    /* nothing */
  },
};

export interface CreateCollabServerOptions {
  models: CollabModels;
  wsTokenUtil: CollabWsTokenUtil;
  /** Port for the Hocuspocus HTTP/WebSocket server. Tests pass `0` for ephemeral. */
  port: number;
  /** Bind address. Defaults to `0.0.0.0`. */
  address?: string;
  /** Silence Hocuspocus's start screen — true in production / tests. */
  quiet?: boolean;
  /**
   * Hocuspocus `debounce` (ms). Tests pass a small value so
   * `onStoreDocument` fires before `disconnect`+await completes;
   * production keeps the default 2000 ms.
   */
  debounce?: number;
  /** Hocuspocus `maxDebounce` (ms). Tests pass a small value. */
  maxDebounce?: number;
  /**
   * Override the cap check (Phase 6 swaps the Redis-backed
   * implementation in via this seam). Defaults to the stub from the
   * api dist.
   */
  checkEditorCap?: OnAuthenticateDeps['checkEditorCap'];
  /**
   * Phase 5: Redis publisher for `crowi:pageEvent:*`. Defaults to a
   * no-op publisher so tests / single-instance deployments work
   * without Redis. `startCollabServer` injects the real publisher.
   */
  pageEventPublisher?: CollabPageEventPublisher;
  /**
   * Phase 5: pre-built contributors tracker. Tests pass their own so
   * they can pre-seed awareness ids; production code lets the server
   * build a fresh tracker per instance.
   */
  contributorsTracker?: ContributorsTracker;
  /**
   * Phase 5: pre-built save flow. Tests inject a mock; production lets
   * the server build one from `models` + tracker + publisher.
   */
  saveFlow?: SaveFlow;
  /**
   * Phase 6: Redis-backed editor cap counter. Acquires a slot on
   * `onAuthenticate` (write-side cap defence-in-depth) and releases
   * on `onDisconnect`. Defaults to a no-op counter so tests and
   * single-instance dev deployments work without Redis; production
   * boot path (`startCollabServer`) injects the real counter built
   * via `createCollabEditorCapCounter`.
   */
  editorCapCounter?: EditorCapCounter;
}

/**
 * Build a Hocuspocus `Server` wired to Crowi's models. Listen is
 * separate (`server.listen()`) so callers can inspect the address
 * before / after binding — especially useful in tests that need to
 * discover the random port.
 *
 * Server-level `stopOnSignals: false` because the parent
 * `startCollabServer` (in `index.ts`) registers its own graceful
 * shutdown that also disconnects Mongoose. Letting Hocuspocus call
 * `process.exit(0)` would skip the mongoose teardown.
 *
 * Phase 4 wires the `onChange` firehose + a single shared `compactor`
 * across both `onChange` (count trigger) and `onStoreDocument` (time
 * trigger + debounce-driven checkpoint). Sharing the compactor is
 * load-bearing: its in-memory `inflight` Set is what de-duplicates
 * a count-trigger compaction racing a store-trigger checkpoint for
 * the same page.
 */
export function createCollabServer(opts: CreateCollabServerOptions): Server<CollabContext> {
  const { models, wsTokenUtil, port, address, quiet, debounce, maxDebounce, checkEditorCap } = opts;
  const pageEventPublisher = opts.pageEventPublisher ?? noopPageEventPublisher;
  const contributorsTracker = opts.contributorsTracker ?? createContributorsTracker();
  const editorCapCounter = opts.editorCapCounter ?? noopEditorCapCounter;
  const saveFlow =
    opts.saveFlow ??
    createSaveFlow({
      models,
      contributorsTracker,
      pageEventPublisher,
    });

  const compactor = createCompactor({
    models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate },
  });

  const baseOnAuthenticate = createOnAuthenticate({
    wsTokenUtil,
    models: { Page: models.Page },
    checkEditorCap,
    editorCapCounter,
  });
  const onDisconnect = createOnDisconnect({ editorCapCounter });
  /**
   * Wrap `onAuthenticate` so we can fire-and-forget the presence
   * stub once authentication succeeds. `markEditing` is a no-op stub
   * in Phase 5 (real implementation lands with RFC-0005); calling it
   * here pins the swap point so RFC-0005 lands without changing
   * collab. Errors are swallowed because presence is purely
   * advisory — a failure must never block a connection.
   */
  const onAuthenticate = async (payload: Parameters<typeof baseOnAuthenticate>[0]): Promise<CollabContext> => {
    const ctx = await baseOnAuthenticate(payload);
    void markEditing(ctx.pageId, ctx.userId).catch((err: unknown) => {
      console.warn('[crowi:collab] presence.markEditing failed (non-blocking):', (err as Error).message);
    });
    return ctx;
  };

  const onLoadDocument = createOnLoadDocument({
    models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
  });
  const onStoreDocument = createOnStoreDocument({
    models: { Page: models.Page },
    compactor,
  });
  const onChange = createOnChange({
    models: { PageYjsUpdate: models.PageYjsUpdate },
    compactor,
  });
  const onStateless = createOnStateless({ saveFlow });
  const onAwarenessUpdate = createOnAwarenessUpdate({ contributorsTracker });

  const server = new Server<CollabContext>({
    name: 'crowi-collab',
    port,
    address: address ?? '0.0.0.0',
    quiet: quiet ?? false,
    debounce: debounce ?? 2000,
    maxDebounce: maxDebounce ?? 10000,
    // Pin Hocuspocus's v4 default explicitly so a future upgrade
    // can't silently flip it. Collab is a long-running worker and
    // we want every idle Y.Doc released as soon as its last client
    // disconnects — otherwise active-page count drives memory.
    unloadImmediately: true,
    // Crowi's parent index.ts owns SIGINT/SIGTERM so it can disconnect
    // mongoose before `process.exit(0)`.
    stopOnSignals: false,
    async onAuthenticate(payload) {
      return onAuthenticate(payload);
    },
    async onLoadDocument(payload) {
      await onLoadDocument(payload);
    },
    async onChange(payload) {
      await onChange(payload);
    },
    async onStoreDocument(payload) {
      await onStoreDocument(payload);
    },
    async onStateless(payload) {
      await onStateless(payload);
    },
    async onAwarenessUpdate(payload) {
      await onAwarenessUpdate(payload);
    },
    async onDisconnect(payload) {
      await onDisconnect(payload);
    },
  });

  debug('collab server constructed (port=%d, debounce=%d/%d)', port, debounce ?? 2000, maxDebounce ?? 10000);
  return server;
}
