import { Types } from 'mongoose';

import Crowi from 'src/crowi';
import type { PageDocument } from 'src/models/page';
import type { PageHistoryEventSource } from 'src/models/page-history-event';
import type { PageHistoryOperationDocument } from 'src/models/page-history-operation';

import { allocateContentSequence } from '../content-sequence';
import { type StrandedTransitionAction, hasOperationCompletionEvidence } from '../operation';
import { type PageTransitionOutcome, runPageTransition } from '../transition';

/**
 * RFC-0021 Phase 2c-2a — rename as a history-producing command.
 *
 * Everything about *how* the move is made safe lives in the shared runner; this
 * module only supplies the three rename-specific pieces: what to do once the
 * page is claimed, what to do with the path it left, and what the event says.
 *
 * Deliberately NOT the replacement for `Page.rename`. Soft delete, restore,
 * and user-page activation keep using it directly; subtree rename delegates
 * each sealed member to this command. User activation in particular must not go through a transition: it
 * creates the canonical user page only after the rename resolves, so a stalled
 * transition there would leave `/user/<name>` missing entirely.
 */

export interface RenamePageCommandInput {
  page: PageDocument;
  /**
   * Where the page started. Passed in rather than read off `page.path`: a
   * resumed execution runs against a page that has ALREADY moved, so deriving
   * it there would describe a second move out of the destination. It comes from
   * the operation record, which is why the record stores it.
   */
  fromPath: string;
  toPath: string;
  fromStatus: string | null;
  fromStatusPresent: boolean;
  operationId: string;
  /** Which operation the event is filed under; defaults to `operationId`. See `PageTransitionInput`. */
  eventOperationId?: string;
  /** Set by subtree rename so the event says the move was part of one. */
  subtree?: boolean;
  actor: Types.ObjectId | null;
  user: unknown;
  source: PageHistoryEventSource;
  createRedirectPage: boolean;
}

export type RenamePageCommandOutcome = PageTransitionOutcome & { redirectCreated?: boolean };

/** The fields the promotion step's own fresh read needs — never `input.page` (see the call site's doc comment). */
interface UntrackedPromotionSnapshot {
  path?: string | null;
  revision?: Types.ObjectId | null;
  historyTracking?: { state?: 'untracked' | 'migrating' | 'ready' | null } | null;
}

/**
 * Create the redirect stub the old path may need.
 *
 * A stub that cannot be created does not fail the rename: the page has already
 * moved, and refusing at this point would mean reporting failure for a move
 * that is durably done. The event records what actually happened instead.
 */
async function createRedirectStub(crowi: Crowi, fromPath: string, toPath: string, user: unknown): Promise<boolean> {
  const Page = crowi.model('Page');
  try {
    // The old path can have been taken by an unrelated page in the meantime —
    // overwriting it would destroy that page, so leaving the stub uncreated is
    // the only safe answer.
    const occupant = await Page.findOne({ path: fromPath }).exec();
    if (occupant != null) return false;

    await Page.createPage(fromPath, `redirect ${toPath}`, user, { redirectTo: toPath, allowNonExistentUserPage: true });
    return true;
  } catch {
    return false;
  }
}

