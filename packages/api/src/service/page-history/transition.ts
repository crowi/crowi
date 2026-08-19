import { Types } from 'mongoose';

import Crowi from 'src/crowi';
import { type PageDocument, STATUS_RENAMING } from 'src/models/page';
import type { PageHistoryEventSource } from 'src/models/page-history-event';

import { type PageCommandPlanResult, runPageEventCommand } from './page-event-command';

/**
 * RFC-0021 Phase 2c-2a — the shared runner behind every command that moves a
 * Page's path.
 *
 * The move is three writes, not one, because a path change and its history
 * event cannot be made atomic across documents. Step 1 claims the Page and
 * moves it; step 2 settles whatever the vacated path needs; step 3 leaves the
 * transition and appends the event. `Page.historyTransition` is what makes that
 * safe: it names the operation that owns the move, so a second command cannot
 * enter, and an execution that comes back after a crash can tell its own
 * unfinished move from someone else's.
 *
 * This module deliberately knows nothing about `PageHistoryOperation`. It
 * classifies what it finds and returns a value; recording terminal results is
 * the command service's job. Keeping that boundary is what lets the runner land
 * before the operation record's design is settled.
 */

/** How many times to retry step 1 when the Page turns out not to have entered yet (matches the 2c-1 claim budget). */
const DEFAULT_MAX_ENTER_ATTEMPTS = 3;

/** The event the leaving CAS appends — same shape the 2c-1 plan callback returns. */
type TransitionEvent = NonNullable<Extract<PageCommandPlanResult, { decision: 'write' }>['event']>;

export interface PageTransitionInput {
  pageId: Types.ObjectId;
  /** The owning operation's id. Pinned by both the entering and the leaving CAS, and injected into the event envelope. */
  operationId: string;
  /** Which command owns the move (`'rename'`, `'trash'`, ...), recorded on the Page so recovery knows what to finish. */
  kind: string;
  fromPath: string;
  toPath: string;
  fromStatus: string | null;
  /**
   * Whether the Page carried a `status` field at all. A legacy Page has none,
   * and `{ status: undefined }` is dropped on the way to Mongo, so the entering
   * CAS has to pin `{ $exists: false }` rather than a value. Never infer this
   * from `fromStatus === null` — an explicit null and a missing field are
   * different documents.
   */
  fromStatusPresent: boolean;
  toStatus: string | null;
  actor: Types.ObjectId | null;
  source: PageHistoryEventSource;
  event: TransitionEvent;
  /** Command-specific, idempotent work that must happen once the Page is claimed. Re-run on resume. */
  afterEnter?: () => Promise<void>;
  /** Command-specific handling of the path the Page just left (a redirect stub, or nothing). Re-run on resume. */
  settleVacatedPath?: () => Promise<void>;
  options?: { maxEnterAttempts?: number };
}

export type PageTransitionOutcome =
  /** The move landed: the Page is at `toPath` with `toStatus`, and the event is appended. */
  | { status: 'committed'; page: PageDocument; sequence: number | null; eventId: Types.ObjectId | null }
  /** The move had already landed before this execution ran (a resumed or duplicated attempt). No write was made. */
  | { status: 'already-settled'; page: PageDocument }
  /** Another operation owns this Page's transition. Nothing was written. */
  | { status: 'owned-elsewhere'; ownerOperationId: string }
  /** Step 1 kept losing to concurrent writers until the budget ran out. Nothing was written. */
  | { status: 'contended' }
  /** The Page is gone. Nothing was written. */
  | { status: 'page-missing' }
  /** The Page is in a state this runner will not act on — left exactly as found, for an operator to resolve. */
  | { status: 'incomplete'; reason: string };

/** What a re-read of the Page says about how far this operation got. Shared with the repair sweep so both read the table the same way. */
export type ResumeDecision =
  | { decision: 'resume-own' }
  | { decision: 'already-settled' }
  | { decision: 'not-entered' }
  | { decision: 'owned-elsewhere'; ownerOperationId: string }
  | { decision: 'page-missing' }
  | { decision: 'indeterminate' };

/** The raw fields the classification reads. Deliberately not 2c-1's snapshot: that projection carries neither `path` nor `historyTransition`. */
export interface TransitionPageSnapshot {
  path?: string | null;
  status?: string | null;
  historyTransition?: { operationId?: string | null; kind?: string | null } | null;
}

export type ResumeExpectation = Pick<PageTransitionInput, 'operationId' | 'fromPath' | 'toPath' | 'fromStatus' | 'fromStatusPresent' | 'toStatus'>;

const statusMatches = (observed: string | null | undefined, expected: string | null, expectedPresent: boolean): boolean => {
  // An absent field reads as `undefined` from `.lean()`, and the command
  // recorded whether it was absent — so "no status, and none was expected" is a
  // match, while "no status, but a value was expected" is not.
  if (!expectedPresent) return observed == null;
  return (observed ?? null) === expected;
};

/**
 * Decide how far this operation got, from a fresh read of the Page.
 *
 * Both the runner (when its entering CAS matches nothing) and the repair sweep
 * ask this question, and they must answer it identically — they differ only in
 * what they do with the answer.
 */
