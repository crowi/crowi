import type { Types } from 'mongoose';

import Crowi from 'src/crowi';
import type { PageDocument, PendingHistoryEntry } from 'src/models/page';

/**
 * RFC-0021 §5.5/§6.4 (`feature-page-history-phase1-model`, Phase 1) — the
 * idempotent materializer for `Page.pendingHistoryEntry`. Reads the single
 * outbox slot, durably finishes whichever variant it holds, then drains the
 * marker. Phase 1 ships no writer that ever populates the outbox — the only
 * callers are `service/page-history/repair.ts` (background/operator repair)
 * and this module's own tests, exercising the mechanism Phase 2's command
 * cutover will depend on.
 *
 * "Re-running produces the same result" is the only correctness bar (spec
 * §"設計の主な判断"): every branch below is written as a conditional write
 * that is a no-op once its target already reflects the entry, so a crash
 * between the materialize step and the drain step (repair's job) can always
 * be resumed by simply calling this function again.
 *
 * Draining is identity-matched on `entry.entryId` ONLY (RFC §5.5, revised —
 * "outbox の drain は entryId 1 フィールドだけで一致を見る") — never by comparing the
 * entry's other fields. See `models/page.ts`'s `PendingHistoryEntry` doc
 * comment for why: a native driver can write fields outside this schema's
 * declared vocabulary, so any content-based "is this still the same entry"
 * check can only ever cover a fixed, incomplete set of known fields: an
 * opaque id sidesteps the question entirely.
 */

export interface MaterializeResult {
  /** Whether the outbox slot was found empty (`false`) — i.e. this call did no work — or drained by this call (`true`). */
  drained: boolean;
}

/**
 * Materializer-side shape guard (codex review, `feature-page-history-phase1-
 * model` attempt 2) — `pendingHistoryEntrySchema`'s own `pre('validate')`
 * hook (`models/page.ts`) only fires on the `Page.prototype.save()` path.
 * Every REAL outbox claim in this codebase — this suite's `claimOutbox`,
 * `repair.ts`'s `claimAndAssignSequence`, and Phase 2's future command CAS —
 * writes the entry via `Page.updateOne(...{ $set: { pendingHistoryEntry }
 * })`, which Mongoose never runs document validators against. Without this
 * guard a malformed entry (wrong variant fields) would reach the raw
 * `updateOne`/`findById` calls below and fail with an opaque driver error
 * instead of a clear one — or, worse, silently write `undefined` into a
 * required column. Throws with the outbox marker left untouched, so a
 * malformed entry surfaces for operator investigation instead of being
 * silently drained away.
 */
function assertWellFormedPendingEntry(entry: PendingHistoryEntry): void {
  if (entry.entryId == null) {
    throw new Error('materializePendingEntry: pendingHistoryEntry is missing entryId');
  }
  switch (entry.type) {
    case 'page_event':
      if (entry.event == null) {
        throw new Error('materializePendingEntry: page_event entry is missing `event`');
      }
      return;
    case 'content_revision':
      if (entry.revisionId == null || entry.sequence == null || entry.operationId == null || entry.occurredAt == null) {
        throw new Error('materializePendingEntry: content_revision entry is missing revisionId/sequence/operationId/occurredAt');
      }
      return;
    case 'migration_revision':
      if (entry.revisionId == null || entry.sequence == null || entry.migrationOwner == null) {
        throw new Error('materializePendingEntry: migration_revision entry is missing revisionId/sequence/migrationOwner');
      }
      return;
    default: {
      // AC-8b (codex review attempt 5/2): the entry reaching this branch is,
      // by definition, one this module's own type union does not recognize
      // — i.e. a native-driver-injected or otherwise corrupt entry, the
      // exact class of input `redactErrorReason` (repair.ts) exists to
      // protect operator-facing reports from. The PRIOR version of this
      // branch `JSON.stringify`'d the whole entry into the message — a
      // disposable MongoDB repro confirmed an injected email surfaces
      // verbatim in `failed[].reason` (and therefore `admin-cli` stdout)
      // through that path, because a plain `Error` falls through
      // `redactErrorReason`'s generic `err.message` fallback unredacted.
      // Report only FIELD NAMES (never values) — same "field names stay,
      // values are redacted" contract `redactErrorReason` applies to
      // Mongoose validation/cast errors. `entry` here is a live Mongoose
      // SUBDOCUMENT (`Page.pendingHistoryEntry`, read via `Page.findById`),
      // NOT a plain object — `Object.keys()` on it directly surfaces
      // internal Mongoose plumbing (`$__`, `$isNew`, `_doc`, ...), not the
      // schema fields an operator would recognize, so route through
      // `.toObject()` first when available (same pattern
      // `pageHistoryEventSchema`'s own `pre('validate')` hook uses).
      const exhaustiveCheck: never = entry;
      const plain =
        exhaustiveCheck != null && typeof exhaustiveCheck === 'object'
          ? ((exhaustiveCheck as unknown as { toObject?: () => Record<string, unknown> }).toObject?.() ??
            (exhaustiveCheck as unknown as Record<string, unknown>))
          : undefined;
      const fieldNames = plain != null ? Object.keys(plain) : [];
      throw new Error(`materializePendingEntry: unrecognized pendingHistoryEntry type (fields present: ${fieldNames.join(', ')})`);
    }
  }
}

