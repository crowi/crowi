import mongoose, { Types } from 'mongoose';

import Crowi from 'src/crowi';
import type { PendingHistoryEntry } from 'src/models/page';
import { isDuplicateKeyError } from 'src/util/map-duplicate-key-error';
import { materializePendingEntry } from './materialize';

/**
 * RFC-0021 §6.4/§13.2a (`feature-page-history-phase1-model`, Phase 1) —
 * repair for the two failure classes Phase 1 must detect and fix ahead of
 * Phase 2 enabling any history-producing writer:
 *
 * (a) {@link repairPendingEntries} — a Page whose outbox slot
 *     (`pendingHistoryEntry`) is still occupied because a prior writer
 *     crashed between materializing its target and draining the marker.
 * (b)/(c) {@link scanUnsequencedRevisions} — a `ready` Page with a Revision
 *     that has no `historySequence` (RFC §13.2a: a replica that doesn't
 *     evaluate `historyTracking.state` can still append an unsequenced
 *     Revision to an already-`ready` Page — no predicate can stop it, only
 *     detect it), and the cross-collection duplicate-sequence corruption
 *     check that must pass before any such Page is repaired.
 *
 * Phase 1 wires NO boot hook, background scheduler, or HTTP route to call
 * these — only an explicitly operator-invoked entry point
 * (`util/page-history-repair.ts` -> `crowi-admin page-history repair`,
 * RFC §6.4's "運用者が起動できる入口も用意する"). In normal Phase-1 operation
 * that entry point finds nothing to do (the spec's flow section: "テストが
 * 唯一の実行者であり、それが意図した状態である" — Phase 1 ships no writer, so no outbox
 * entry and no unsequenced Revision on a `ready` Page exists outside a
 * test). `scanUnsequencedRevisions` in particular must stay off any
 * automatic trigger (boot / scheduler): every Phase 1 Page is `ready` with
 * unsequenced Revisions by construction, so an unconditional auto-run would
 * mass-assign sequences that Phase 2's real backfill migration (RFC §13.2)
 * is the one that owns — `util/page-history-repair.ts` keeps that scan
 * behind its own explicit `--scan` flag for exactly this reason.
 */

/**
 * `revisionId`/`sequence` are populated when the failed outbox entry names a
 * specific Revision/sequence (`content_revision`/`migration_revision` — and
 * `page_event`'s own `sequence`, though that variant has no `revisionId`) —
 * left `undefined` when the failure isn't tied to one (codex review attempt
 * 3, AC-7/8: "operator report ... `failed` lacks revision/sequence"), so the
 * operator-facing report (`util/page-history-repair.ts` /
 * `@crowi/admin-cli`'s `formatRepairReport`) can print exactly which
 * Revision/sequence a failure concerns instead of only the Page.
 */
export interface OutboxRepairFailure {
  pageId: string;
  revisionId?: string;
  sequence?: number;
  reason: string;
}

/**
 * AC-8b (advisor follow-up): `entry` here is read via `.lean()`
 * (`repairPendingEntries`'s batch query selects `pendingHistoryEntry`
 * without hydrating a live Mongoose Document), so NO schema casting was
 * ever applied to it — a native-driver-injected non-ObjectId value in
 * `revisionId`, or a non-Number value in `sequence`, survives this read
 * completely unchanged. Passing either straight through (`String(...)`, or
 * as-is) into the operator-facing `OutboxRepairFailure` would report that
 * raw corrupted value verbatim. Only surface a value that actually has the
 * shape it claims; anything else is dropped (`undefined`), never reported
 * as a stand-in raw value.
 */
function isObjectIdLike(value: unknown): value is Types.ObjectId {
  return value instanceof Types.ObjectId || (typeof value === 'string' && /^[0-9a-f]{24}$/i.test(value));
}

/**
 * True-numeric guard shared by every place a `historySequence`/`sequence`
 * value read via `.lean()` (NO schema casting applied) flows toward an
 * operator-facing report field typed `number` (AC-8b) — a native-driver-
 * injected non-numeric value (a string, an object, ...) must never be
 * reported as though it were a legitimate sequence. `Number.isFinite`
 * additionally rejects `NaN`/`Infinity`, which a raw driver write could also
 * produce.
 */
function safeSequenceValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Extracts `{revisionId, sequence}` from an outbox entry for {@link OutboxRepairFailure} reporting — `page_event` carries no `revisionId` (only its own `sequence`). */
function pendingEntryRevisionAndSequence(entry: PendingHistoryEntry | undefined | null): { revisionId?: string; sequence?: number } {
  if (entry == null) return {};
  const safeRevisionId = (value: unknown): string | undefined => (isObjectIdLike(value) ? String(value) : undefined);
  switch (entry.type) {
    case 'page_event':
      return { sequence: safeSequenceValue(entry.event?.sequence) };
    case 'content_revision':
    case 'migration_revision':
      return { revisionId: safeRevisionId(entry.revisionId), sequence: safeSequenceValue(entry.sequence) };
    default:
      return {};
  }
}

/**
 * AC-8b (spec §"設計の主な判断": "修復レポートに値そのものを載せない") — a Mongoose
 * `ValidationError`'s own `.message` is NOT the short "Xxx validation
 * failed" its constructor sets; `ValidationError#addError` (mongoose's
 * `lib/error/validation.js`) overwrites `.message` with
 * `combinePathErrors(this)`, which concatenates every failing path's OWN
 * error `.message` — and a `CastError`/`ValidatorError`'s message
 * interpolates the RAW violating value (e.g. `Cast to Number failed for
 * value "someone@example.com" ...`). A corrupt or native-driver-injected
 * outbox entry can put an arbitrary string — a real user's email, a page's
 * share token, anything — into a validated field (`candidate.validate()` in
 * `materialize.ts`'s `page_event` branch is the reachable path), so passing
 * `err.message` straight through into an operator-facing `reason`
 * (destined for logs / `crowi-admin` stdout) risks leaking it. Field NAMES
 * are kept — an operator needs to know WHICH field failed; VALUES are not.
 *
 * Exported (codex review attempt 2, round 6: "admin-cli prints raw
 * initialization/repair error messages ... escaping the service-level
 * per-page catches") — `@crowi/api`'s `util/page-history-repair.ts`
 * re-exports this so `@crowi/admin-cli`'s `page-history repair` command can
 * apply the SAME redaction to the two error paths that escape every
 * service-level per-page `try`/`catch` in this file: Crowi initialization
 * failure and a structural failure inside `runPageHistoryRepair` itself.
 */
