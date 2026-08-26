import type { PageDeletionRecord } from '@crowi/api-contract';
import Debug from 'debug';
import { Types } from 'mongoose';

import type Crowi from 'src/crowi';
import type { PageDeletionRecordDocument } from 'src/models/page-deletion-record';
import { purgePageHistoryEvents } from './purge';

const debug = Debug('crowi:service:page-history:deletion');

export type PageDeletionMode = 'user_hard_delete' | 'creation_cancel' | 'redirect_stub_cleanup' | 'internal_cleanup';

export interface PageDeletionInput {
  pageId: Types.ObjectId;
  path: string;
  actor: Types.ObjectId | null;
  mode: PageDeletionMode;
}

/**
 * Once `Page.deleteOne` commits, cleanup failures cannot roll the Page back.
 * The message is intentionally limited to the page id and closed step names:
 * the Hono delete handler returns it to the client, while raw driver details
 * remain reachable only through `cause` for local diagnostics.
 */
export class PageCleanupIncompleteError extends Error {
  readonly pageId: string;
  readonly steps: string[];

  constructor(pageId: Types.ObjectId, steps: string[], options?: { cause?: unknown }) {
    super(`page cleanup incomplete for page ${pageId}: ${steps.join(', ')}`);
    this.name = 'PageCleanupIncompleteError';
    this.pageId = String(pageId);
    this.steps = steps;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export async function deletePageWithMode(crowi: Crowi, input: PageDeletionInput, onPageDeleted?: () => void): Promise<void> {
  const Page = crowi.model('Page');
  const PageDeletionRecord = crowi.model('PageDeletionRecord');
  const PageYjsUpdate = crowi.model('PageYjsUpdate');
  const Revision = crowi.model('Revision');

  if (input.mode === 'user_hard_delete') {
    // Losing the Page without its evidence is irreversible. The opposite
    // crash direction intentionally leaves a detectable record beside a Page
    // that still exists.
    await PageDeletionRecord.create({
      pageId: input.pageId,
      path: input.path,
      actor: input.actor,
      deletedAt: new Date(),
      mode: input.mode,
    });
  }

  try {
    await Page.deleteOne({ _id: input.pageId });
  } catch (err) {
    debug('Page.deleteOne failed for page %s', String(input.pageId));
    throw err;
  }
  onPageDeleted?.();
  // The Page row is already gone, so append-log cleanup is storage/privacy
  // hygiene rather than a condition that can make the deletion un-happen.
  try {
    await PageYjsUpdate.deleteMany({ pageId: input.pageId }).exec();
  } catch (err) {
    debug('PageYjsUpdate.deleteMany failed for page %s: %s', String(input.pageId), (err as Error)?.message ?? err);
  }

  // A failed cleanup never skips its sibling. The Page is already gone, so
  // callers need one terminal error containing every incomplete step.
  const steps: string[] = [];
  const causes: unknown[] = [];
  try {
    await Revision.removeRevisionsByPageId(input.pageId);
  } catch (cause) {
    steps.push('revisions');
    causes.push(cause);
  }
  try {
    await purgePageHistoryEvents(crowi, input.pageId);
  } catch (cause) {
    steps.push('history-events');
    causes.push(cause);
  }

  if (steps.length > 0) {
    throw new PageCleanupIncompleteError(input.pageId, steps, { cause: causes.length === 1 ? causes[0] : causes });
  }
}

const toView = (record: PageDeletionRecordDocument): PageDeletionRecord => ({
  _id: record._id.toString(),
  pageId: record.pageId.toString(),
  path: record.path,
  actor: record.actor?.toString() ?? null,
  deletedAt: record.deletedAt.toISOString(),
  mode: record.mode,
});

export async function listPageDeletionRecords(crowi: Crowi, input: { pageId?: string; limit: number }): Promise<PageDeletionRecord[]> {
  const PageDeletionRecord = crowi.model('PageDeletionRecord');
  const filter = input.pageId === undefined ? {} : { pageId: new Types.ObjectId(input.pageId) };
  const records = await PageDeletionRecord.find(filter).sort({ deletedAt: -1 }).limit(input.limit).exec();
  return records.map(toView);
}

export async function listPageDeletionRecordsByPath(crowi: Crowi, input: { path: string; limit: number }): Promise<PageDeletionRecord[]> {
  const PageDeletionRecord = crowi.model('PageDeletionRecord');
  const records = await PageDeletionRecord.find({ path: input.path }).sort({ deletedAt: -1 }).limit(input.limit).exec();
  return records.map(toView);
}

/**
 * Erase records on an operator's explicit request (DC-6).
 *
 * Logged through `console.info` rather than this module's `debug`: DC-6 wants
 * the erasure itself to stay auditable, and `debug` output is suppressed unless
 * the operator happened to set `DEBUG`. Only the identifiers are recorded —
 * logging what was erased would defeat the erasure.
 */
export async function erasePageDeletionRecords(crowi: Crowi, input: { actorId: string; selector: { recordId: string } | { path: string } }): Promise<number> {
  const PageDeletionRecord = crowi.model('PageDeletionRecord');

  if ('recordId' in input.selector) {
    const result = await PageDeletionRecord.deleteOne({ _id: new Types.ObjectId(input.selector.recordId) }).exec();
    console.info(`[page-deletion-record:erase] admin=${input.actorId} recordId=${input.selector.recordId} deletedCount=${result.deletedCount}`);
    return result.deletedCount;
  }

  const result = await PageDeletionRecord.deleteMany({ path: input.selector.path }).exec();
  console.info(`[page-deletion-record:erase] admin=${input.actorId} path=${input.selector.path} deletedCount=${result.deletedCount}`);
  return result.deletedCount;
}