/**
 * Pre-write ownership/existence guard for the `content_revision` /
 * `migration_revision` variants: reads the target Revision BEFORE the
 * conditional `updateOne`, so a corrupt outbox entry pointing at a Revision
 * that doesn't exist — or belongs to a DIFFERENT Page — is rejected before
 * it can stamp a bogus `historySequence` onto that foreign Revision.
 * `verifyRevisionMaterialized` (below) still re-checks the same invariants
 * AFTER the write as defense in depth against the read-then-write gap, but
 * by then a corrupt entry has already been prevented from writing in the
 * first place.
 *
 * `Revision.page` is optional in the schema (legacy orphans that predate
 * DC-5's id-based ref, or a revision the id-backfill could not confidently
 * resolve — see `models/revision.ts`'s doc comment). That legacy allowance
 * does NOT extend to this outbox path: every `content_revision` /
 * `migration_revision` entry is produced by a writer that read the target
 * Revision via the SAME Page it is now claiming, so a `page: null` (or
 * missing) Revision reached through this outbox slot is never a legitimate
 * legacy orphan — it is either a stale/corrupt entry or a caller bypassing
 * the writer contract. Require EXACT equality with the outbox-owning Page;
 * `null`/missing is rejected the same as a mismatched id.
 */
async function assertRevisionOwnedByPage(crowi: Crowi, pageId: Types.ObjectId, revisionId: Types.ObjectId): Promise<void> {
  const Revision = crowi.model('Revision');
  const revision = await Revision.findById(revisionId).select('page').lean().exec();
  if (revision == null) {
    throw new Error(`materializePendingEntry: revision ${String(revisionId)} not found (page ${String(pageId)})`);
  }
  assertRevisionPageMatches(pageId, revisionId, revision.page);
}

/**
 * The "does this Revision's `page` match the outbox slot's owning Page"
 * check shared by {@link assertRevisionOwnedByPage} (pre-write) and
 * {@link verifyRevisionMaterialized} (post-write) — same condition, same
 * message, so the two guards can never drift apart on what counts as a
 * mismatch.
 */
function assertRevisionPageMatches(pageId: Types.ObjectId, revisionId: Types.ObjectId, revisionPage: unknown): void {
  if (revisionPage == null || String(revisionPage) !== String(pageId)) {
    throw new Error(
      `materializePendingEntry: revision ${String(revisionId)} belongs to a different page than the outbox entry claims (page ${String(pageId)})`,
    );
  }
}

/**
 * Re-reads the Revision this `content_revision`/`migration_revision` entry
 * targeted and asserts it durably reflects the entry — never trust the
 * `updateOne` call site's `matchedCount`/`modifiedCount` alone, because
 * BOTH "this call just wrote it" and "a prior call already wrote the exact
 * same value" report `matchedCount: 0` against the `{ historySequence: null
 * }` filter (the second is the intended idempotent no-op; the first two
 * failure modes below are not). Throws — leaving the
 * outbox marker occupied for repair/operator investigation — rather than
 * draining over an undetected corruption:
 * - the Revision no longer exists (deleted out from under the entry),
 * - the Revision belongs to a different Page than this outbox slot, or
 * - `historySequence` (or, when checked, `historyOperationId`) durably
 *   holds a DIFFERENT value than this entry — i.e. a collision, not a
 *   repeat of this same write.
 */
