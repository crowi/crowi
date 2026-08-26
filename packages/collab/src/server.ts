import { type Extension, Hocuspocus } from '@hocuspocus/server';
import Debug from 'debug';
import { createCompactor } from './compaction';
import { type ContributorsTracker, createContributorsTracker } from './contributors';
import { createDocBaseRevisionStore } from './doc-base-revision';
import { createDocEpochStore } from './doc-epoch';
import { createOnAuthenticate, type OnAuthenticateDeps } from './hooks/on-authenticate';
import { createOnAwarenessUpdate } from './hooks/on-awareness-update';
import { createOnChange } from './hooks/on-change';
import { createOnDisconnect } from './hooks/on-disconnect';
import { createOnLoadDocument } from './hooks/on-load-document';
import { createOnStateless } from './hooks/on-stateless';
import { createOnStoreDocument } from './hooks/on-store-document';
import { createInvalidatedPagesStore, createPageInvalidator, type PageInvalidator } from './invalidation';
import type { CollabContentSequenceAllocator, CollabDraftPublisher, CollabModels } from './models';
import { noopPresenceHooks, type PresenceHooks } from './presence';
import { wrapOnAuthenticateWithPresence, wrapOnDisconnectWithPresence } from './presence-wiring';
import { createSaveFlow, type SaveFlow } from './save-flow';
import {
  type CollabContext,
  type CollabPageEventPublisher,
  type CollabWsTokenUtil,
  type EditorCapCounter,
  noopEditorCapCounter,
  noopPageEventPublisher,
} from './types';

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
  /**
   * RFC-0005 — page-presence integration. `@crowi/collab` is
   * crowi-agnostic, so the api injects an adapter (backed by
   * `service/presence.ts`'s Redis viewer hash + pub/sub) here.
   * `onAuthenticate` fires `markEditing`, `onDisconnect` fires
   * `unmarkEditing`, both fire-and-forget so a presence failure can
   * never block a collab connection. Defaults to a no-op so unit
   * tests and single-instance dev without the api presence service
   * run unchanged.
   */
  presence?: PresenceHooks;
  /**
   * G1 — drain grace (ms) between the force-reload broadcast and forcing the
   * stale connections closed during an external-edit invalidation. Defaults
   * to {@link DEFAULT_INVALIDATE_GRACE_MS}. Tests pass a small value (or a
   * synchronous `invalidateSchedule`) to drive the drain deterministically.
   */
  invalidateGraceMs?: number;
  /**
   * G1 — schedule the post-grace close. Defaults to `setTimeout`. Tests
   * inject a synchronous scheduler.
   */
  invalidateSchedule?: (fn: () => void, ms: number) => void;
  /**
   * RFC-0021 §D-7 (Phase 2a) — threaded straight through to
   * `createSaveFlow`. The api host process (`attachCollabServer`) injects
   * the real allocator; unset means collab never allocates a content
   * sequence (existing tests / stub configs run unchanged).
   */
  contentSequenceAllocator?: CollabContentSequenceAllocator;
  /**
   * RFC-0021 §6.3/DC-6 (Phase 2c-1) — threaded straight through to
   * `createSaveFlow`, same pass-through shape as `contentSequenceAllocator`.
   * The api host process (`attachCollabServer`) injects the real command;
   * unset means step 6b falls back to the pre-Phase-2c-1 inline `updateOne`.
   */
  draftPublisher?: CollabDraftPublisher;
}

/**
 * What `createCollabServer` returns: the Hocuspocus engine PLUS the G1
 * external-edit invalidator bound to that engine. The host api process keeps
 * the invalidator on its `AttachedCollab` handle so `Page.updatePage` (and
 * any in-process path that bumps `currentRevision` + nulls `yjsState`) can
 * call `invalidatePages([pageId], reason)` after it commits.
 */
