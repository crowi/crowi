import * as Y from 'yjs';
import Debug from 'debug';
import type { Types } from 'mongoose';
import type { CollabModels } from './models';
import { payloadToUint8Array } from './yjs-payload';

const debug = Debug('crowi:collab:compact');

export interface CompactPageDeps {
  models: Pick<CollabModels, 'Page' | 'PageYjsUpdate'>;
}

export interface CompactPageResult {
  /** Number of `PageYjsUpdate` rows folded into `Page.yjsState` (and deleted). */
  compactedCount: number;
  /** Size in bytes of the newly-encoded `Page.yjsState` after merge. */
  newYjsStateBytes: number;
}

export interface Compactor {
  /**
   * Take the current `Page.yjsState` plus every pending `PageYjsUpdate`
   * for `pageId`, merge them into a single Y.Doc, re-encode, and write
   * back. The append rows that participated in the merge are deleted by
   * `_id`, so any rows appended **after** we snapshot the id list are
   * preserved for the next compaction — this is what gives us
   * concurrent-edit safety without a MongoDB transaction.
   *
   * `null` means another compaction for the same `pageId` was already
   * in flight, so this invocation skipped. The in-memory `inflight`
   * set is process-local; multi-instance dedup is out of scope for
   * Phase 4 (see Phase 9 advisory).
   */
  compactPage(pageId: string): Promise<CompactPageResult | null>;

  /**
   * Hook called from `onStoreDocument`. Always rewrites `Page.yjsState`
   * (Hocuspocus's debounce already guarantees this fires only after a
   * batch of edits) and also deletes any `PageYjsUpdate` rows that
   * existed at snapshot time. Skips the deleteMany roundtrip when no
   * pending rows existed.
   */
  storeCheckpoint(pageId: string, document: Y.Doc): Promise<CompactPageResult | null>;
}

/**
 * Build a compactor wired to the collab Mongoose models. The factory
 * captures one `Set<pageId>` so all hooks created by the same server
 * share the inflight mutex.
 *
 * Why a single in-memory Set instead of a Mongo-side lock? Phase 4 is
 * single-instance, and the only race we need to guard is the
 * "snapshot-then-delete" gap inside one process — two simultaneous
 * `compactPage` invocations would both read the same `_id` array and
 * the second delete would no-op (idempotent) but waste a roundtrip.
 * The Set keeps it to one. Multi-instance dedup will need Redis
 * (Phase 9 advisory).
 *
 * Why no MongoDB transaction? Two reasons:
 *   1. `mongodb-memory-server` runs standalone by default — no
 *      replica set, so `session.withTransaction` isn't available
 *      under jest without a heavier setup. Avoiding it lets us keep
 *      the existing `setup.ts`.
 *   2. The 2-step (Page.updateOne → PageYjsUpdate.deleteMany) is
 *      idempotent even mid-crash. If we die between steps, the next
 *      `onLoadDocument` applies `Page.yjsState` then replays the
 *      residual `PageYjsUpdate` rows; Yjs CRDT merges are idempotent
 *      so re-applying an update that was already folded in is a
 *      no-op. Worst case is bounded extra rows that the 1-hour TTL
 *      eventually sweeps.
 */
