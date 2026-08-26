import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';

import Crowi from 'src/crowi';
import type { PageDocument, PendingHistoryEntry } from 'src/models/page';
import {
  PAGE_HISTORY_EVENT_SOURCES,
  type PageHistoryEventKind,
  type PageHistoryEventSource,
  type PageHistoryPayloadByKind,
} from 'src/models/page-history-event';
import { materializePendingEntry } from './materialize';

/**
 * RFC-0021 §6.2 (Phase 2c-1) — the shared command skeleton every metadata-
 * event writer is built on (`commands/visibility.ts`'s `changePageVisibility`
 * first, `publishDraftPage` next). One Page CAS confirms the domain state
 * change (`plan`'s `set`) and the metadata event's outbox entry TOGETHER —
 * there is no window where one exists without the other. Only `PendingHistoryEntry`/
 * `materializePendingEntry` (Phase 1) exist below this; no lease, reaper, or
 * new Page field is introduced (DC-9).
 *
 * Only `Types.ObjectId`/plain-value imports come from `models/page-history-event`
 * (no cycle: that module never imports `models/page`). `PageDocument`/
 * `PendingHistoryEntry` are `import type` ONLY — a value import here would
 * recreate the `models/page.ts` <-> this-module runtime cycle `page-grants.ts`'s
 * doc comment documents (a `tsx`-run entry point throws a TDZ `ReferenceError`
 * on it), since `models/page.ts` itself imports `commands/visibility.ts` (which
 * imports this module) to delegate `updateGrant`.
 *
 * Two responsibilities the loop below alternates between, decided fresh
 * every iteration by `plan(snapshot)` against a `.lean()` read (never a
 * cached/hydrated value, and never schema-default-filled — DC-2):
 *
 *   (a) `plan` returns an `event` — the Page is `historyTracking.state ===
 *       'ready'` AND the plan could produce a truthful payload for it. The
 *       write assigns the next `historySequence`, stamps a `page_event`
 *       outbox entry, and drains any pre-existing outbox occupant first
 *       (bounded drain-assist budget) before spending a claim attempt.
 *   (b) `plan` returns `event: null` (DC-3: not `ready`; DC-4: `ready` but
 *       the plan can't write a truthful event) — only the domain fields in
 *       `set` change. `historySequence`/`pendingHistoryEntry` are never
 *       read, pinned, or written on this path; the outbox is never touched.
 *
 * NEVER throws — every non-`committed` outcome (including an unexpected
 * internal failure) collapses to a typed outcome so a caller can always
 * distinguish "retryable" (`contended`) from "terminal" (`rejected`/`noop`/
 * `not-found`) without its own try/catch (DC-1's Error semantics contract).
 */

/**
 * `.lean()` generic value. Every field is optional/nullable because a
 * legacy Page document can be missing `grant`/`creator`/`historyTracking`/
 * `historySequence` entirely (DC-2/DC-4) — a `plan` must never assume a
 * schema default filled a gap that `.lean()` shows as genuinely absent.
 */
export interface PageCommandSnapshot {
  _id: Types.ObjectId;
  grant?: number | null;
  creator?: Types.ObjectId | null;
  status?: string | null;
  historySequence?: number | null;
  historyTracking?: { state?: 'untracked' | 'migrating' | 'ready' | null } | null;
  pendingHistoryEntry?: PendingHistoryEntry | null;
}

/**
 * `plan`'s return value. Only `write` ever produces a CAS; `noop`/`reject`
 * short-circuit the command before any read/write of the history fields.
 * `event: null` on a `write` decision is the no-event branch (DC-3/DC-4) —
 * `expected`/`set` still apply, but the skeleton adds no history-field
 * clauses to either the filter or the update.
 */
export type PageCommandPlanResult =
  | { decision: 'noop'; reason: string }
  | { decision: 'reject'; reason: string }
  | {
      decision: 'write';
      /** CAS filter clauses to pin, in ADDITION to `_id` (added by the skeleton) and the history-field clauses (added by the skeleton per branch — never by `plan`). */
      expected: Record<string, unknown>;
      /** `$set` clauses for the domain fields being changed, in ADDITION to the history fields the skeleton adds on the event branch. */
      set: Record<string, unknown>;
      event: { kind: PageHistoryEventKind; payload: PageHistoryPayloadByKind[PageHistoryEventKind] } | null;
    };

/**
 * Called fresh with a NEW `.lean()` snapshot on every loop iteration
 * (including every retry after a lost CAS race — F-8) — never memoises a
 * prior read, never touches the DB or any process-shared mutable state
 * itself. A losing writer that retries therefore always plans against the
 * true, current "before" state, never a stale one.
 */