export interface CollabEngine {
  hocuspocus: Hocuspocus<CollabContext>;
  invalidator: PageInvalidator;
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
export function createCollabServer(opts: CreateCollabServerOptions): CollabEngine {
  const { models, wsTokenUtil, debounce, maxDebounce, checkEditorCap } = opts;
  const pageEventPublisher = opts.pageEventPublisher ?? noopPageEventPublisher;
  const contributorsTracker = opts.contributorsTracker ?? createContributorsTracker();
  const editorCapCounter = opts.editorCapCounter ?? noopEditorCapCounter;
  // Round 2, Decision 1 — the server-doc save lock anchor, shared between
  // `onLoadDocument` (records each materialised doc's base revision) and the
  // save flow (compare-and-sets the page pointer against it, advances it on
  // every successful save). One store per engine so all docs in this process
  // agree on their bases.
  const docBaseRevisions = createDocBaseRevisionStore();
  // RFC-0017 Phase 1 §4.1.1 — the collab lifecycle epoch anchor, shared
  // between `onLoadDocument` (records unconditionally on every load),
  // `executeSave` (reads into the atomic CAS), `onChange` (reads to stamp
  // each appended `PageYjsUpdate` row), and the compactor (reads into its
  // `persistYjsState` checkpoints). See `doc-epoch.ts`.
  const docEpochRevisions = createDocEpochStore();
  // G1 — the external-edit invalidation tombstone store, shared between the
  // invalidator (marks a page mid-drain) and `onLoadDocument` (gates a new
  // connection so it re-materialises from the new revision body instead of
  // re-recording a doc base that would let a racing save clobber the edit).
  const invalidatedPages = createInvalidatedPagesStore();
  const saveFlow =
    opts.saveFlow ??
    createSaveFlow({
      models,
      contributorsTracker,
      pageEventPublisher,
      docBaseRevisions,
      docEpochRevisions,
      contentSequenceAllocator: opts.contentSequenceAllocator,
      draftPublisher: opts.draftPublisher,
    });

  const compactor = createCompactor({
    models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate, Revision: models.Revision },
    docEpochRevisions,
  });

  const presence = opts.presence ?? noopPresenceHooks;

  const baseOnAuthenticate = createOnAuthenticate({
    wsTokenUtil,
    models: { Page: models.Page },
    checkEditorCap,
    editorCapCounter,
  });
  const baseOnDisconnect = createOnDisconnect({ editorCapCounter });
  // RFC-0005 — wrap `onAuthenticate` / `onDisconnect` so a collab
  // connect / disconnect fires `presence.markEditing` / `unmarkEditing`
  // (the page-presence `✏️` editing badge). Both are fire-and-forget;
  // the wrapping logic lives in `presence-wiring.ts` (no Hocuspocus
  // runtime import there) so the collab Jest suite can unit-test it.
  const onAuthenticate = wrapOnAuthenticateWithPresence(baseOnAuthenticate, presence);
  const onDisconnect = wrapOnDisconnectWithPresence(baseOnDisconnect, presence);

  const onLoadDocument = createOnLoadDocument({
    models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
    docBaseRevisions,
    docEpochRevisions,
    invalidatedPages,
  });
  const onStoreDocument = createOnStoreDocument({
    models: { Page: models.Page },
    compactor,
    // Blocker 2 — share the same stores the invalidator tombstones so a
    // last-close store during an external-edit drain skips the checkpoint
    // (never re-persists the stale live doc over the external edit).
    docBaseRevisions,
    invalidatedPages,
  });
  const onChange = createOnChange({
    models: { PageYjsUpdate: models.PageYjsUpdate },
    compactor,
    docEpochRevisions,
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

  // G1 — bind the external-edit invalidator to the engine we just built so
  // the api process can drive `crowi:force-reload` + drain + tombstone for a
  // live doc after an external write commits.
  const invalidator = createPageInvalidator({
    instance: hocuspocus,
    docBaseRevisions,
    invalidatedPages,
    graceMs: opts.invalidateGraceMs,
    schedule: opts.invalidateSchedule,
  });

  debug('collab Hocuspocus engine constructed (debounce=%d/%d)', debounce ?? 2000, maxDebounce ?? 10000);
  return { hocuspocus, invalidator };
}