export function createCompactor(deps: CompactPageDeps): Compactor {
  const inflight = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Page = deps.models.Page as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const PageYjsUpdate = deps.models.PageYjsUpdate as any;

  /**
   * Read the current checkpoint + every pending update for `pageId`,
   * build a fresh `Y.Doc` from them, re-encode the full state, and
   * write the new state back. Returns the merged update so callers
   * (notably `storeCheckpoint`, where the doc is already in memory)
   * can avoid an extra encode.
   *
   * Returns `null` when nothing pending exists and no doc was supplied
   * — used to short-circuit a noop store cycle.
   */
  async function runCompaction(pageId: string, fromDocument?: Y.Doc): Promise<CompactPageResult | null> {
    // Snapshot the pending rows first so the `_id` list is stable for
    // the deleteMany at the end. Anything appended after this find
    // call is *not* in `collectedIds`, so it survives the delete and
    // gets picked up by the next compaction.
    const pendingRows: Array<{ _id: Types.ObjectId; payload: unknown }> = await PageYjsUpdate.find({ pageId })
      .sort({ createdAt: 1 })
      .select('_id payload')
      .lean()
      .exec();

    // Fast-path: caller has the live doc + nothing pending → just
    // overwrite `Page.yjsState` from the in-memory doc. This is the
    // common Hocuspocus debounce path: edits already merged in
    // memory, no append rows to fold.
    if (pendingRows.length === 0 && fromDocument) {
      const update = Y.encodeStateAsUpdate(fromDocument);
      const stateBuf = Buffer.from(update);
      await Page.updateOne({ _id: pageId }, { $set: { yjsState: stateBuf, yjsCheckpointAt: new Date() } }).exec();
      debug('store-only checkpoint for page %s: %d bytes, no pending updates', pageId, stateBuf.length);
      return { compactedCount: 0, newYjsStateBytes: stateBuf.length };
    }

    // Nothing pending and no live doc → caller (count-trigger) raced
    // with a TTL sweep or another compaction. Bail out without
    // touching `Page.yjsState`.
    if (pendingRows.length === 0) {
      debug('compaction skipped for page %s: no pending updates', pageId);
      return null;
    }

    // Build a working Y.Doc. Prefer the live `fromDocument` so we
    // capture in-flight edits not yet folded into `Page.yjsState`;
    // otherwise apply the persisted state as a base.
    const ydoc = fromDocument ?? new Y.Doc();
    if (!fromDocument) {
      const page = await Page.findById(pageId).select('yjsState').lean().exec();
      const yjsState = page?.yjsState as unknown;
      const stateBytes = yjsState ? payloadToUint8Array(yjsState) : null;
      if (stateBytes && stateBytes.length > 0) {
        try {
          Y.applyUpdate(ydoc, stateBytes);
        } catch (err) {
          // Corrupt checkpoint — the load-document path already has
          // a body-fallback for this, but compaction is best-effort
          // so we proceed with the pending updates only and log.
          console.warn(
            `[crowi:collab] compactPage: yjsState for page ${pageId} failed Y.applyUpdate; merging pending updates over empty doc.`,
            (err as Error).message,
          );
        }
      }
    }

    for (const row of pendingRows) {
      try {
        Y.applyUpdate(ydoc, payloadToUint8Array(row.payload));
      } catch (err) {
        console.warn(`[crowi:collab] compactPage: skipping corrupt PageYjsUpdate ${row._id.toString()} for page ${pageId}:`, (err as Error).message);
      }
    }

    const merged = Y.encodeStateAsUpdate(ydoc);
    const stateBuf = Buffer.from(merged);
    const now = new Date();

    await Page.updateOne({ _id: pageId }, { $set: { yjsState: stateBuf, yjsCheckpointAt: now } }).exec();

    const collectedIds = pendingRows.map((row) => row._id);
    const deleteResult = await PageYjsUpdate.deleteMany({ _id: { $in: collectedIds } }).exec();
    const deletedCount = (deleteResult?.deletedCount ?? collectedIds.length) as number;

    debug('compacted page %s: %d updates folded, %d deleted, new yjsState=%d bytes', pageId, collectedIds.length, deletedCount, stateBuf.length);

    return { compactedCount: collectedIds.length, newYjsStateBytes: stateBuf.length };
  }

  async function compactPage(pageId: string): Promise<CompactPageResult | null> {
    if (inflight.has(pageId)) {
      debug('compactPage skipped for page %s: another compaction is in flight', pageId);
      return null;
    }
    inflight.add(pageId);
    try {
      return await runCompaction(pageId);
    } finally {
      inflight.delete(pageId);
    }
  }

  async function storeCheckpoint(pageId: string, document: Y.Doc): Promise<CompactPageResult | null> {
    if (inflight.has(pageId)) {
      debug('storeCheckpoint skipped for page %s: another compaction is in flight', pageId);
      return null;
    }
    inflight.add(pageId);
    try {
      return await runCompaction(pageId, document);
    } finally {
      inflight.delete(pageId);
    }
  }

  return { compactPage, storeCheckpoint };
}