export function redactErrorReason(err: unknown): string {
  if (err instanceof mongoose.Error.ValidationError) {
    const paths = Object.keys(err.errors);
    return `validation failed: ${paths.map((p) => `${p}: [redacted]`).join(', ')}`;
  }
  if (err instanceof mongoose.Error.CastError) {
    return `cast failed: ${err.path}: [redacted]`;
  }
  if (err instanceof mongoose.Error.StrictModeError) {
    // `StrictModeError#message` is already field-name-only ("Field `X` is
    // not in schema and strict mode is set to throw.") — no raw value to
    // redact — but routed through the same `field: [redacted]` shape for
    // consistency with the other two branches above.
    return `strict mode rejected unknown field: ${err.path}: [redacted]`;
  }
  if (isDuplicateKeyError(err)) {
    // AC-8b (codex review attempt 2, round 6): a MongoDB duplicate-key
    // (E11000) error is raised by the DRIVER, not Mongoose — it is never an
    // instance of any `mongoose.Error` subclass above, so without this
    // branch it fell through to the generic `err.message` fallback below.
    // That message embeds the raw colliding value verbatim (e.g. `E11000
    // duplicate key error ... dup key: { page: ..., operationId:
    // "someone@example.com", kind: "visibility_changed" }`) — reachable via
    // `materialize.ts`'s `page_event` upsert when a corrupt/native-driver-
    // written entry's `operationId` collides with an existing event's
    // `{page, operationId, kind}` under a DIFFERENT `_id`. Report only the
    // colliding FIELD NAMES from the driver's structured `keyPattern`/
    // `keyValue` (same source `util/map-duplicate-key-error.ts` prefers),
    // never the message.
    const mongoErr = err as { keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown> };
    const fields = Object.keys(mongoErr.keyPattern ?? mongoErr.keyValue ?? {});
    return fields.length > 0 ? `duplicate key: ${fields.map((f) => `${f}: [redacted]`).join(', ')}` : 'duplicate key: [redacted]';
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Shared bounded/resumable-scan options (codex review attempt 3, implementation
 * map: "Page-by-page batch, resumable" — the prior version's `Page.find(...).exec()`
 * loaded every matching Page into memory in one round-trip, unbounded).
 * Both {@link repairPendingEntries} and {@link scanUnsequencedRevisions} page
 * through their match with an `_id`-sorted cursor instead, so memory per call
 * stays bounded by `batchSize` regardless of how many Pages match, and a
 * caller that persists a prior call's `lastPageId` can resume exactly where
 * it left off (e.g. after the operator CLI process itself was killed
 * mid-scan) via `resumeAfterId`.
 */
export interface RepairScanOptions {
  /** Bounds how many Page documents are loaded into memory per round-trip; defaults to 200. Exposed mainly so tests can force multiple internal batches against a handful of fixtures. */
  batchSize?: number;
  /** Resume a previous (possibly interrupted) scan: only Pages with `_id > resumeAfterId` are visited. Pair with a prior call's `lastPageId`. */
  resumeAfterId?: Types.ObjectId | string;
}

const DEFAULT_REPAIR_BATCH_SIZE = 200;

function resolveCursor(resumeAfterId: Types.ObjectId | string | undefined): Types.ObjectId | undefined {
  if (resumeAfterId == null) return undefined;
  return typeof resumeAfterId === 'string' ? new Types.ObjectId(resumeAfterId) : resumeAfterId;
}

/**
 * Validates `RepairScanOptions.batchSize` (advisory, codex review attempt 2,
 * round 6) — the bounded-scan guarantee both {@link repairPendingEntries} and
 * {@link scanUnsequencedRevisions} document only holds if `batchSize` is a
 * genuine positive integer. MongoDB's `Query#limit(0)` means UNBOUNDED (not
 * "zero results"), so a programmatic caller passing `0` — or a negative /
 * non-integer value, which would cast to something Mongo either rejects or
 * silently coerces — could otherwise defeat the bound this option exists to
 * provide, even though the CLI wrapper (`@crowi/admin-cli`'s
 * `parsePositiveIntOption`) already validates its own `--batch-size` input.
 * Throws before either scan does any work.
 */
function resolveBatchSize(batchSize: number | undefined): number {
  if (batchSize === undefined) return DEFAULT_REPAIR_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`RepairScanOptions.batchSize must be a positive integer, got ${JSON.stringify(batchSize)}`);
  }
  return batchSize;
}

export interface OutboxRepairResult {
  /** Pages found with a non-empty `pendingHistoryEntry` at scan time. */
  scannedPages: number;
  /** Pages whose outbox slot this call successfully drained. */
  repairedPageIds: string[];
  /**
   * Pages `materializePendingEntry` rejected as corrupt (verify-before-drain
   * mismatch, malformed entry, ...) — reported, never silently swallowed.
   * One corrupt Page must not abort the scan for every OTHER pending Page
   * (codex review attempt 2), so this loop always continues past a failure.
   */
  failed: OutboxRepairFailure[];
  /** The highest Page `_id` visited this call (as a string), or `null` if nothing matched. Pass as `resumeAfterId` to a later call to continue from just after it. */
  lastPageId: string | null;
}

/**
 * Background/operator repair path (a): scans every Page with a non-empty
 * `pendingHistoryEntry` and re-runs {@link materializePendingEntry} for
 * each. Idempotent by construction (materialize.ts's own doc comment) — a
 * Page whose outbox was already fully materialized before a crash simply
 * gets its marker drained on this pass; a Page with nothing pending is
 * never visited (empty-outbox pages don't match the scan filter).
 *
 * Each Page is materialized independently inside its own try/catch: a
 * `materializePendingEntry` rejection (e.g. its verify-before-drain guard
 * catching a corrupt outbox entry) is collected into `failed` instead of
 * propagating, so one bad Page can never stop the rest of the batch from
 * being repaired.
 *
 * Pages within a call are visited in bounded batches (`options.batchSize`,
 * default 200) via an `_id`-sorted cursor, so a call over a large pending
 * set never holds more than one batch in memory. When nothing matches, the
 * cost is exactly one index scan that returns zero rows (spec's Performance
 * contract).
 */
