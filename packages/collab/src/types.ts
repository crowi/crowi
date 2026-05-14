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
