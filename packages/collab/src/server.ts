import { Hocuspocus, type Extension } from '@hocuspocus/server';
import Debug from 'debug';
import type { CollabModels } from './models';
import {
  type CollabContext,
  type CollabWsTokenUtil,
  type EditorCapCounter,
  noopEditorCapCounter,
  type CollabPageEventPublisher,
  noopPageEventPublisher,
} from './types';
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
import { markEditing } from './presence';

const debug = Debug('crowi:collab:server');

export interface CreateCollabServerOptions {
  models: CollabModels;
  wsTokenUtil: CollabWsTokenUtil;
  /**
   * Hocuspocus `debounce` (ms). Tests pass a small value so
   * `onStoreDocument` fires before `disconnect`+await completes;
   * production keeps the default 2000 ms.
   */
  debounce?: number;
  /** Hocuspocus `maxDebounce` (ms). Tests pass a small value. */
  maxDebounce?: number;
  /**
   * Override the cap check (Phase 6 Redis-backed peek). Defaults to a
   * permissive `readonly: false` so tests / single-instance dev
   * deployments work without Redis.
   */
  checkEditorCap?: OnAuthenticateDeps['checkEditorCap'];
  /**
   * Cross-process page-event publisher. After RFC-0003 Phase 9
   * (in-process attach) the host api process wires an in-process
   * adapter that re-emits onto `crowi.event('Page')`. Tests pass a
   * mock; defaults to a no-op so unit tests on the hooks themselves
   * don't need to think about fan-out.
   */
  pageEventPublisher?: CollabPageEventPublisher;
  /**
   * Pre-built contributors tracker. Tests pass their own so they can
   * pre-seed awareness ids; production code lets the server build a
   * fresh tracker per instance.
   */
  contributorsTracker?: ContributorsTracker;
  /**
   * Pre-built save flow. Tests inject a mock; production lets the
   * server build one from `models` + tracker + publisher.
   */
  saveFlow?: SaveFlow;
  /**
   * Phase 6 — Redis-backed editor cap counter. Acquires a slot on
   * `onAuthenticate` (write-side cap defence-in-depth) and releases
   * on `onDisconnect`. Defaults to a no-op counter so tests and
   * single-instance dev deployments work without Redis; the api boot
   * (`attachCollabServer`) injects the real counter built via
   * `createEditorCapCounter`.
   */
  editorCapCounter?: EditorCapCounter;
  /**
   * Phase 9 — Hocuspocus extensions injected as-is into the engine.
   * The collab package does **not** import `@hocuspocus/extension-redis`
   * itself (keeping its dep surface small and its test load light);
   * the api-side `attachCollabServer` constructs the Redis extension
   * when `crowi.redis` is available and passes it through here.
   * Defaults to `[]` so single-instance dev deployments and unit
   * tests run unchanged.
   */
  extensions?: Array<Extension>;
}

/**
 * Build a Hocuspocus engine instance wired to Crowi's models. Unlike
 * the upstream `Server` class (which owns its own HTTP server),
 * `Hocuspocus` is a pure engine with no listen / port concerns — the
 * host api process attaches it to the existing Express http.Server
 * via the `ws` lib's `noServer` mode (see `@crowi/api`'s
 * `attachCollabServer`).
 *
 * Phase 4 wires the `onChange` firehose + a single shared `compactor`
 * across both `onChange` (count trigger) and `onStoreDocument` (time
 * trigger + debounce-driven checkpoint). Sharing the compactor is
 * load-bearing: its in-memory `inflight` Set is what de-duplicates
 * a count-trigger compaction racing a store-trigger checkpoint for
 * the same page.
 */
export function createCollabServer(opts: CreateCollabServerOptions): Hocuspocus<CollabContext> {
  const { models, wsTokenUtil, debounce, maxDebounce, checkEditorCap } = opts;
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

  const hocuspocus = new Hocuspocus<CollabContext>({
    name: 'crowi-collab',
    debounce: debounce ?? 2000,
    maxDebounce: maxDebounce ?? 10000,
    // Pin Hocuspocus's v4 default explicitly so a future upgrade
    // can't silently flip it. Collab is a long-running worker and
    // we want every idle Y.Doc released as soon as its last client
    // disconnects — otherwise active-page count drives memory.
    unloadImmediately: true,
    // Pass-through for host-injected extensions (e.g. the api side's
    // `@hocuspocus/extension-redis` for cross-instance pub/sub).
    extensions: opts.extensions ?? [],
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

  debug('collab Hocuspocus engine constructed (debounce=%d/%d)', debounce ?? 2000, maxDebounce ?? 10000);
  return hocuspocus;
}