export async function repairPendingEntries(crowi: Crowi, options: RepairScanOptions = {}): Promise<OutboxRepairResult> {
  const Page = crowi.model('Page');
  const batchSize = resolveBatchSize(options.batchSize);

  const repairedPageIds: string[] = [];
  const failed: OutboxRepairFailure[] = [];
  let scannedPages = 0;
  let cursor = resolveCursor(options.resumeAfterId);
  let lastPageId: string | null = null;

  for (;;) {
    const match: Record<string, unknown> = { pendingHistoryEntry: { $exists: true } };
    if (cursor != null) match._id = { $gt: cursor };
    // `pendingHistoryEntry` is selected alongside `_id` (not re-read after a
    // failure) so a rejected entry's own revisionId/sequence can be reported
    // in `failed` (codex review attempt 3, AC-7/8) — `materializePendingEntry`
    // never mutates the outbox before it throws, so this in-hand copy is
    // still exactly what it saw.
    const batch = await Page.find(match).sort({ _id: 1 }).limit(batchSize).select('_id pendingHistoryEntry').lean().exec();
    if (batch.length === 0) break;

    for (const row of batch) {
      const pageId = row._id as Types.ObjectId;
      scannedPages += 1;
      cursor = pageId;
      lastPageId = String(pageId);
      try {
        const result = await materializePendingEntry(crowi, pageId);
        if (result.drained) {
          repairedPageIds.push(String(pageId));
        }
      } catch (err) {
        const entry = row.pendingHistoryEntry as PendingHistoryEntry | undefined | null;
        failed.push({
          pageId: String(pageId),
          ...pendingEntryRevisionAndSequence(entry),
          reason: redactErrorReason(err),
        });
      }
    }

    if (batch.length < batchSize) break;
  }

  return { scannedPages, repairedPageIds, failed, lastPageId };
}

/** `reason` (codex review attempt 3, AC-7/8: "operator report ... `repaired` lacks `reason`") explains WHY this Revision was assigned a sequence, for the operator-facing report — not just that it was. */
export interface RepairedRevisionSequence {
  pageId: Types.ObjectId;
  revisionId: Types.ObjectId;
  assignedSequence: number;
  reason: string;
}

/**
 * `revisionId` (codex review attempt 3, AC-7/8: "operator report ... `blocked`
 * lacks revision identity") names ONE Revision that holds the duplicate/lagged
 * sequence — `undefined` only for the (Phase-1-unreachable, since no writer
 * creates a `PageHistoryEvent` yet) case where every owner of that sequence is
 * a `PageHistoryEvent` instead. `reason` always enumerates every owner (kind +
 * id), so a duplicate spanning `Revision` and `PageHistoryEvent` is fully
 * identifiable from the string even when only one id fits the structured field.
 */
export interface BlockedPageForDuplicateSequence {
  pageId: Types.ObjectId;
  revisionId?: Types.ObjectId;
  duplicateSequence: number;
  reason: string;
}

/** One `{kind, id}` owner of a given `historySequence`/`PageHistoryEvent.sequence` value — used only to build a {@link BlockedPageForDuplicateSequence} report. */
interface SequenceOwner {
  kind: 'revision' | 'page_event';
  id: Types.ObjectId;
}

/** Renders every owner of a duplicated/lagged sequence value into the `reason` string (codex review attempt 3: the structured `revisionId` field alone can't name a `page_event` owner). */
function describeSequenceOwners(owners: SequenceOwner[]): string {
  return owners.map((o) => `${o.kind} ${String(o.id)}`).join(', ');
}

/** The first `revision`-kind owner's id, if any — the structured `revisionId` field on {@link BlockedPageForDuplicateSequence}. */
function firstRevisionOwner(owners: SequenceOwner[]): Types.ObjectId | undefined {
  return owners.find((o) => o.kind === 'revision')?.id;
}

export interface UnsequencedRevisionScanResult {
  /** `ready` Pages visited. */
  scannedPages: number;
  /** Revisions the scan found without a `historySequence` and successfully assigned one to, oldest (`createdAt, _id`) first. */
  repaired: RepairedRevisionSequence[];
  /** Pages the scan found a duplicate `historySequence` on (across `Revision` and `PageHistoryEvent`) — reported, NOT auto-repaired. */
  blocked: BlockedPageForDuplicateSequence[];
  /**
   * Pages where assigning a sequence hit an error unrelated to the
   * duplicate/allocator-lag checks above — e.g. a Page whose outbox slot
   * was already occupied by an entry `materializePendingEntry` rejects as
   * corrupt (a stale/malformed entry left by something other than this
   * scan). One such Page must not abort the scan for every OTHER ready
   * Page (same reasoning as `repairPendingEntries`'s `failed`).
   */
  failed: OutboxRepairFailure[];
  /** The highest Page `_id` visited this call (as a string), or `null` if nothing matched. Pass as `resumeAfterId` to a later call to continue from just after it. */
  lastPageId: string | null;
}

