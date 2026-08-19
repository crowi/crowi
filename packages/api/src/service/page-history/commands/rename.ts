import { Types } from 'mongoose';

import Crowi from 'src/crowi';
import type { PageDocument } from 'src/models/page';
import type { PageHistoryEventSource } from 'src/models/page-history-event';

import { type PageTransitionOutcome, runPageTransition } from '../transition';

/**
 * RFC-0021 Phase 2c-2a — rename as a history-producing command.
 *
 * Everything about *how* the move is made safe lives in the shared runner; this
 * module only supplies the three rename-specific pieces: what to do once the
 * page is claimed, what to do with the path it left, and what the event says.
 *
 * Deliberately NOT the replacement for `Page.rename`. The other four callers —
 * soft delete, restore, subtree rename, user-page activation — keep using it
 * directly. User activation in particular must not go through a transition: it
 * creates the canonical user page only after the rename resolves, so a stalled
 * transition there would leave `/user/<name>` missing entirely.
 */

export interface RenamePageCommandInput {
  page: PageDocument;
  toPath: string;
  operationId: string;
  actor: Types.ObjectId | null;
  user: unknown;
  source: PageHistoryEventSource;
  createRedirectPage: boolean;
}

export type RenamePageCommandOutcome = PageTransitionOutcome & { redirectCreated?: boolean };

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

  const fromPath = input.page.path;
  // Read raw: an absent `status` and an explicit null are different documents,
  // and the entering CAS has to pin whichever one this page actually is.
  const raw = (await Page.collection.findOne({ _id: input.page._id })) as { status?: string | null } | null;
  const fromStatusPresent = raw != null && 'status' in raw;
  const fromStatus = fromStatusPresent ? (raw?.status ?? null) : null;

  let redirectCreated = false;

  const outcome = await runPageTransition(crowi, {
    pageId: input.page._id,
    operationId: input.operationId,
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
    // outcome rather than the intention. `subtree` is always false: subtree
    // rename is a different command and never reaches this one.
    buildEvent: () => ({
      kind: 'page_renamed' as const,
      payload: { fromPath, toPath: input.toPath, redirectCreated, subtree: false },
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
