import Debug from 'debug';

const debug = Debug('crowi:collab:presence');

/**
 * Stub presence hook called from `onAuthenticate` after a wsToken
 * passes verify. RFC-0005 will lift this into a real awareness
 * aggregator (page-level presence UI); Phase 5 / 9 keeps it as a
 * no-op so the call site stays stable.
 *
 * Embedded into the collab library directly because the previous
 * `resolveApiDistFile` dance is gone (RFC-0003 Phase 9 same-process
 * attach removed the api-dist bridge). When RFC-0005 lands a real
 * implementation it'll live on the api side as
 * `service/presence.ts` and the collab attach helper will inject
 * the real function via deps; this default keeps tests / single-
 * instance dev working without that wiring.
 */
export const markEditing = async (pageId: string, userId: string): Promise<void> => {
  if (!pageId || !userId) {
    console.warn(`[crowi:collab:presence] markEditing called with empty arg (pageId=${pageId}, userId=${userId})`);
    return;
  }
  debug('markEditing(page=%s, user=%s) [stub — RFC-0005 will implement]', pageId, userId);
};