/** `migrationOwner` tag this repair path stamps on the outbox entries it claims — distinguishes its writes from a future Phase 2 migration worker's. */
const REPAIR_MIGRATION_OWNER = 'repair:scanUnsequencedRevisions';

/** Bounds the claim retry loop below — Phase 1 has no concurrent claimant, so this only guards against a pathological repeated CAS loss. */
const MAX_CLAIM_ATTEMPTS = 3;

/**
 * Thrown by {@link claimAndAssignSequence} ONLY when the CAS that allocates
 * `nextSequence` already committed (the Page's `historySequence` allocator
 * has durably moved) but the immediately-following `materializePendingEntry`
 * call then fails — e.g. the target Revision was deleted or reparented
 * between the CAS and the materialize read (codex review attempt 4, AC-7/8:
 * "failed[] entry captures pageId/revisionId/reason but omits the sequence
 * value ... scan-failure entries must preserve the known sequence"). Carries
 * `assignedSequence` so {@link scanOneReadyPage} can report the sequence this
 * call actually claimed on the allocator, even though the write to the
 * target was never durably confirmed. Deliberately NOT thrown by the
 * earlier "found the slot already occupied by someone else, drained it,
 * retry" branch — that materialize call never claimed a sequence of its
 * own, so it must not be misreported as one.
 */
class ClaimedSequenceMaterializeError extends Error {
  readonly assignedSequence: number;
  constructor(assignedSequence: number, cause: unknown) {
    // AC-8b: `.message` is what ends up in the operator-facing `reason`
    // below (via `redactErrorReason`, which passes a plain `Error`'s
    // `.message` through unchanged) — redact `cause` HERE so a raw
    // Mongoose validation message can never reach it. `cause` itself is
    // still attached (unredacted) for local debugging/stack traces, never
    // surfaced to a report.
    super(redactErrorReason(cause));
    this.name = 'ClaimedSequenceMaterializeError';
    this.assignedSequence = assignedSequence;
    if (cause instanceof Error) this.cause = cause;
  }
}

/**
 * Claims the outbox slot for `revisionId` with a `migration_revision` entry
 * (the same one-slot mechanism RFC §13.2's real backfill migration uses —
 * "the migration variant uses the same bounded mechanism while writers are
 * fenced"), then materializes it. Returns the assigned sequence, or `null`
 * if the claim could not be won within {@link MAX_CLAIM_ATTEMPTS} attempts
 * (a future repair pass will retry — this never loses the Revision, only
 * defers it). Throws {@link ClaimedSequenceMaterializeError} (not the raw
 * materialize error) when the claim itself succeeded but materializing it
 * failed, so the sequence this call allocated is never lost from the
 * caller's error report.
 */