export async function renamePageCommand(crowi: Crowi, input: RenamePageCommandInput): Promise<RenamePageCommandOutcome> {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const pageEvent = crowi.event('Page');

  const { fromPath, fromStatus, fromStatusPresent } = input;
  let redirectCreated = false;

  // RFC-0021 rename-promotion step — untracked (pointer-carrying) pages are
  // promoted to `ready` in-place before the move, so they get a
  // `page_renamed` event like any other rename. Gated on the SNAPSHOT
  // `input.page` carries (no DB read yet): `ready`/`migrating` never demote
  // back to `untracked`, so a stale-but-not-`untracked` snapshot is never a
  // wrong direction to skip this on, and skipping it is what keeps a
  // `ready`-page rename at zero extra queries.
  if ((input.page.historyTracking?.state ?? 'untracked') === 'untracked') {
    try {
      // Never `input.page` from here on: the first delivery of a single-page
      // rename hands this command a `Page.populatePageData`-processed page,
      // whose `revision` is a populated `Revision` Document rather than the
      // raw pointer the allocator's CAS filter compares against — comparing
      // `String(doc)` there is always false, which would make every such
      // Page permanently unpromotable. A dedicated read of the current
      // Document sidesteps that entirely. Pinned to primary because the
      // `path` check below stands in for "is this a first entry, not a
      // resume" — a stale secondary read of `path` would let a resume
      // through as if it were a first entry.
      const fresh = (await Page.findById(input.page._id)
        .select('path revision historyTracking')
        .read('primary')
        .lean()
        .exec()) as UntrackedPromotionSnapshot | null;

      if (fresh == null) return { status: 'page-missing' };

      const freshRevision = fresh.revision;
      const isFirstEntry = fresh.path === input.fromPath;
      const stillUntracked = (fresh.historyTracking?.state ?? 'untracked') === 'untracked';

      if (stillUntracked && isFirstEntry && freshRevision != null) {
        // Ownership, not mere existence: an orphan (missing `page`) or
        // foreign (someone else's `page`) Revision would otherwise be
        // "promoted" by a CAS that never checks ownership itself, jamming
        // the outbox once `materializePendingEntry`'s own ownership guard
        // rejects it after the fact. `== null` (not `=== false`) because
        // `Model.exists()` never returns `false` — only a matching `{ _id
        // }` or `null`.
        const owned = await Revision.exists({ _id: freshRevision, page: input.page._id }).read('primary');
        if (owned != null) {
          const promotion = await allocateContentSequence(crowi, input.page._id, freshRevision, { promotionOnly: true });
          const proceedsToTransition = (promotion.allocated && promotion.materialized) || (!promotion.allocated && promotion.reason === 'not-eligible');
          if (!proceedsToTransition) {
            // Only these two allocator outcomes mean "page has not moved":
            // a stuck outbox right after a successful CAS, or a transient
            // claim/drain-budget exhaustion. Both are retried by resending
            // the same request — promotion is idempotent, so a retry either
            // resumes this same promotion or (once it lands) proceeds as a
            // normal `ready`-page rename.
            return { status: 'contended', redirectCreated: false };
          }
        }
      }
    } catch {
      return { status: 'contended', redirectCreated: false };
    }
  }

  const outcome = await runPageTransition(crowi, {
    pageId: input.page._id,
    operationId: input.operationId,
    eventOperationId: input.eventOperationId,
    kind: 'rename',
    fromPath,
    toPath: input.toPath,
    fromStatus,
    fromStatusPresent,
    // The page returns to the status it had; `renaming` is only ever worn
    // between the two CASes.
    toStatus: fromStatus,
    actor: input.actor,
    source: input.source,
    // `redirectCreated` reports what step 2 actually did, not what the request
    // asked for — the old path can be occupied, and the event must record the
    // outcome rather than the intention.
    buildEvent: () => ({
      kind: 'page_renamed' as const,
      payload: { fromPath, toPath: input.toPath, redirectCreated, subtree: input.subtree === true },
    }),
    afterEnter: async () => {
      // Display-only sync of the denormalised `revision.path`. Idempotent, and
      // re-run on resume: history retrieval resolves the owning page through
      // the immutable `revision.page`, so a stale path here is cosmetic.
      await Revision.updateRevisionListByPath(fromPath, { path: input.toPath });
    },
    settleVacatedPath: async () => {
      redirectCreated = input.createRedirectPage ? await createRedirectStub(crowi, fromPath, input.toPath, input.user) : false;
    },
  });

  if (outcome.status === 'committed') {
    // Same condition as the legacy path: creating a redirect returns early
    // there and never emits. Dropping this for the no-redirect case would
    // leave search and backlinks pointing at the old path.
    if (!redirectCreated) {
      pageEvent.emit('update', outcome.page, input.user);
    }
    return { ...outcome, redirectCreated };
  }

  return { ...outcome, redirectCreated };
}

/**
 * Finish a rename whose transition is still held by its operation, for the
 * operator's repair sweep. The command's input is rebuilt from the record, not
 * from the page — by then the page is already at the destination, so reading
 * intent off it would describe the move as already done.
 */
export async function resumeRenameCommand(crowi: Crowi, operation: PageHistoryOperationDocument): Promise<StrandedTransitionAction> {
  const Page = crowi.model('Page');
  const page = (await Page.findById(operation.page).exec()) as PageDocument | null;
  if (page == null || operation.fromPath == null || operation.toPath == null) return 'blocked';

  const outcome = await renamePageCommand(crowi, {
    page,
    fromPath: operation.fromPath,
    toPath: operation.toPath,
    fromStatus: operation.fromStatus ?? null,
    fromStatusPresent: operation.fromStatusPresent === true,
    operationId: operation.operationId,
    actor: operation.actor,
    user: operation.actor,
    source: operation.source ?? 'system',
    createRedirectPage: operation.createRedirect === true,
  });
  if (outcome.status !== 'committed' && outcome.status !== 'already-settled') return 'blocked';
  return (await hasOperationCompletionEvidence(crowi, operation)) ? 'resumed' : 'blocked';
}