export type PageCommandPlan = (snapshot: PageCommandSnapshot) => PageCommandPlanResult;

export interface PageEventCommandInput {
  pageId: Types.ObjectId;
  /** Event envelope `actor`. `null` for a system-initiated change. */
  actor: Types.ObjectId | null;
  /** Already-converted value — pass the result of {@link toPageHistoryEventSource}, never a raw `editVia`/`authContext.kind` string. */
  source: PageHistoryEventSource;
  /**
   * Pins the event envelope's `operationId` instead of minting one per attempt.
   * Pass it when several pages' events belong to ONE logical operation (a
   * subtree command) or when `{page, operationId, kind}` has to serve as the
   * durable evidence that this operation already committed — a value chosen
   * per attempt can satisfy neither.
   */
  operationId?: string;
  plan: PageCommandPlan;
  /** Same defaults/semantics as `content-sequence.ts`'s allocator (DC-9: same retry budget). */
  options?: { maxClaimAttempts?: number; maxDrainAssists?: number };
}

/**
 * Never thrown by {@link runPageEventCommand} — every outcome is a value.
 * `rejected` (the plan declined based on the state it observed — retrying
 * changes nothing) is distinct from `contended` (a CAS/outbox race burned
 * the retry budget — a later retry can still succeed). Every non-`committed`
 * variant carries neither `page` nor `sequence` nor `eventId`: no state
 * change happened, so there is nothing to report beyond why.
 */
export type PageEventCommandOutcome =
  | { status: 'committed'; page: PageDocument; sequence: number | null; eventId: Types.ObjectId | null; materialized: boolean }
  | { status: 'noop'; reason: string }
  | { status: 'rejected'; reason: string }
  | { status: 'contended'; reason: 'claim-budget-exhausted' | 'drain-budget-exhausted' }
  | { status: 'not-found' };

const DEFAULT_MAX_CLAIM_ATTEMPTS = 3;
const DEFAULT_MAX_DRAIN_ASSISTS = 5;

const SNAPSHOT_PROJECTION = 'grant creator status historySequence historyTracking pendingHistoryEntry';

/**
 * `PAGE_HISTORY_EVENT_SOURCES` is the closed envelope vocabulary; any other
 * value (an unrecognized `editVia`, or none at all) collapses to `'system'`
 * rather than throwing — a command must never fail an otherwise-valid state
 * change over an unrecognized/missing edit-channel label.
 */
export function toPageHistoryEventSource(value: string | null | undefined): PageHistoryEventSource {
  if (value != null && (PAGE_HISTORY_EVENT_SOURCES as readonly string[]).includes(value)) {
    return value as PageHistoryEventSource;
  }
  return 'system';
}