async function claimAndAssignSequence(crowi: Crowi, pageId: Types.ObjectId, revisionId: Types.ObjectId): Promise<number | null> {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    // Fresh re-check (codex review attempt 3, AC-6/7 parallel-scan race): a
    // concurrent `scanUnsequencedRevisions` pass (another process, or an
    // earlier iteration of THIS loop that helped drain someone else's
    // occupied slot below) may have already assigned `revisionId` a
    // sequence since it was enumerated in the caller's now-stale
    // `missingRevisions` snapshot. Re-verify on EVERY attempt — not just
    // the first — so this call never burns a `Page.historySequence`
    // increment (or worse, leaves an unresolvable outbox collision that
    // repair can't converge on) assigning to a Revision someone else
    // already finished.
    //
    // `!= null` (codex review attempt 2, round 6, AC-7) — NOT `!==
    // undefined` — because an explicit `historySequence: null` must be
    // treated the SAME as the field being entirely absent (both mean
    // "unsequenced"), matching `materialize.ts`'s `{ historySequence: null
    // }` CAS filter (MongoDB's own equality rule for `null`). The prior
    // `!== undefined` check treated an explicit `null` as "already
    // assigned" and bailed out, silently leaving that Revision unsequenced
    // forever.
    const currentRevision = await Revision.findById(revisionId).select('historySequence').lean().exec();
    if (currentRevision == null || currentRevision.historySequence != null) {
      return null;
    }

    const current = await Page.findById(pageId).select('historySequence pendingHistoryEntry').exec();
    if (current == null) {
      return null;
    }
    if (current.pendingHistoryEntry != null) {
      // The slot is occupied by someone else's entry — drain it via the
      // normal materializer, then retry the read on the next loop turn.
      await materializePendingEntry(crowi, pageId);
      continue;
    }

    const expectedSequence = current.historySequence;
    const nextSequence = expectedSequence + 1;
    // `entryId` (RFC §5.5, revised) is generated HERE — before the CAS that
    // writes it — per the same "the id must exist before the write it
    // identifies" timing principle `PageHistoryOperation`'s
    // `Idempotency-Key` follows. It is the ONLY field
    // `drainPendingHistoryEntry` (materialize.ts) matches on to clear this
    // claim's slot.
    const claim = await Page.updateOne(
      { _id: pageId, historySequence: expectedSequence, pendingHistoryEntry: null },
      {
        $set: {
          historySequence: nextSequence,
          pendingHistoryEntry: {
            entryId: new Types.ObjectId(),
            type: 'migration_revision',
            revisionId,
            sequence: nextSequence,
            migrationOwner: REPAIR_MIGRATION_OWNER,
          },
        },
      },
      // Defense-in-depth only — `assertWellFormedPendingEntry`
      // (materialize.ts) is the enforcement this repair path actually
      // depends on, since mongoose update validators do not run document
      // `pre('validate')` middleware (`pendingHistoryEntrySchema`'s hook).
      // This entry is always well-formed by construction anyway (every
      // field is a literal above); kept for parity with any FUTURE caller
      // of this same CAS shape.
      { runValidators: true },
    ).exec();
    if (claim.modifiedCount !== 1) {
      // Lost the race (someone else advanced historySequence or claimed the
      // slot between the read and this write) — retry.
      continue;
    }
    try {
      await materializePendingEntry(crowi, pageId);
    } catch (err) {
      // The CAS above already durably allocated `nextSequence` on the Page's
      // allocator — wrap so the caller can still report it (codex review
      // attempt 4).
      throw new ClaimedSequenceMaterializeError(nextSequence, err);
    }
    return nextSequence;
  }

  return null;
}

/**
 * Repair paths (b) and (c): walks every `ready` Page (RFC §13.2a — Phase 1
 * populates this set from new-Page creation only) and, per Page:
 *
 * 1. Verifies `Revision.historySequence` and `PageHistoryEvent.sequence`
 *    values for the Page share no duplicate (the normative cross-collection
 *    invariant the spec's Transaction/concurrency contract describes). If a
 *    duplicate is found, the Page is reported as `blocked` and NOTHING is
 *    assigned to it this pass — "重複は破損であり、勝手に直すと履歴が嘘になる".
 * 2. Otherwise, finds Revisions with no `historySequence`, oldest
 *    (`createdAt, _id`) first, and assigns each a fresh sequence via
 *    {@link claimAndAssignSequence} — ordering a late-detected write after
 *    everything already committed, "since it was in fact written later"
 *    (RFC §13.2a).
 *
 * `ready` Pages are visited in bounded batches (`options.batchSize`,
 * default 200) via an `_id`-sorted cursor, same rationale as
 * `repairPendingEntries` above.
 */
export async function scanUnsequencedRevisions(crowi: Crowi, options: RepairScanOptions = {}): Promise<UnsequencedRevisionScanResult> {
  const Page = crowi.model('Page');
  const batchSize = resolveBatchSize(options.batchSize);

  const repaired: RepairedRevisionSequence[] = [];
  const blocked: BlockedPageForDuplicateSequence[] = [];
  const failed: OutboxRepairFailure[] = [];
  let scannedPages = 0;
  let cursor = resolveCursor(options.resumeAfterId);
  let lastPageId: string | null = null;

  for (;;) {
    const match: Record<string, unknown> = { 'historyTracking.state': 'ready' };
    if (cursor != null) match._id = { $gt: cursor };
    const batch = await Page.find(match).sort({ _id: 1 }).limit(batchSize).select('_id').lean().exec();
    if (batch.length === 0) break;

    for (const row of batch) {
      const pageId = row._id as Types.ObjectId;
      scannedPages += 1;
      cursor = pageId;
      lastPageId = String(pageId);
      try {
        await scanOneReadyPage(crowi, pageId, { repaired, blocked, failed });
      } catch (err) {
        // A failure NOT tied to any one Revision claim (e.g. the initial
        // Revision/PageHistoryEvent lookup itself) — the per-revision catch
        // inside `scanOneReadyPage` handles the claim-loop case with
        // revisionId attached; this is the page-level net around everything
        // else. Report and move on to the next Page rather than abort the
        // whole batch (codex review attempt 2).
        failed.push({ pageId: String(pageId), reason: redactErrorReason(err) });
      }
    }

    if (batch.length < batchSize) break;
  }

  return { scannedPages, repaired, blocked, failed, lastPageId };
}

