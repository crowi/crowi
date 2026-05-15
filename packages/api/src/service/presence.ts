import Debug from 'debug';

/**
 * RFC-0003 Phase 5 presence stub.
 *
 * The collab process calls `markEditing(pageId, userId)` once a
 * client authenticates against a Y.Doc. The Phase 5 spec (§5.3)
 * explicitly defers the **implementation** to RFC-0005 (page-level
 * presence UI / awareness aggregator) and only requires a no-op
 * placeholder so the call site and the swap point are in place.
 *
 * Why expose a stub now instead of waiting for RFC-0005?
 *   - The collab → api wrapper (`packages/collab/src/presence.ts`)
 *     resolves this file via the api dist re-export, same as
 *     `ws-token.ts` / `collab-cap.ts`. Pre-creating the symbol
 *     stabilises the dist path so RFC-0005 lands as a one-file swap.
 *   - Hocuspocus's `onAuthenticate` fires for every connection, so a
 *     missing import or thrown stub would noisily break every collab
 *     session.
 *
 * RFC-0005 will replace the body with the real implementation —
 * signature changes (if any) should be additive so the collab side
 * doesn't have to ship a paired update.
 */

const debug = Debug('crowi:service:presence');

/**
 * Record that `userId` is currently editing `pageId`.
 *
 * Phase 5: no-op + debug log; never throws. Callers can `await` or
 * fire-and-forget — both work.
 *
 * @param pageId  Mongo ObjectId of the page being edited, as string.
 * @param userId  Mongo ObjectId of the connected user, as string.
 */
export async function markEditing(pageId: string, userId: string): Promise<void> {
  if (!pageId || !userId) {
    // Defensive: surface bad inputs at the warning level so RFC-0005
    // gets cleaner data without breaking Phase 5 sessions.
    console.warn(`[crowi:presence] markEditing called with empty arg (pageId=${pageId}, userId=${userId})`);
    return;
  }
  debug('markEditing(page=%s, user=%s) [stub — RFC-0005 will implement]', pageId, userId);
}