export async function runPageEventCommand(crowi: Crowi, input: PageEventCommandInput): Promise<PageEventCommandOutcome> {
  try {
    const maxClaimAttempts = input.options?.maxClaimAttempts ?? DEFAULT_MAX_CLAIM_ATTEMPTS;
    const maxDrainAssists = input.options?.maxDrainAssists ?? DEFAULT_MAX_DRAIN_ASSISTS;
    const Page = crowi.model('Page');

    let claimAttemptsUsed = 0;
    let drainAssistsUsed = 0;

    for (;;) {
      // F-1 step 2 — the ONLY read of Page state this iteration performs.
      // Every filter clause and every payload value below traces back to
      // THIS snapshot; no other request's state, and no process-shared
      // mutable state, is ever consulted.
      const raw = await Page.findById(input.pageId).select(SNAPSHOT_PROJECTION).lean().exec();
      if (raw == null) {
        return { status: 'not-found' };
      }
      const snapshot = raw as PageCommandSnapshot;

      const result = input.plan(snapshot);
      if (result.decision === 'noop') {
        return { status: 'noop', reason: result.reason };
      }
      if (result.decision === 'reject') {
        return { status: 'rejected', reason: result.reason };
      }

      const isReady = snapshot.historyTracking?.state === 'ready';
      const writeEvent = isReady && result.event != null;

      if (writeEvent) {
        const pendingEntry = snapshot.pendingHistoryEntry;
        if (pendingEntry != null) {
          if (drainAssistsUsed >= maxDrainAssists) {
            return { status: 'contended', reason: 'drain-budget-exhausted' };
          }
          drainAssistsUsed += 1;
          try {
            await materializePendingEntry(crowi, input.pageId);
          } catch {
            // A stuck/corrupt occupant left by another writer is not this
            // call's entry to fix — `repair.ts` (operator-invoked) exists
            // for that. The bounded budget above caps how many times this
            // loop retries past it before reporting `contended` honestly.
          }
          continue;
        }

        const n = snapshot.historySequence;
        if (typeof n !== 'number' || !Number.isFinite(n)) {
          // `historySequence` is the allocator/optimistic-lock value on a
          // `ready` Page (DC-2) — a native-driver-corrupted non-numeric
          // value can never seed a CAS filter or an increment. Fail closed
          // (same posture as the `'migrating'` open question) rather than
          // write `NaN`/garbage into the field.
          return { status: 'contended', reason: 'claim-budget-exhausted' };
        }

        if (claimAttemptsUsed >= maxClaimAttempts) {
          return { status: 'contended', reason: 'claim-budget-exhausted' };
        }
        claimAttemptsUsed += 1;

        const entryId = new Types.ObjectId();
        // Generated BEFORE the write it identifies (RFC §5.3 — the
        // materialization idempotency key), same timing principle as
        // `content-sequence.ts`'s own `entryId`/`operationId`.
        const eventId = new Types.ObjectId();
        // A caller may pin one logical operation across retries/pages;
        // `eventId` stays attempt-local because a losing CAS persists nothing.
        const operationId = input.operationId ?? randomUUID();
        const occurredAt = new Date();
        const event = result.event as NonNullable<(typeof result)['event']>;

        const filter: Record<string, unknown> = {
          _id: input.pageId,
          ...result.expected,
          'historyTracking.state': 'ready',
          historySequence: n,
          pendingHistoryEntry: null,
        };
        const update = {
          $set: {
            ...result.set,
            historySequence: n + 1,
            pendingHistoryEntry: {
              entryId,
              type: 'page_event',
              event: {
                _id: eventId,
                page: input.pageId,
                sequence: n + 1,
                kind: event.kind,
                actor: input.actor,
                occurredAt,
                operationId,
                source: input.source,
                payload: event.payload,
              },
            },
          },
        };

        const after = await Page.findOneAndUpdate(filter, update, { returnDocument: 'after' }).exec();
        if (after == null) {
          // Lost the race — a concurrent writer advanced `historySequence`
          // or filled the outbox between our read and this write. Re-read
          // and retry from the top (F-8): the plan must see a FRESH
          // snapshot, never reuse the stale `expected`/`event` this losing
          // attempt computed.
          continue;
        }

        let materialized = false;
        try {
          await materializePendingEntry(crowi, input.pageId);
          materialized = true;
        } catch {
          // The state change is already durable — the CAS above committed
          // (DC-1). Materialize failure never fails the command; the
          // outbox entry is left for a future command's drain-assist or
          // the operator-invoked `repairPendingEntries` to finish.
        }

        return { status: 'committed', page: after, sequence: n + 1, eventId, materialized };
      }

      // No-event branch (F-3/F-4, DC-3/DC-4): only the domain fields
      // change. `historySequence`/`pendingHistoryEntry` are neither pinned
      // nor written, and the outbox is never consulted — the filter's ONLY
      // history-field clause is whichever tracking state was actually
      // observed (DC-2: "イベントを書かない branch の filter は…観測した tracking
      // 状態を pin するだけ"). A Page in the (unreachable-by-any-current-writer)
      // `migrating` state matches neither clause below and falls through to
      // `contended` after the claim budget is spent — fail closed, per the
      // open question on that state.
      const trackingFilter: Record<string, unknown> = isReady
        ? { 'historyTracking.state': 'ready' }
        : { $or: [{ 'historyTracking.state': 'untracked' }, { 'historyTracking.state': null }] };

      if (claimAttemptsUsed >= maxClaimAttempts) {
        return { status: 'contended', reason: 'claim-budget-exhausted' };
      }
      claimAttemptsUsed += 1;

      const noEventFilter: Record<string, unknown> = { _id: input.pageId, ...result.expected, ...trackingFilter };
      const after = await Page.findOneAndUpdate(noEventFilter, { $set: { ...result.set } }, { returnDocument: 'after' }).exec();
      if (after == null) {
        // Lost the race, or the tracking state moved between our read and
        // this write (e.g. a concurrent content save promoted the Page to
        // `ready`) — re-read and retry so `plan` is re-evaluated against
        // the CURRENT tracking state, not the stale one that lost.
        continue;
      }

      return { status: 'committed', page: after, sequence: null, eventId: null, materialized: false };
    }
  } catch {
    // Never throws (Error semantics contract) — an unexpected failure
    // (e.g. a transient DB error mid-loop) collapses to the same
    // `contended` outcome a spent retry budget produces, so every caller
    // has exactly one shape to handle for "didn't commit, may be retryable".
    return { status: 'contended', reason: 'claim-budget-exhausted' };
  }
}
