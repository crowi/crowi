import { Types } from 'mongoose';

import Crowi from 'src/crowi';
import type { PageHistoryEventSource } from 'src/models/page-history-event';
import type { PageHistoryOperationDocument, PageHistoryOperationResult } from 'src/models/page-history-operation';

import { redactErrorReason } from './repair';
import { type ResumeExpectation, type TransitionPageSnapshot, classifyResume } from './transition';

/**
 * RFC-0021 Phase 2c-2a — the idempotency record behind a path-moving command,
 * and the operator's sweep over the ones that never finished.
 *
 * The record is what makes a retry safe: `{actor, command, idempotencyKey}` is
 * unique, so two deliveries of the same request converge on one row, and the
 * row carries the command's input so a resumed execution never has to re-derive
 * intent from a Page that is by then already mid-move.
 *
 * This module owns the record's lifecycle and nothing else. Deciding how far a
 * transition got is `transition.ts`'s `classifyResume`, shared verbatim so the
 * sweep and the runner cannot drift apart.
 */

const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** How the sweep dealt with one unfinished operation. */
export type StrandedTransitionAction = 'resumed' | 'completed' | 'blocked';

export interface StrandedTransitionReport {
  operationId: string;
  pageId: string | null;
  path: string | null;
  action: StrandedTransitionAction;
  /** Why, in the sweep's own closed vocabulary — never a driver message. */
  reason: string;
}

export interface StrandedTransitionScanResult {
  scannedOperations: number;
  reports: StrandedTransitionReport[];
  failed: { operationId: string; reason: string }[];
  lastOperationId: string | null;
}

export type OperationResolution =
  /** No record for this key — the caller may validate and then create one. */
  | { kind: 'miss' }
  /** A record exists and the request matches it; it is still running. */
  | { kind: 'in-flight'; operation: PageHistoryOperationDocument }
  /** A record exists, the request matches it, and it already finished. */
  | { kind: 'settled'; operation: PageHistoryOperationDocument }
  /** A record exists under this key but for a different request. */
  | { kind: 'fingerprint-mismatch'; operation: PageHistoryOperationDocument };

export interface OperationKey {
  actor: Types.ObjectId | null;
  command: string;
  idempotencyKey: string;
}

function resolveExisting(operation: PageHistoryOperationDocument, requestFingerprint: string): OperationResolution {
  // The fingerprint is the whole comparison (DC-2): the request body is never
  // re-compared field by field, so a key can never be quietly reused for a
  // different request just because the differing part was not modelled.
  if (operation.requestFingerprint !== requestFingerprint) {
    return { kind: 'fingerprint-mismatch', operation };
  }
  return operation.result == null ? { kind: 'in-flight', operation } : { kind: 'settled', operation };
}

/**
 * Look up the record for this key. Deliberately creates nothing: the caller has
 * request-specific validation to run first, and a record written before that
 * validation would burn the key on a request that was never accepted.
 */
export async function resolvePageHistoryOperation(crowi: Crowi, key: OperationKey, requestFingerprint: string): Promise<OperationResolution> {
  const PageHistoryOperation = crowi.model('PageHistoryOperation');
  const existing = (await PageHistoryOperation.findOne({
    actor: key.actor,
    command: key.command,
    idempotencyKey: key.idempotencyKey,
  }).exec()) as PageHistoryOperationDocument | null;

  return existing == null ? { kind: 'miss' } : resolveExisting(existing, requestFingerprint);
}

export interface CreateOperationInput extends OperationKey {
  operationId: string;
  requestFingerprint: string;
  page: Types.ObjectId;
  fromPath: string;
  toPath: string;
  fromStatus: string | null;
  fromStatusPresent: boolean;
  toStatus: string | null;
  createRedirect: boolean;
  source: PageHistoryEventSource;
}

export type CreateOperationResult = { kind: 'created'; operation: PageHistoryOperationDocument } | { kind: 'lost'; resolution: OperationResolution };

/**
 * Claim the key by inserting the record, writing the command's input in full.
 *
 * The unique index is the arbiter, not a preceding read: two concurrent
 * deliveries both insert, one gets `E11000`, and the loser re-reads the winner
 * rather than assuming anything about it. A read-then-insert would leave a
 * window where both believe they are first.
 */
export async function createPageHistoryOperation(crowi: Crowi, input: CreateOperationInput): Promise<CreateOperationResult> {
  const PageHistoryOperation = crowi.model('PageHistoryOperation');
  try {
    const created = (await PageHistoryOperation.create({
      actor: input.actor,
      command: input.command,
      idempotencyKey: input.idempotencyKey,
      operationId: input.operationId,
      requestFingerprint: input.requestFingerprint,
      page: input.page,
      fromPath: input.fromPath,
      toPath: input.toPath,
      fromStatus: input.fromStatus,
      fromStatusPresent: input.fromStatusPresent,
      toStatus: input.toStatus,
      createRedirect: input.createRedirect,
      source: input.source,
    })) as PageHistoryOperationDocument;
    return { kind: 'created', operation: created };
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    return { kind: 'lost', resolution: await resolvePageHistoryOperation(crowi, input, input.requestFingerprint) };
  }
}

/**
 * Write the terminal result and the retention deadline in one update.
 *
 * `expiresAt` is set here rather than at insert time because the TTL measures
 * how long a *finished* operation stays answerable to a replay; an in-flight
 * record must not expire out from under the execution that owns it.
 */
export async function completeOperation(
  crowi: Crowi,
  operationId: string,
  result: Omit<PageHistoryOperationResult, 'completedAt'> & { completedAt?: Date },
): Promise<void> {
  const PageHistoryOperation = crowi.model('PageHistoryOperation');
  const completedAt = result.completedAt ?? new Date();
  await PageHistoryOperation.updateOne(
    { operationId },
    {
      $set: {
        result: { ...result, completedAt },
        expiresAt: new Date(completedAt.getTime() + TERMINAL_RETENTION_MS),
        updatedAt: completedAt,
      },
    },
  ).exec();
}

