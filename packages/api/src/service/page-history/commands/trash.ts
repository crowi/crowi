import { Types } from 'mongoose';

import Crowi from 'src/crowi';
import { type PageDocument, STATUS_DELETED } from 'src/models/page';
import type { PageHistoryEventSource } from 'src/models/page-history-event';
import type { PageHistoryOperationDocument } from 'src/models/page-history-operation';

import { type StrandedTransitionAction, hasOperationCompletionEvidence } from '../operation';
import { type PageTransitionOutcome, runPageTransition } from '../transition';

/**
 * RFC-0021 Phase 2c-2a — soft delete (move to `/trash/`) as a
 * history-producing command.
 *
 * Only the soft path runs through here. Hard delete removes the page outright
 * and belongs to a later phase along with its deletion record; it keeps calling
 * the model directly and produces no history.
 */

export interface TrashPageCommandInput {
  page: PageDocument;
  /**
   * Where the page started, and where it is going.
   *
   * Passed in rather than read off `page.path`: a resumed execution runs
   * against a page that has ALREADY moved, so deriving the paths there would
   * describe a second move out of the destination. These come from the
   * operation record, which is why the record stores them.
   */
  fromPath: string;
  toPath: string;
  fromStatus: string | null;
  fromStatusPresent: boolean;
  operationId: string;
  actor: Types.ObjectId | null;
  user: unknown;
  source: PageHistoryEventSource;
}

export type TrashPageCommandOutcome = PageTransitionOutcome & { redirectCreated?: boolean };

/**
 * The stub the vacated path needs, so links and bookmarks to a trashed page
 * still resolve. Mirrors what the legacy delete asked `rename` for.
 */
async function createRedirectStub(crowi: Crowi, fromPath: string, toPath: string, user: unknown): Promise<boolean> {
  const Page = crowi.model('Page');
  try {
    const occupant = await Page.findOne({ path: fromPath }).exec();
    if (occupant != null) return false;
    await Page.createPage(fromPath, `redirect ${toPath}`, user, { redirectTo: toPath, allowNonExistentUserPage: true });
    return true;
  } catch {
    return false;
  }
}

export async function trashPageCommand(crowi: Crowi, input: TrashPageCommandInput): Promise<TrashPageCommandOutcome> {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const Share = crowi.model('Share');

  const { fromPath, toPath, fromStatus, fromStatusPresent } = input;
  let redirectCreated = false;

  const outcome = await runPageTransition(crowi, {
    pageId: input.page._id,
    operationId: input.operationId,
    kind: 'trash',
    fromPath,
    toPath,
    fromStatus,
    fromStatusPresent,
    toStatus: STATUS_DELETED,
    actor: input.actor,
    source: input.source,
    buildEvent: () => ({ kind: 'page_trashed' as const, payload: { fromPath, toPath } }),
    afterEnter: async () => {
      // Order matters and is inherited from the legacy delete: the reload
      // prompt and the lineage purge go FIRST, immediately after the write
      // that made the move durable. Anything later here can throw — and if it
      // did, a prompt that never fired would leave an editor attached to a
      // page the user just deleted, and an unpurged yjsState would keep the
      // deleted content readable from the append log.
      Page.invalidateLiveCollabDoc(input.page._id, 'page-deleted');
      await Page.purgeCollabLineage(input.page._id);

      await Share.deleteByPageId(input.page._id);
      await Revision.updateRevisionListByPath(fromPath, { path: toPath });
    },
    settleVacatedPath: async () => {
      redirectCreated = await createRedirectStub(crowi, fromPath, toPath, input.user);
    },
  });

  // Deliberately no `pageEvent('update')` here, and no second reload prompt for
  // the stub: the user-facing signal for this operation is the `page-deleted`
  // invalidation above. The legacy path suppressed its internal `/trash/`
  // rename's own prompt for exactly this reason.
  return { ...outcome, redirectCreated };
}

/**
 * Finish a trash whose transition is still held by its operation, for the
 * operator's repair sweep. Rebuilds the command from the record rather than
 * from the page, which by then is already mid-move.
 */
export async function resumeTrashCommand(crowi: Crowi, operation: PageHistoryOperationDocument): Promise<StrandedTransitionAction> {
  const Page = crowi.model('Page');
  const page = (await Page.findById(operation.page).exec()) as PageDocument | null;
  if (page == null || operation.fromPath == null || operation.toPath == null) return 'blocked';

  const outcome = await trashPageCommand(crowi, {
    page,
    fromPath: operation.fromPath,
    toPath: operation.toPath,
    fromStatus: operation.fromStatus ?? null,
    fromStatusPresent: operation.fromStatusPresent === true,
    operationId: operation.operationId,
    actor: operation.actor,
    user: operation.actor,
    source: operation.source ?? 'system',
  });
  if (outcome.status !== 'committed' && outcome.status !== 'already-settled') return 'blocked';
  return (await hasOperationCompletionEvidence(crowi, operation)) ? 'resumed' : 'blocked';
}
