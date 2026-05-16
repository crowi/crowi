/**
 * `@crowi/collab` — Hocuspocus hooks + save flow for Crowi 2.0
 * realtime collaborative editing (RFC-0003).
 *
 * After RFC-0003 Phase 9 (same-process attach), this package is a
 * pure **library**: it ships the Hocuspocus hook factories, the
 * save flow, the in-memory contributors tracker, the compactor, and
 * the shared TypeScript surfaces. The host api process (`@crowi/api`)
 * builds a `Hocuspocus` engine via `createCollabServer`, wires it to
 * the existing Express http.Server with the `ws` library's
 * `noServer` mode, and supplies a single set of Mongoose models +
 * the wsToken util + the Redis-backed editor cap counter.
 *
 * Earlier phases shipped a standalone CLI (`bin: crowi-collab`) that
 * spawned a dedicated WebSocket process; the CLI is gone — see
 * `packages/api/src/collab/attach.ts` for the integration point.
 */

export { createCollabServer, type CreateCollabServerOptions } from './server';
export {
  createSaveFlow,
  CollabSaveError,
  type SaveFlow,
  type CreateSaveFlowOptions,
  type CollabSaveErrorCode,
  type ExecuteSaveInput,
  type ExecuteSaveResult,
} from './save-flow';
export { createCompactor, type Compactor, type CompactPageDeps, type CompactPageResult } from './compaction';
export { createContributorsTracker, type ContributorsTracker } from './contributors';
export { type PresenceHooks, noopPresenceHooks } from './presence';
export { CONTENT_FIELD } from './yjs-doc';
export { payloadToUint8Array } from './yjs-payload';

// Hook factories — exported so the host can compose alternate
// pipelines (Phase 9 attach uses `createCollabServer`, but tests and
// future variants may want to wire hooks individually).
export { createOnAuthenticate, type OnAuthenticateDeps } from './hooks/on-authenticate';
export { createOnLoadDocument, type OnLoadDocumentDeps, type ForceReloadReason } from './hooks/on-load-document';
export { createOnStoreDocument, type OnStoreDocumentDeps } from './hooks/on-store-document';
export { createOnChange, type OnChangeDeps } from './hooks/on-change';
export { createOnStateless, type OnStatelessDeps } from './hooks/on-stateless';
export { createOnAwarenessUpdate, type OnAwarenessUpdateDeps } from './hooks/on-awareness-update';
export { createOnDisconnect, type OnDisconnectDeps } from './hooks/on-disconnect';

// Shared types — model bag, renderer interface, hook context, and
// the auxiliary surfaces (ws token verify, editor cap counter, page
// event publisher).
export type { CollabModels, CollabRenderer } from './models';
export {
  type CollabContext,
  type CollabWsTokenUtil,
  type EditorCapCounter,
  type CollabPageEventPublisher,
  type PageEventName,
  noopEditorCapCounter,
  noopPageEventPublisher,
} from './types';