/** One ready Page's worth of work for {@link scanUnsequencedRevisions} — split out so the per-Page try/catch above has a single call to wrap. */
async function scanOneReadyPage(
  crowi: Crowi,
  pageId: Types.ObjectId,
  into: { repaired: RepairedRevisionSequence[]; blocked: BlockedPageForDuplicateSequence[]; failed: OutboxRepairFailure[] },
): Promise<void> {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const PageHistoryEvent = crowi.model('PageHistoryEvent');
  const { repaired, blocked, failed } = into;

  // `historySequence: { $exists: true, $ne: null }` (codex review attempt 2,
  // round 6, AC-7) — the field must be BOTH present AND not `null` to count
  // as "actually assigned". A plain `{ $exists: true }` also matches a
  // Revision whose `historySequence` was explicitly set to `null` (by an
  // earlier bug or corruption), which would then flow into `sequenceOwners`
  // below as though `null` were a real sequence value — treating an
  // unsequenced Revision as already-sequenced (and, if two such rows exist,
  // manufacturing a false "duplicate" report keyed on `null`).
  const [revisionRows, eventRows] = await Promise.all([
    Revision.find({ page: pageId, historySequence: { $exists: true, $ne: null } })
      .select('_id historySequence')
      .lean()
      .exec(),
    PageHistoryEvent.find({ page: pageId }).select('_id sequence').lean().exec(),
  ]);

  // `sequenceOwners` (codex review attempt 3, AC-7/8: "operator report ...
  // `blocked` lacks revision identity") tracks WHICH Revision/PageHistoryEvent
  // holds each sequence value, not just how many rows do — see
  // `BlockedPageForDuplicateSequence`'s doc comment.
  const sequenceOwners = new Map<number, SequenceOwner[]>();
  for (const r of revisionRows) {
    // AC-8b (codex review attempt 2, round 6): `.lean()` applies NO schema
    // casting — a native-driver-injected non-numeric `historySequence`
    // survives this read unchanged. Reject it here, before it can become a
    // `Map` key: letting it through risked a corrupted (secret-shaped) value
    // reaching `duplicateSequence` verbatim if two rows happened to share it.
    const seq = safeSequenceValue(r.historySequence);
    if (seq === undefined) {
      failed.push({
        pageId: String(pageId),
        revisionId: String(r._id),
        reason: 'revision has a non-numeric historySequence value — corrupted; skipping this page (value redacted)',
      });
      return;
    }
    const owners = sequenceOwners.get(seq) ?? [];
    owners.push({ kind: 'revision', id: r._id as Types.ObjectId });
    sequenceOwners.set(seq, owners);
  }
  for (const e of eventRows) {
    const seq = safeSequenceValue(e.sequence);
    if (seq === undefined) {
      failed.push({
        pageId: String(pageId),
        reason: 'a PageHistoryEvent has a non-numeric sequence value — corrupted; skipping this page (value redacted)',
      });
      return;
    }
    const owners = sequenceOwners.get(seq) ?? [];
    owners.push({ kind: 'page_event', id: e._id as Types.ObjectId });
    sequenceOwners.set(seq, owners);
  }
  const duplicate = Array.from(sequenceOwners.entries()).find(([, owners]) => owners.length > 1);
  if (duplicate) {
    const [duplicateSequence, owners] = duplicate;
    blocked.push({
      pageId,
      revisionId: firstRevisionOwner(owners),
      duplicateSequence,
      reason: `duplicate historySequence across Revision/PageHistoryEvent (${describeSequenceOwners(owners)}) — blocked for manual repair, not auto-fixed`,
    });
    return;
  }

  // Allocator-vs-max validation (codex review attempt 2, spec's
  // Transaction/concurrency contract: "修復処理が ready な Page を提供する前に
  // 両者が sequence を共有していないことを検証する"). `Page.historySequence`
  // is the SOLE next-sequence allocator (see `claimAndAssignSequence`
  // below) — if it has already fallen behind the highest sequence any
  // Revision/PageHistoryEvent actually holds, the next value it would
  // hand out can collide with one already committed. That is corruption
  // in its own right (the counter and its rows have desynchronized), not
  // a case this scan may paper over by incrementing anyway — block, the
  // same as an already-realized duplicate. A counter AHEAD of the max is
  // normal (a crashed claim can leave a gap) and is not flagged.
  //
  // The counter itself is re-read HERE, fresh — never from the batch-time
  // `Page.find(...)` snapshot the caller enumerated this Page from (codex
  // review attempt 5/2: a controlled two-scan race showed a paused scan
  // resuming with a stale `counterValue` that pre-dated a CONCURRENT
  // `claimAndAssignSequence` CAS which had already durably advanced both
  // the allocator and the Revision it targeted — falsely reporting a
  // healthy Page as blocked). Reading it AFTER `revisionRows`/`eventRows`
  // above only narrows the staleness window further in the safe direction:
  // a counter that has since moved AHEAD of what this read of the rows saw
  // is the documented "counter ahead of max is normal" case, never a false
  // block.
  const currentPage = await Page.findById(pageId).select('historySequence').lean().exec();
  const counterValue = (currentPage?.historySequence as number | undefined) ?? 0;

  const maxAssignedSequence = sequenceOwners.size > 0 ? Math.max(...sequenceOwners.keys()) : 0;
  if (counterValue < maxAssignedSequence) {
    const owners = sequenceOwners.get(maxAssignedSequence) ?? [];
    blocked.push({
      pageId,
      revisionId: firstRevisionOwner(owners),
      duplicateSequence: maxAssignedSequence,
      reason: `historySequence counter (${counterValue}) is behind the highest assigned sequence (${maxAssignedSequence}, held by ${describeSequenceOwners(owners)}) — allocating from it would risk a collision; blocked for manual repair, not auto-fixed`,
    });
    return;
  }

  // `historySequence: null` (codex review attempt 2, round 6, AC-7) matches
  // BOTH a missing field and an explicit `null` (MongoDB's documented
  // equality rule for `null`) — the counterpart to the `$ne: null` query
  // above, so a Revision left with a literal `null` by an earlier bug is
  // still found here as unsequenced instead of being invisible to repair.
  const missingRevisions = await Revision.find({ page: pageId, historySequence: null }).sort({ createdAt: 1, _id: 1 }).select('_id').lean().exec();

  for (const missing of missingRevisions) {
    const revisionId = missing._id as Types.ObjectId;
    try {
      const assignedSequence = await claimAndAssignSequence(crowi, pageId, revisionId);
      if (assignedSequence != null) {
        repaired.push({
          pageId,
          revisionId,
          assignedSequence,
          reason: 'unsequenced Revision assigned a sequence in createdAt,_id order (oldest first) by the repair scan',
        });
      }
    } catch (err) {
      // `claimAndAssignSequence` can reach into ANOTHER writer's occupied
      // outbox slot to drain it before claiming (see its doc comment) — that
      // materialize call can throw on a corrupt/malformed entry left by
      // something other than this scan. That same occupied-slot condition
      // would reject identically for every OTHER Revision still queued on
      // THIS Page (the outbox is a single Page-wide slot), so report once
      // and stop this Page's loop — rather than emit one duplicate `failed`
      // entry per remaining Revision — while still letting every OTHER Page
      // in the batch proceed untouched.
      //
      // `ClaimedSequenceMaterializeError` (codex review attempt 4) means the
      // CAS itself already committed `assignedSequence` on the allocator
      // before materializing failed — surface it so the operator report
      // doesn't lose the one piece of state that IS durable.
      const sequence = err instanceof ClaimedSequenceMaterializeError ? err.assignedSequence : undefined;
      failed.push({ pageId: String(pageId), revisionId: String(revisionId), sequence, reason: redactErrorReason(err) });
      return;
    }
  }
}
