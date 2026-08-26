import Debug from 'debug';
import { Types } from 'mongoose';

import Crowi from 'src/crowi';
import { redactErrorReason } from './repair';

const debug = Debug('crowi:service:page-history:purge');

/**
 * RFC-0021 §5.1/§5.6, DC-5 — `PageHistoryEvent` carries no TTL /
 * retention index: a row lives exactly as long as the Page it belongs to.
 * Before any writer ever appends a row (Phase B/C), the deletion path has to already purge
 * them, or the very first row written becomes durably orphaned the moment
 * its Page is hard-deleted.
 *
 * `message` deliberately carries only `pageId` — never the driver /
 * Mongoose failure text, which can embed arbitrary raw values (a corrupt
 * document's field content, in the general case) and would otherwise reach
 * an operator-facing surface unredacted (`hono/handlers/page.ts`'s
 * `PAGE_DELETE_FAILED` body serializes `error.message` verbatim). The
 * original failure is still attached as `cause`, reachable from a local
 * stack trace / debug log, never from the HTTP response.
 */
export class PageHistoryPurgeError extends Error {
  readonly pageId: string;

  constructor(pageId: Types.ObjectId, options?: { cause?: unknown }) {
    super(`page history purge failed for page ${pageId}`);
    this.name = 'PageHistoryPurgeError';
    this.pageId = String(pageId);
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * Idempotent: a single `deleteMany({ page: pageId })`, safe to call any
 * number of times for the same `pageId` (a second call simply finds nothing
 * left and returns `deletedCount: 0`). Does not depend on the Page row
 * still existing — the caller (`service/page-history/deletion.ts`) is
 * responsible for sequencing this AFTER `Page.deleteOne` has already
 * committed (DC-5: that is the point past which no NEW event for this page
 * can ever be created, so purging before vs. after that point are the only
 * two orderings and "after" is the one that can never destroy a live
 * Page's history).
 */
export async function purgePageHistoryEvents(crowi: Crowi, pageId: Types.ObjectId): Promise<{ deletedCount: number }> {
  const PageHistoryEvent = crowi.model('PageHistoryEvent');
  try {
    const result = await PageHistoryEvent.deleteMany({ page: pageId }).exec();
    return { deletedCount: result.deletedCount ?? 0 };
  } catch (err) {
    debug('purgePageHistoryEvents failed for page %s: %s', String(pageId), redactErrorReason(err));
    throw new PageHistoryPurgeError(pageId, { cause: err });
  }
}