const expectationOf = (operation: PageHistoryOperationDocument): ResumeExpectation => ({
  operationId: operation.operationId,
  fromPath: operation.fromPath ?? '',
  toPath: operation.toPath ?? '',
  fromStatus: operation.fromStatus ?? null,
  fromStatusPresent: operation.fromStatusPresent === true,
  toStatus: operation.toStatus ?? null,
});

/**
 * Finishes an operation whose transition is still held by it.
 *
 * Injected rather than imported: only the command knows its own step 2 and the
 * payload of the event step 3 appends, and the command modules already import
 * this one — reaching back the other way would be a cycle. Same shape as the
 * collab save flow's injected draft publisher.
 */
export type StrandedTransitionResumer = (operation: PageHistoryOperationDocument) => Promise<StrandedTransitionAction>;

export interface StrandedTransitionScanOptions {
  batchSize?: number;
  /** Resume a previous sweep — only operations with `_id > resumeAfterOperationId` are visited. */
  resumeAfterOperationId?: string;
  /** Without one, an operation still holding its transition is reported rather than finished — the sweep will not pretend to have landed it. */
  resumeCommand?: StrandedTransitionResumer;
}

/**
 * Walk the operations that never reached a terminal result and settle what can
 * be settled.
 *
 * This is not required to be total. An operation whose Page is in a state the
 * table does not recognise is reported with its identifiers and left exactly as
 * found — an operator can then look at it, which is the actual requirement.
 * Guessing would be worse than reporting: the states it cannot classify are
 * precisely the ones where a wrong guess rewrites a Page nobody asked it to.
 */
export async function resumeStrandedTransitions(crowi: Crowi, options: StrandedTransitionScanOptions = {}): Promise<StrandedTransitionScanResult> {
  const PageHistoryOperation = crowi.model('PageHistoryOperation');
  const Page = crowi.model('Page');
  const batchSize = options.batchSize && options.batchSize > 0 ? options.batchSize : 100;

  const result: StrandedTransitionScanResult = { scannedOperations: 0, reports: [], failed: [], lastOperationId: null };

  let cursor: Types.ObjectId | null = null;
  if (options.resumeAfterOperationId != null) {
    const anchor = (await PageHistoryOperation.findOne({ operationId: options.resumeAfterOperationId }).select('_id').lean().exec()) as {
      _id: Types.ObjectId;
    } | null;
    // An unknown cursor means the caller's bookkeeping and the collection
    // disagree; starting over is safe (every step below is idempotent) and is
    // preferable to silently skipping the whole collection.
    cursor = anchor?._id ?? null;
  }

  for (;;) {
    const match: Record<string, unknown> = { result: null };
    if (cursor != null) match._id = { $gt: cursor };

    const batch = (await PageHistoryOperation.find(match).sort({ _id: 1 }).limit(batchSize).exec()) as PageHistoryOperationDocument[];
    if (batch.length === 0) break;

    for (const operation of batch) {
      cursor = operation._id;
      result.scannedOperations += 1;
      result.lastOperationId = operation.operationId;

      try {
        const page =
          operation.page == null
            ? null
            : ((await Page.findById(operation.page).select('path status historyTransition').lean().exec()) as TransitionPageSnapshot | null);

        const decision = classifyResume(page, expectationOf(operation));
        const pageId = operation.page == null ? null : String(operation.page);
        const path = page?.path ?? null;

        switch (decision.decision) {
          case 'resume-own': {
            // The move is still ours to finish, but only the command knows its
            // own step 2 and event payload. With no resumer wired in, say so
            // instead of reporting a landing that never happened.
            if (options.resumeCommand == null) {
              result.reports.push({ operationId: operation.operationId, pageId, path, action: 'blocked', reason: 'no-resumer-registered' });
              break;
            }
            const action = await options.resumeCommand(operation);
            result.reports.push({ operationId: operation.operationId, pageId, path, action, reason: 'transition-held-by-operation' });
            break;
          }
          case 'already-settled':
            await completeOperation(crowi, operation.operationId, { status: 'succeeded' });
            result.reports.push({ operationId: operation.operationId, pageId, path, action: 'completed', reason: 'transition-already-settled' });
            break;
          case 'not-entered':
            await completeOperation(crowi, operation.operationId, {
              status: 'failed',
              code: 'PAGE_TRANSITION_INCOMPLETE',
              message: 'The operation never entered its transition.',
            });
            result.reports.push({ operationId: operation.operationId, pageId, path, action: 'completed', reason: 'abandoned-before-entry' });
            break;
          case 'page-missing':
            await completeOperation(crowi, operation.operationId, { status: 'succeeded' });
            result.reports.push({ operationId: operation.operationId, pageId, path: null, action: 'completed', reason: 'page-deleted' });
            break;
          case 'owned-elsewhere':
            result.reports.push({ operationId: operation.operationId, pageId, path, action: 'blocked', reason: 'transition-owned-by-another-operation' });
            break;
          case 'indeterminate':
            result.reports.push({ operationId: operation.operationId, pageId, path, action: 'blocked', reason: 'unrecognised-page-state' });
            break;
        }
      } catch (err) {
        // One unreadable record must not end the sweep — the operator wants the
        // rest of the report. The reason is redacted the same way the outbox
        // repair redacts its own, so a driver message never reaches an operator
        // channel.
        result.failed.push({ operationId: operation.operationId, reason: redactErrorReason(err) });
      }
    }

    if (batch.length < batchSize) break;
  }

  return result;
}