async function verifyRevisionMaterialized(
  crowi: Crowi,
  pageId: Types.ObjectId,
  revisionId: Types.ObjectId,
  expectedSequence: number,
  expectedOperationId?: string,
): Promise<void> {
  const Revision = crowi.model('Revision');
  const revisionAfter = await Revision.findById(revisionId).select('page historySequence historyOperationId').lean().exec();
  if (revisionAfter == null) {
    throw new Error(`materializePendingEntry: revision ${String(revisionId)} not found while verifying materialization (page ${String(pageId)})`);
  }
  // Same "no legacy-orphan exemption on this outbox path" rationale as
  // `assertRevisionOwnedByPage` above — `null`/missing `page` is rejected
  // the same as a mismatched id.
  assertRevisionPageMatches(pageId, revisionId, revisionAfter.page);
  // AC-8b (codex review attempt 5/2, advisor follow-up): both mismatch
  // messages below deliberately omit the actual stored/expected values.
  // `.lean()` returns the raw driver output with NO schema casting applied
  // — a Number-typed `historySequence` corrupted via native-driver bypass
  // (e.g. an email string) survives this read completely unchanged; there
  // is no cast step here to reject it the way a live Mongoose Document's
  // hydration would. (This module's earlier — now corrected — assumption
  // that "a non-numeric value fails cast before reaching this comparison"
  // does not hold for a `.lean()` read; verified empirically that a
  // native-driver-injected string in a nested `payload` field survives an
  // equivalent hydration path elsewhere in this same file.) So neither
  // field here can be trusted to only ever hold a "safe" value — report
  // that a mismatch was found, never the raw value on either side.
  if (revisionAfter.historySequence !== expectedSequence) {
    throw new Error(`materializePendingEntry: revision ${String(revisionId)} historySequence mismatch (page ${String(pageId)}) — values redacted`);
  }
  if (expectedOperationId !== undefined && revisionAfter.historyOperationId !== expectedOperationId) {
    throw new Error(`materializePendingEntry: revision ${String(revisionId)} historyOperationId mismatch (page ${String(pageId)}) — values redacted`);
  }
}

/**
 * Clears `Page.pendingHistoryEntry` — but ONLY if it still holds an entry
 * with the SAME `entryId` (RFC §5.5, revised). Exported alongside
 * {@link materializePendingEntry} for the AC-5b drain-identity tests and for
 * Phase 2's future direct callers (a command that already knows its own
 * entry was materialized — e.g. by a prior partial attempt — and only needs
 * to clear the marker, without re-running the materialize step).
 *
 * Requires `entry.entryId` to be set: an entry without one would cast to a
 * Mongo filter value of `undefined`, which this driver/schema version
 * happens to match nothing (verified empirically — never "matches every
 * entry" the way a naive reading of "the filter degenerates to `{_id:
 * pageId}`" might suggest) — but that is an accident of the current BSON/
 * Mongoose cast behavior for a legacy, deprecated wire type, not a
 * guarantee this code should depend on. Reject explicitly instead: an
 * `entryId`-less entry is a caller bug (every real entry gets one before
 * it is ever placed — see `PendingHistoryEntry`'s doc comment), not a
 * legitimate "drain nothing" no-op.
 */
export async function drainPendingHistoryEntry(crowi: Crowi, pageId: Types.ObjectId, entry: PendingHistoryEntry): Promise<MaterializeResult> {
  if (entry.entryId == null) {
    throw new Error(`drainPendingHistoryEntry: entry is missing entryId (page ${String(pageId)}) — refusing to drain by an unscoped filter`);
  }
  const Page = crowi.model('Page');
  const result = await Page.updateOne({ _id: pageId, 'pendingHistoryEntry.entryId': entry.entryId }, { $unset: { pendingHistoryEntry: '' } }).exec();
  return { drained: result.modifiedCount === 1 };
}

/**
 * Reads `pageId`'s outbox slot and, if occupied, durably finishes it:
 *
 * - `page_event` — checks whether a `PageHistoryEvent` keyed by the outbox's
 *   pre-generated `_id` (the idempotency key, RFC §5.3) already exists
 *   FIRST, before touching `entry.event` at all. If it does, this is a
 *   repeat call after a prior success (possibly one that then crashed
 *   before draining) — "もう存在するなら何もしない" (spec §"設計の主な判断") — and
 *   nothing further is validated or written; only the drain below runs.
 *   Otherwise the document is validated (kind-scoped payload schema) BEFORE
 *   the write so nothing unvalidated is ever persisted, even though the
 *   write itself is a raw `updateOne` (Mongoose does not run schema
 *   validators on `update*` by default), and the entry's own `page` field is
 *   asserted to match `pageId` (the outbox slot's owner) — a corrupt entry
 *   naming a different Page is rejected outright rather than materializing
 *   an event for the wrong Page. Checking existence BEFORE validation matters:
 *   a native driver can corrupt the STAGED outbox copy (`entry.event`) after
 *   a successful upsert, and that corruption must never be able to block
 *   recovery of a target that is already durably written (codex review
 *   attempt 2/round 6, AC-5/AC-5b).
 * - `content_revision` / `migration_revision` — conditionally sets the
 *   target `Revision`'s `historySequence` (and, for `content_revision`,
 *   `historyOperationId`) ONLY while it is still unset (`historySequence:
 *   null` — matches both a missing field and an explicit `null`, codex
 *   review attempt 2, AC-7) — a second call after the first succeeded
 *   matches nothing and is a no-op. The target Revision's ownership is
 *   asserted BEFORE this write (see {@link assertRevisionOwnedByPage}).
 *
 * Either way, once the target state is durable, the outbox entry is
 * drained (identity-matched on `entryId` only — see
 * {@link drainPendingHistoryEntry}). Returns `{ drained: false }`
 * immediately if the outbox was already empty (nothing to do — including
 * the case where a PRIOR call to this same function already fully
 * completed).
 */
