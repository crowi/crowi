import { Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import Crowi from 'src/crowi';
import type { PendingHistoryEntry } from 'src/models/page';
import { drainPendingHistoryEntry, materializePendingEntry } from './materialize';

/**
 * RFC-0021 §5.4/§13.2a — the ONLY writer that assigns `Revision.historySequence`
 * for content saves. Every content-producing writer (`Page.pushRevision`,
 * `util/replace-url.ts`'s `quietRewrite`, `@crowi/collab`'s `executeSave`)
 * calls this AFTER its own pointer write has already committed (spec §D-1:
 * pointer commit and sequence assignment can never be one atomic write on a
 * standalone MongoDB deployment, so this function does not attempt to make
 * them one — it only makes the two-step sequence *resumable*, via the same
 * outbox/materialize mechanism Phase 1 shipped with no writer).
 *
 * Two responsibilities, one conditional write each (spec §D-4):
 *   (a) promote an `untracked` Page to `ready` and assign sequence 1, when
 *       `revisionId` is the Revision the Page's pointer was just set to;
 *   (b) assign the next sequence on an already-`ready` Page.
 * `Page.historySequence` is the optimistic-lock/allocator value in both
 * cases (§D-4's `historySequence: n` filter clause) — a concurrent winner
 * moves it out from under a loser's stale read, and the loser simply re-reads
 * and retries (§D-2's numbered loop).
 *
 * NEVER throws (spec's Error semantics contract) — every internal failure,
 * expected or not, collapses to `{ allocated: false, reason: 'contended' }`
 * so a caller can always treat content persistence as already-successful
 * and let `service/page-history/repair.ts` reconcile later (§D-6).
 */

export type ContentSequenceOutcome =
  | { allocated: false; reason: 'not-eligible' | 'contended' }
  | { allocated: true; sequence: number; materialized: boolean; alreadySequenced: boolean };

const DEFAULT_MAX_CLAIM_ATTEMPTS = 3;
const DEFAULT_MAX_DRAIN_ASSISTS = 5;
const SELF_HEAL_DRAIN_ATTEMPTS = 3;

/**
 * §D-10 — checked at the top of every loop iteration AND again immediately
 * before spending a CAS write (two call sites below), so a writer that
 * resumes after repair already assigned a sequence can never re-claim a
 * second, higher one for the same Revision, which would permanently
 * desynchronize `Page.historySequence` from what was actually assigned.
 */
async function alreadySequenced(crowi: Crowi, revisionId: Types.ObjectId): Promise<ContentSequenceOutcome | 'not-found' | null> {
  const Revision = crowi.model('Revision');
  const revision = await Revision.findById(revisionId).select('historySequence').lean().exec();
  if (revision == null) {
    return 'not-found';
  }
  if (revision.historySequence != null) {
    return { allocated: true, sequence: revision.historySequence, materialized: true, alreadySequenced: true };
  }
  return null;
}

/**
 * §D-10 self-heal — clears the caller's own now-unmaterializable outbox
 * entry (the target Revision durably holds a DIFFERENT sequence than the
 * one just claimed, so `materializePendingEntry` can never match its own
 * `historySequence: null` filter again for this entry — see the call site).
 * `drainPendingHistoryEntry` is a single `entryId`-matched `updateOne`,
 * independent of the Revision's own state, so it does not share the
 * conflict this is healing from — but a transient DB error on this specific
 * call is exactly the kind of failure retrying is for. Bounded retries, not
 * infinite: if every attempt fails (or, at the DB level, none actually
 * clears the slot), the outbox is left genuinely occupied and the caller
 * must report that honestly rather than claim success — `repairPendingEntries`
 * (`repair.ts`) is the visible, operator-facing backstop that will keep
 * surfacing this Page in its `failed[]` report on every future scan until
 * the underlying DB issue clears and a later self-heal attempt succeeds.
 */
async function selfHealDrainOwnEntry(crowi: Crowi, pageId: Types.ObjectId, ownEntry: PendingHistoryEntry): Promise<boolean> {
  for (let attempt = 0; attempt < SELF_HEAL_DRAIN_ATTEMPTS; attempt += 1) {
    try {
      const result = await drainPendingHistoryEntry(crowi, pageId, ownEntry);
      if (result.drained) {
        return true;
      }
    } catch {
      // transient — retry within the bounded budget above
    }
  }
  return false;
}

export async function allocateContentSequence(
  crowi: Crowi,
  pageId: Types.ObjectId,
  revisionId: Types.ObjectId,
  options?: { maxClaimAttempts?: number; maxDrainAssists?: number; promotionOnly?: boolean },
): Promise<ContentSequenceOutcome> {
  try {
    // Resolved INSIDE the try: reading these off `options` is the only work
    // that could throw before the loop, and a throwing getter/Proxy there
    // would otherwise reject — which the callers now rely on never happening
    // (`models/page.ts` and `util/replace-url.ts` dropped their catches).
    const maxClaimAttempts = options?.maxClaimAttempts ?? DEFAULT_MAX_CLAIM_ATTEMPTS;
    const maxDrainAssists = options?.maxDrainAssists ?? DEFAULT_MAX_DRAIN_ASSISTS;
    // RFC-0021 rename-promotion caller only: without this, a promotion
    // attempt whose pointer lost the race to a concurrent content save would
    // fall through to `eligibleForNext` and assign the next sequence to the
    // now-STALE pointer it read — ordering a Revision behind one it actually
    // precedes. `promotionOnly` closes that off by refusing the "next
    // sequence on an already-ready Page" branch entirely for this call.
    const promotionOnly = options?.promotionOnly ?? false;

    const Page = crowi.model('Page');

    let claimAttemptsUsed = 0;
    let drainAssistsUsed = 0;

    for (;;) {
      // §D-2 step 1 — checked at the very top of every iteration, BEFORE
      // reading the Page and BEFORE any outbox drain. Without this, a
      // Revision already sequenced by someone else (AC-16) would still
      // trigger this call to drain whatever ELSE currently occupies the
      // Page's outbox slot — mutating state this call has no business
      // touching for a no-op outcome. The second check further below (§D-10,
      // right before the CAS) narrows the remaining TOCTOU window between
      // this read and the write itself; the two together are the full
      // coverage, neither replaces the other.
      const initialPrecheck = await alreadySequenced(crowi, revisionId);
      if (initialPrecheck === 'not-found') {
        return { allocated: false, reason: 'not-eligible' };
      }
      if (initialPrecheck != null) {
        return initialPrecheck;
      }

      const page = await Page.findById(pageId).select('historySequence historyTracking pendingHistoryEntry revision').exec();
      if (page == null) {
        return { allocated: false, reason: 'not-eligible' };
      }

      const state = page.historyTracking?.state ?? 'untracked';
      // §D-4(a) eligibility mirrors that write's own filter exactly (down to
      // `revision: revisionId` — "この Revision の pointer が既に確定していること
      // を表す"): a Page whose current pointer is NOT `revisionId` yet is not
      // eligible for promotion by this call.
      const eligibleForPromotion =
        state === 'untracked' && page.historySequence === 0 && page.pendingHistoryEntry == null && String(page.revision) === String(revisionId);
      // §D-4(b) has no such pointer check — the contract explicitly defers
      // Revision/Page ownership to `materializePendingEntry`'s
      // `assertRevisionOwnedByPage` (spec's Validation contract).
      const eligibleForNext = state === 'ready' && !promotionOnly;
      if (!eligibleForPromotion && !eligibleForNext) {
        return { allocated: false, reason: 'not-eligible' };
      }

      if (page.pendingHistoryEntry != null) {
        if (drainAssistsUsed >= maxDrainAssists) {
          return { allocated: false, reason: 'contended' };
        }
        drainAssistsUsed += 1;
        try {
          await materializePendingEntry(crowi, pageId);
        } catch {
          // A stuck/corrupt occupant is not this call's entry to fix.
          // `repair.ts` exists for that; the drain-assist budget above
          // bounds how many times we retry past it before giving up.
        }
        continue;
      }

      // §D-10 — the second checkpoint: freshest possible, run immediately
      // before spending a claim attempt / issuing the write, on top of the
      // loop-top check above. The Page read and eligibility check between
      // the two checkpoints are the only gap a concurrent sequencer (repair,
      // past its own grace window) could still land in against THIS
      // Revision — re-checking here closes it before the write, not after.
      const precheck = await alreadySequenced(crowi, revisionId);
      if (precheck === 'not-found') {
        return { allocated: false, reason: 'not-eligible' };
      }
      if (precheck != null) {
        return precheck;
      }

      if (claimAttemptsUsed >= maxClaimAttempts) {
        return { allocated: false, reason: 'contended' };
      }
      claimAttemptsUsed += 1;

      const occurredAt = new Date();
      // §D-11 — an opaque id generated fresh every attempt. No
      // `PageHistoryOperation` row is ever created for it (out of scope);
      // it exists only as the future correlation id Phase 2's command
      // cutover will use to group a content row with its metadata sibling.
      const operationId = randomUUID();
      const entryId = new Types.ObjectId();

      // §D-4 — both branches are a single `findOneAndUpdate` (never
      // `updateOne`): a match means "our filter's snapshot was still true
      // the instant this write landed", so `result != null` IS the CAS
      // outcome — no separate `modifiedCount` bookkeeping needed.
      let claimedSequence: number | null = null;
      if (eligibleForPromotion) {
        const result = await Page.findOneAndUpdate(
          {
            _id: pageId,
            // A Page whose raw document predates Phase 1's schema fields
            // (never resaved through a full `Page.prototype.save()` since —
            // e.g. a collab-only pointer write, which is a raw `updateOne`
            // that never touches these paths) can be missing `historySequence`
            // and/or `historyTracking` entirely, OR can have a `historyTracking`
            // subdocument present with `state` itself missing/null (a partial
            // write). Querying the DOTTED path `historyTracking.state` against
            // `null` matches all of: the whole subdocument missing, the
            // subdocument present with `state` missing, and `state` explicitly
            // `null` — the same "missing ≡ null" equality rule
            // `pendingHistoryEntry: null` below already relies on — so a single
            // `$or` on the leaf path covers every shape a partial write can
            // leave without needing a separate `historyTracking: null` clause.
            // `revision: revisionId` still requires the pointer write itself to
            // have landed.
            $and: [
              { $or: [{ 'historyTracking.state': 'untracked' }, { 'historyTracking.state': null }] },
              { $or: [{ historySequence: 0 }, { historySequence: null }] },
            ],
            pendingHistoryEntry: null,
            revision: revisionId,
          },
          {
            $set: {
              historySequence: 1,
              historyTracking: { state: 'ready', trackingStartedAt: occurredAt },
              pendingHistoryEntry: {
                entryId,
                type: 'content_revision',
                revisionId,
                sequence: 1,
                occurredAt,
                operationId,
              },
            },
          },
          { returnDocument: 'after' },
        ).exec();
        if (result != null) {
          claimedSequence = 1;
        }
      } else {
        const n = page.historySequence;
        const result = await Page.findOneAndUpdate(
          {
            _id: pageId,
            'historyTracking.state': 'ready',
            historySequence: n,
            pendingHistoryEntry: null,
          },
          {
            $set: {
              historySequence: n + 1,
              pendingHistoryEntry: {
                entryId,
                type: 'content_revision',
                revisionId,
                sequence: n + 1,
                occurredAt,
                operationId,
              },
            },
          },
          { returnDocument: 'after' },
        ).exec();
        if (result != null) {
          claimedSequence = n + 1;
        }
      }

      if (claimedSequence == null) {
        // Lost the race — someone else advanced the allocator or claimed
        // the slot between our read and this write. Re-read and retry.
        continue;
      }

      let materialized = false;
      try {
        await materializePendingEntry(crowi, pageId);
        materialized = true;
      } catch {
        // §D-10 self-heal — across two documents with no shared
        // transaction, the precheck above narrows but cannot fully close
        // the race against a concurrent sequencer of the SAME Revision
        // (repair, past its own grace window). If that is what just
        // happened, the target Revision now durably holds a DIFFERENT
        // sequence than the one we claimed: `materializePendingEntry`'s own
        // `historySequence: null` filter can never match again, so every
        // future attempt (drain-assist, repair) would throw the exact same
        // way forever, jamming the outbox permanently. Detect that specific,
        // unrecoverable-by-retry state and drain our own entry directly —
        // the claimed sequence number simply goes unused, which is safe
        // (`historySequence` only needs to order, never to be dense).
        const conflict = await alreadySequenced(crowi, revisionId);
        if (conflict != null && conflict !== 'not-found' && conflict.allocated && conflict.sequence !== claimedSequence) {
          const ownEntry: PendingHistoryEntry = { entryId, type: 'content_revision', revisionId, sequence: claimedSequence, occurredAt, operationId };
          const selfHealed = await selfHealDrainOwnEntry(crowi, pageId, ownEntry);
          if (!selfHealed) {
            // Could not confirm the outbox was actually cleared even after
            // retrying — reporting `conflict` (a success outcome) here would
            // hide a jammed slot from every future caller: their own
            // drain-assist step would keep re-throwing this exact same
            // mismatch (see this function's doc comment) without ever
            // reaching a clean drain. Report honestly instead.
            return { allocated: false, reason: 'contended' };
          }
          return conflict;
        }
        materialized = false;
      }

      return { allocated: true, sequence: claimedSequence, materialized, alreadySequenced: false };
    }
  } catch {
    return { allocated: false, reason: 'contended' };
  }
}
