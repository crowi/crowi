import type { WsTokenPayload } from '@crowi/api-contract';

/**
 * Per-connection context exposed by Hocuspocus to all hooks. Built by
 * `onAuthenticate` after the wsToken is verified, and threaded through
 * `onLoadDocument` / `onStoreDocument` / `onChange` / `onAwareness*`
 * via Hocuspocus's `Context` generic on `new Server<Context>({...})`.
 *
 * Fields:
 *   - `userId`   — `_id` of the connecting Crowi user. Used by Phase 5
 *                  to fill `Revision.savedBy` and by Phase 8's
 *                  awareness UI.
 *   - `pageId`   — pageId the connection is scoped to. Redundant with
 *                  `documentName` but kept on the context so downstream
 *                  hooks don't have to re-derive it.
 *   - `readonly` — true when the wsToken was minted readonly (cap
 *                  reached at issue time) **or** when the Phase 6 cap
 *                  re-check fired during onAuthenticate.
 */
export interface CollabContext {
  userId: string;
  pageId: string;
  readonly: boolean;
}

/**
 * wsToken verify surface required by `on-authenticate`. Library
 * consumers (= the api process) build the util via
 * `createWsTokenUtil()` and pass the resulting object as-is — its
 * `verifyWsToken` method satisfies this shape structurally.
 *
 * Kept as a thin interface (not the full sign+verify pair) so test
 * fixtures and future alternate verifiers (e.g. a Phase 9 verifier
 * backed by an externally-issued JWT) can satisfy the contract
 * without minting their own signer.
 */
export interface CollabWsTokenUtil {
  verifyWsToken(token: string): WsTokenPayload | null;
}

/**
 * RFC-0003 Phase 6 — editor cap counter. The collab hooks call the
 * `tryAcquire` / `release` half on connect / disconnect; the api side
 * also calls `peek` from the wsToken issuance endpoint so a 21st client
 * gets a readonly token before the WebSocket handshake begins.
 *
 * The implementation lives in `@crowi/api/src/util/editor-cap-counter.ts`.
 * Phase 9 ships a single concrete instance into both the api wsToken
 * route and `attachCollabServer` via the shared `crowi.redis` client.
 */
export interface EditorCapCounter {
  readonly maxEditorsPerPage: number;
  peek(pageId: string): Promise<{ count: number; cap: number }>;
  tryAcquire(pageId: string, userId: string, socketId: string): Promise<{ acquired: boolean; count: number; cap: number }>;
  release(pageId: string, userId: string, socketId: string): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * No-op editor cap counter — used when the host process didn't inject
 * one (single-instance dev with REDIS_URL unset, or unit tests that
 * don't care about cap). `peek` always returns 0, `tryAcquire` always
 * succeeds, `release` / `disconnect` are silent.
 */
export const noopEditorCapCounter: EditorCapCounter = {
  maxEditorsPerPage: 20,
  async peek() {
    return { count: 0, cap: 20 };
  },
  async tryAcquire() {
    return { acquired: true, count: 0, cap: 20 };
  },
  async release() {
    /* nothing */
  },
  async disconnect() {
    /* nothing */
  },
};

/**
 * Wire-format event names for the cross-instance pageEvent fan-out.
 * Phase 9 (= this RFC-0003 same-process attach work) collapses the
 * publisher into a direct in-process `crowi.event('Page').emit(...)`,
 * so the publisher implementation is a thin adapter; the type stays
 * as the shared vocabulary for both single-instance and (future)
 * Redis-backed multi-instance deployments.
 */
export type PageEventName = 'create' | 'update' | 'delete';

/**
 * Publish surface the collab save flow uses to fan a successful save
 * out to api-side listeners (render-cache / mention-dispatch / search
 * indexing). Implementations:
 *
 *   - **Phase 9 (current)**: in-process adapter that calls
 *     `crowi.event('Page').emit(eventName, page, user, bookmarkCount)`
 *     after re-fetching the Page + User docs.
 *   - **Future multi-instance**: `@hocuspocus/extension-redis` (or
 *     equivalent) re-emits across instances via Redis pub/sub.
 *
 * `publish` is best-effort: a save must never fail because fan-out
 * couldn't reach a subscriber, so implementations swallow errors and
 * warn rather than throw.
 */
export interface CollabPageEventPublisher {
  publish(eventName: PageEventName, payload: { pageId: string; userId: string; bookmarkCount?: number }): Promise<void>;
}

/**
 * No-op publisher — used as the default when `createSaveFlow` is
 * constructed without one (tests that don't care about fan-out).
 */
export const noopPageEventPublisher: CollabPageEventPublisher = {
  async publish() {
    /* drop */
  },
};
