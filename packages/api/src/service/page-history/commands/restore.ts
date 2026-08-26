import { Types } from 'mongoose';

import Crowi from 'src/crowi';
import { type PageDocument, STATUS_PUBLISHED } from 'src/models/page';
import type { PageHistoryEventSource } from 'src/models/page-history-event';
import type { PageHistoryOperationDocument } from 'src/models/page-history-operation';

import { type StrandedTransitionAction, hasOperationCompletionEvidence } from '../operation';
import { type PageTransitionOutcome, runPageTransition } from '../transition';

/**
 * RFC-0021 Phase 2c-2a — restore from the trash as a history-producing command.
 *
 * Not the mirror image of trash. Trash leaves a stub behind as it goes; restore
 * has to REMOVE the stub sitting on the path it wants back, and that removal is
 * destructive and happens before the move. It therefore lives in the handler's
 * first-delivery validation rather than in a hook here — see the spec's DC-2.
 * By the time this command runs, the destination is already clear.
 */

export interface RestorePageCommandInput {
  page: PageDocument;
  /** From the operation record, not from the page: a resumed run sees a page that has already moved. */
  fromPath: string;
  toPath: string;
  fromStatus: string | null;
  fromStatusPresent: boolean;
  operationId: string;
  actor: Types.ObjectId | null;
  source: PageHistoryEventSource;
}

export type RestorePageCommandOutcome = PageTransitionOutcome;

export async function restorePageCommand(crowi: Crowi, input: RestorePageCommandInput): Promise<RestorePageCommandOutcome> {
  const Page = crowi.model('Page');
  const { fromPath, toPath, fromStatus, fromStatusPresent } = input;

  const outcome = await runPageTransition(crowi, {
    pageId: input.page._id,
    operationId: input.operationId,
    kind: 'restore',
    fromPath,
    toPath,
    fromStatus,
    fromStatusPresent,
    toStatus: STATUS_PUBLISHED,
    actor: input.actor,
    source: input.source,
    buildEvent: () => ({ kind: 'page_restored' as const, payload: { fromPath, toPath } }),
    // Nothing to do on entry, and nothing to settle on the vacated `/trash/`
    // path — the legacy restore asks for no redirect stub there.
  });

  if (outcome.status === 'committed') {
    // Storage reclamation only. The entering CAS already advanced the epoch,
    // which is what makes the pre-delete lineage unreplayable; this just clears
    // rows the delete-time purge could not, including any appended while it was
    // draining.
    //
    // Swallowed on purpose: the page is already back by now, so reporting a
    // failed restore because some disk space could not be reclaimed would tell
    // the user their page did not come back when it did. Re-running the repair
    // sweep, or the next delete, picks the rows up.
    try {
      await Page.purgeCollabLineage(input.page._id);
    } catch {
      // Intentionally ignored — see above.
    }
  }

  return outcome;
}

/** Finish a restore whose transition is still held by its operation, for the repair sweep. */
export async function resumeRestoreCommand(crowi: Crowi, operation: PageHistoryOperationDocument): Promise<StrandedTransitionAction> {
  const Page = crowi.model('Page');
  const page = (await Page.findById(operation.page).exec()) as PageDocument | null;
  if (page == null || operation.fromPath == null || operation.toPath == null) return 'blocked';

  const outcome = await restorePageCommand(crowi, {
    page,
    fromPath: operation.fromPath,
    toPath: operation.toPath,
    fromStatus: operation.fromStatus ?? null,
    fromStatusPresent: operation.fromStatusPresent === true,
    operationId: operation.operationId,
    actor: operation.actor,
    source: operation.source ?? 'system',
  });
  if (outcome.status !== 'committed' && outcome.status !== 'already-settled') return 'blocked';
  return (await hasOperationCompletionEvidence(crowi, operation)) ? 'resumed' : 'blocked';
}