export async function materializePendingEntry(crowi: Crowi, pageId: Types.ObjectId): Promise<MaterializeResult> {
  const Page = crowi.model('Page');
  const page = (await Page.findById(pageId).select('pendingHistoryEntry').exec()) as PageDocument | null;
  const entry = page?.pendingHistoryEntry;
  if (entry == null) {
    return { drained: false };
  }
  assertWellFormedPendingEntry(entry);

  if (entry.type === 'page_event') {
    const PageHistoryEvent = crowi.model('PageHistoryEvent');
    // AC-5/AC-5b (codex review attempt 2/round 6): check "is this event
    // already durable" (by the pre-generated `_id`, the idempotency key —
    // RFC §5.3) BEFORE validating/hydrating `entry.event` at all. A prior
    // call to this function can have already upserted the event and then
    // crashed before draining the outbox marker (the AC-6 scenario); on
    // retry `entry.event` is re-read off the SAME Page document, so ANY
    // corruption of the outbox's (now-redundant) staged copy — a
    // native-driver-injected unknown field in particular — used to make
    // `new PageHistoryEvent(entry.event)` throw a `StrictModeError` on
    // every subsequent retry, permanently blocking recovery of a target
    // that was already durably materialized. Once the `_id` is confirmed to
    // already exist, nothing about `entry.event`'s content matters anymore
    // — proceed straight to drain, the same "already exists -> no-op"
    // contract this function's own doc comment describes.
    const alreadyMaterialized = (await PageHistoryEvent.exists({ _id: entry.event._id })) != null;
    if (!alreadyMaterialized) {
      if (String(entry.event.page) !== String(pageId)) {
        throw new Error(
          `materializePendingEntry: page_event outbox entry claims page ${String(entry.event.page)} but is stored in Page ${String(pageId)}'s outbox slot`,
        );
      }

      const candidate = new PageHistoryEvent(entry.event);
      await candidate.validate();
      const validated = candidate.toObject() as unknown as Record<string, unknown>;
      delete validated._id;
      await PageHistoryEvent.updateOne({ _id: entry.event._id }, { $setOnInsert: validated }, { upsert: true }).exec();
    }
  } else if (entry.type === 'content_revision') {
    await assertRevisionOwnedByPage(crowi, pageId, entry.revisionId);
    const Revision = crowi.model('Revision');
    // `page: pageId` in the filter is belt-and-suspenders alongside the
    // pre-write `assertRevisionOwnedByPage` check above: even if the
    // Revision's ownership changed between that read and this write, the
    // conditional update itself can never stamp a foreign/orphan Revision.
    // `historySequence: null` (codex review attempt 2, AC-7) matches BOTH a
    // MISSING field and an EXPLICIT `null` — MongoDB's documented equality
    // rule for `null` — so a Revision some earlier bug/corruption left with
    // a literal `null` (as opposed to simply never having the field) is
    // still treated as unsequenced and eligible for this write, not as
    // "already assigned".
    await Revision.updateOne(
      { _id: entry.revisionId, page: pageId, historySequence: null },
      { $set: { historySequence: entry.sequence, historyOperationId: entry.operationId } },
    ).exec();
    await verifyRevisionMaterialized(crowi, pageId, entry.revisionId, entry.sequence, entry.operationId);
  } else if (entry.type === 'migration_revision') {
    await assertRevisionOwnedByPage(crowi, pageId, entry.revisionId);
    const Revision = crowi.model('Revision');
    await Revision.updateOne({ _id: entry.revisionId, page: pageId, historySequence: null }, { $set: { historySequence: entry.sequence } }).exec();
    await verifyRevisionMaterialized(crowi, pageId, entry.revisionId, entry.sequence);
  }

  return drainPendingHistoryEntry(crowi, pageId, entry);
}
