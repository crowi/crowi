import type { onStatelessPayload } from '@hocuspocus/server';
import Debug from 'debug';
import { CollabSaveMessageSchema, type CollabSaveError as CollabSaveErrorPayload } from '@crowi/api-contract';
import type { SaveFlow } from '../save-flow';
import { CollabSaveError } from '../save-flow';
import type { CollabContext } from '../types';

const debug = Debug('crowi:collab:stateless');

export interface OnStatelessDeps {
  saveFlow: SaveFlow;
}

/**
 * Hocuspocus's `onStateless` hook is the canonical "custom client →
 * server message" channel in v4 (there is no `onMessage`). Clients
 * send arbitrary string payloads via `HocuspocusProvider.sendStateless
 * (JSON.stringify(...))`; servers reply with
 * `connection.sendStateless(JSON.stringify(...))`.
 *
 * RFC-0003 Phase 5 wires a single `kind: 'crowi:save'` payload onto
 * this hook. Behaviour:
 *
 *   - `JSON.parse` fail or `CollabSaveMessageSchema.safeParse` fail →
 *     **silently skip**. Other code may extend the stateless channel
 *     for future RFCs, and we don't want to spam errors at unrelated
 *     traffic.
 *
 *   - Readonly connection → send `crowi:save-error { code: 'READONLY' }`
 *     and return. The token's readonly bit (or the cap-driven
 *     readonly) is the authoritative gate; this is defence-in-depth.
 *
 *   - Save success → `connection.sendStateless({ kind: 'crowi:save-ok',
 *     revisionId })`. Phase 8 wires the client side to consume this.
 *
 *   - Save failure → `connection.sendStateless({ kind: 'crowi:save-error',
 *     code, message })`. Catches `CollabSaveError` (typed code) and
 *     any other thrown error (mapped to `code: 'DB_ERROR'`).
 *
 * Important: never throw out of the hook. A thrown exception causes
 * Hocuspocus to terminate the connection, which would lose the user's
 * unsaved edits. The error payload must travel back over the same
 * connection so the client can decide whether to retry.
 */
export function createOnStateless(deps: OnStatelessDeps) {
  return async (data: onStatelessPayload): Promise<void> => {
    const { connection, documentName, document, payload } = data;

    // Parse outer envelope.
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      debug('skip: payload is not JSON');
      return;
    }

    const message = CollabSaveMessageSchema.safeParse(parsed);
    if (!message.success) {
      // Unknown stateless payload — leave for future hooks / extensions.
      debug('skip: payload does not match crowi:save schema');
      return;
    }

    // Hocuspocus's `connection.context` is typed at the protocol level
    // but not narrowed to our `CollabContext`. The cast is safe
    // because `createCollabServer` is `new Server<CollabContext>(...)`.
    const context = (connection as unknown as { context: CollabContext }).context;
    if (context?.readonly) {
      const err: CollabSaveErrorPayload = { kind: 'crowi:save-error', code: 'READONLY', message: 'connection is readonly' };
      connection.sendStateless(JSON.stringify(err));
      debug('reject: readonly connection on page %s', documentName);
      return;
    }

    try {
      const result = await deps.saveFlow.executeSave({
        pageId: documentName,
        userId: context.userId,
        document,
        message: message.data.message,
        // Round 2, Decision 1 — the save lock is anchored SERVER-SIDE to the
        // revision this Hocuspocus doc was materialised from (recorded in
        // `onLoadDocument`), so the client no longer sends a base revision.
      });
      // Phase 8 will subscribe to this on the client (Save button toast).
      // The wire format `{ kind, revisionId }` is intentionally not
      // declared in @crowi/api-contract Phase 1 because no consumer
      // yet validates it. Phase 8 will add `CollabSaveOkSchema`.
      connection.sendStateless(JSON.stringify({ kind: 'crowi:save-ok', revisionId: result.revisionId }));
      debug('save ok for page %s — revision=%s', documentName, result.revisionId);
    } catch (err) {
      const errPayload: CollabSaveErrorPayload = {
        kind: 'crowi:save-error',
        code: err instanceof CollabSaveError ? err.code : 'DB_ERROR',
        message: err instanceof Error ? err.message : String(err),
      };
      connection.sendStateless(JSON.stringify(errPayload));
      // Surface in operator logs — we never throw out of this hook.
      console.warn(`[crowi:collab] save failed for page ${documentName}: ${errPayload.code} — ${errPayload.message}`);
    }
  };
}
