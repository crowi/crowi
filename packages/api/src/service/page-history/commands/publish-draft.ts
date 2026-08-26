import { Types } from 'mongoose';

import Crowi from 'src/crowi';
import { STATUS_DRAFT, STATUS_PUBLISHED } from 'src/models/page';
import { runPageEventCommand } from '../page-event-command';
import type { PageCommandPlan, PageCommandSnapshot, PageEventCommandOutcome } from '../page-event-command';

/**
 * RFC-0021 §6.3/DC-3/DC-6 (Phase 2c-1) — the `draft_published` command.
 * `save-flow.ts` step 6b (`@crowi/collab`) injects this in place of the
 * inline `updateOne` it falls back to when no publisher is configured.
 *
 * `snapshot.status` (not `input`) decides `noop` vs `write` — a losing
 * retry after F-8 contention re-reads and re-decides against the CURRENT
 * status, never the status this call observed on a prior iteration.
 */

export interface PublishDraftInput {
  pageId: Types.ObjectId;
  /** collab's save-time actor. `null` for an anonymous/unknown editor. */
  actor: Types.ObjectId | null;
}

export async function publishDraftPage(crowi: Crowi, input: PublishDraftInput): Promise<PageEventCommandOutcome> {
  const plan: PageCommandPlan = (snapshot: PageCommandSnapshot) => {
    if (snapshot.status !== STATUS_DRAFT) {
      // Status transitions are one-way (draft -> published only) — a Page
      // that already left `draft` never has anything left for this command
      // to do, and never will again (F-5 step 6).
      return { decision: 'noop', reason: 'not-draft' };
    }

    return {
      decision: 'write',
      expected: { status: STATUS_DRAFT },
      set: { status: STATUS_PUBLISHED },
      event: { kind: 'draft_published' as const, payload: { fromStatus: STATUS_DRAFT, toStatus: STATUS_PUBLISHED } },
    };
  };

  return runPageEventCommand(crowi, {
    pageId: input.pageId,
    actor: input.actor,
    source: 'collab',
    plan,
  });
}