export function classifyResume(page: TransitionPageSnapshot | null | undefined, expected: ResumeExpectation): ResumeDecision {
  if (page == null) return { decision: 'page-missing' };

  const owner = page.historyTransition?.operationId;
  if (owner != null) {
    return owner === expected.operationId ? { decision: 'resume-own' } : { decision: 'owned-elsewhere', ownerOperationId: owner };
  }

  // No transition is held, so the Page is settled — on one side or the other.
  if (page.path === expected.toPath && statusMatches(page.status, expected.toStatus, true)) {
    return { decision: 'already-settled' };
  }
  if (page.path === expected.fromPath && statusMatches(page.status, expected.fromStatus, expected.fromStatusPresent)) {
    return { decision: 'not-entered' };
  }
  return { decision: 'indeterminate' };
}

/**
 * Step 1 — claim the transition and move the Page in one conditional update.
 *
 * Pinning `historyTransition: null` is the mutual exclusion: Mongo matches that
 * against both an absent field and an explicit null, so a Page that has never
 * transitioned and one that finished its last transition are equally enterable,
 * while one mid-move is not.
 */
export async function enterTransition(crowi: Crowi, input: PageTransitionInput): Promise<PageDocument | null> {
  const Page = crowi.model('Page');
  const filter: Record<string, unknown> = {
    _id: input.pageId,
    path: input.fromPath,
    historyTransition: null,
    status: input.fromStatusPresent ? input.fromStatus : { $exists: false },
  };
  return Page.findOneAndUpdate(
    filter,
    {
      $set: { path: input.toPath, status: STATUS_RENAMING, historyTransition: { operationId: input.operationId, kind: input.kind } },
      // Every existing path-moving write advances the collab lifecycle epoch
      // (`updatePageProperty`'s `advanceEpoch`, which `rename` / `deletePage` /
      // `revertDeletedPage` all pass) — that is what forces an editor attached
      // to the old path off the document. Entering a transition moves the path,
      // so it has to advance it too, and in THIS update: a separate write would
      // leave a page whose path moved while its epoch did not if we crashed
      // between them.
      $inc: { collabLifecycleVersion: 1 },
    },
    { returnDocument: 'after' },
  ).exec();
}

/**
 * Step 3 — leave the transition and append the event in the 2c-1 command's
 * single CAS, so the Page never settles without its history row.
 *
 * The plan pins `historyTransition.operationId` and `path` rather than reading
 * them, because 2c-1's snapshot projection carries neither. The CAS is what
 * decides whether this execution still owns the move.
 */
export async function exitTransition(crowi: Crowi, input: PageTransitionInput): Promise<PageTransitionOutcome> {
  const outcome = await runPageEventCommand(crowi, {
    pageId: input.pageId,
    actor: input.actor,
    source: input.source,
    operationId: input.operationId,
    plan: () => ({
      decision: 'write',
      expected: { 'historyTransition.operationId': input.operationId, path: input.toPath },
      // `status` is written even when `toStatus` is null: 2c-1's plan only
      // reaches `$set`, so a Page that had no status before the move settles
      // with an explicit null rather than an absent field. The two are
      // equivalent everywhere the status is read (`isPublic`, and every filter
      // uses Mongo's null-equality).
      set: { status: input.toStatus, historyTransition: null },
      event: input.event,
    }),
  });

  if (outcome.status === 'committed') {
    return { status: 'committed', page: outcome.page, sequence: outcome.sequence, eventId: outcome.eventId };
  }
  // Anything else leaves the Page mid-transition on purpose — the move is not
  // abandoned, it is handed to the operator's repair with its claim intact.
  return { status: 'incomplete', reason: outcome.status };
}

/**
 * Run the whole move, resuming rather than restarting when the Page turns out
 * to have moved already.
 *
 * `afterEnter` and `settleVacatedPath` run on the resumed path too — they are
 * required to be idempotent precisely so recovery can replay them instead of
 * having to know which of them already ran.
 */
export async function runPageTransition(crowi: Crowi, input: PageTransitionInput): Promise<PageTransitionOutcome> {
  const Page = crowi.model('Page');
  const maxEnterAttempts = input.options?.maxEnterAttempts ?? DEFAULT_MAX_ENTER_ATTEMPTS;

  let entered: PageDocument | null = null;
  for (let attempt = 1; attempt <= maxEnterAttempts; attempt++) {
    entered = await enterTransition(crowi, input);
    if (entered != null) break;

    const current = (await Page.findById(input.pageId).select('path status historyTransition').lean().exec()) as TransitionPageSnapshot | null;
    const decision = classifyResume(current, input);
    switch (decision.decision) {
      case 'resume-own':
        // Step 1 already landed for us; pick up from `afterEnter`.
        entered = (await Page.findById(input.pageId).exec()) as PageDocument | null;
        if (entered == null) return { status: 'page-missing' };
        break;
      case 'already-settled': {
        const settled = (await Page.findById(input.pageId).exec()) as PageDocument | null;
        return settled == null ? { status: 'page-missing' } : { status: 'already-settled', page: settled };
      }
      case 'not-entered':
        // Someone moved the Page back, or our own read raced the write. Retry
        // the entering CAS until the budget runs out.
        continue;
      case 'owned-elsewhere':
        return { status: 'owned-elsewhere', ownerOperationId: decision.ownerOperationId };
      case 'page-missing':
        return { status: 'page-missing' };
      case 'indeterminate':
        return { status: 'incomplete', reason: 'unrecognised-page-state' };
    }
    if (entered != null) break;
  }

  if (entered == null) return { status: 'contended' };

  await input.afterEnter?.();
  await input.settleVacatedPath?.();
  return exitTransition(crowi, input);
}
