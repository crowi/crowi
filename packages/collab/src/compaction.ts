import * as Y from 'yjs';
import Debug from 'debug';
import type { Types } from 'mongoose';
import type { CollabModels } from './models';
import { payloadToUint8Array } from './yjs-payload';
import { persistYjsState } from './persist-yjs-state';
import { CONTENT_FIELD } from './yjs-doc';

const debug = Debug('crowi:collab:compact');

export interface CompactPageDeps {
  models: Pick<CollabModels, 'Page' | 'PageYjsUpdate' | 'Revision'>;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Revision = deps.models.Revision as any;

  /**
   * Read the latest `Revision.body` for `pageId` — the anti-shrink
   * baseline (editor-preview-reliability §1B). Returns `null` when the
   * page or its revision is genuinely missing (so the guard treats it as
   * "no baseline to protect"). THROWS on a DB read failure rather than
   * degrading to `null`: a degraded `null` would make `evaluateAntiShrink`
   * treat an empty live doc as safe and overwrite a non-empty persisted
   * `yjsState` with empty. Callers decide how to handle the throw —
   * store-only SKIPS the checkpoint (round 3), full-merge degrades to a
   * best-effort no-baseline (its candidate is the merged doc, not empty).
   */
  async function latestRevisionBody(pageId: string): Promise<string | null> {
    const page = await Page.findById(pageId).select('revision currentRevision').lean().exec();
    const revisionId = page?.currentRevision ?? page?.revision;
    if (!revisionId) return null;
    const revision = await Revision.findById(revisionId).select('body').lean().exec();
    return typeof revision?.body === 'string' ? revision.body : null;
  }

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
      // editor-preview-reliability §1B: route the store-only fast path
      // (fires on every Hocuspocus debounce) through the single
      // `persistYjsState` chokepoint. An empty live doc must not overwrite
      // the last good yjsState — the next onLoadDocument rebuilds from the
      // revision body instead.
      //
      // Hot-path optimization (round 2): the desync guard only ever rejects
      // an EMPTY decoded doc (Decision 2). A non-empty live doc always
      // passes, so we skip the baseline `Revision.body` read entirely in the
      // common typing case — the body read (just to detect "baseline
      // non-empty") only matters when the candidate is empty.
      const liveIsEmpty = fromDocument.getText(CONTENT_FIELD).length === 0;
      let baselineBody: string | null = null;
      if (liveIsEmpty) {
        // Round 3: the candidate is empty, so the desync guard's verdict hinges
        // ENTIRELY on whether the baseline is non-empty. A read failure here
        // must NOT degrade to `baselineBody=null` (which would let the empty
        // doc overwrite a non-empty persisted yjsState). SKIP the checkpoint
        // instead — `null` reads correctly on-store as "not persisted", so the
        // 10-min time-trigger re-attempts once the content is re-established.
        try {
          baselineBody = await latestRevisionBody(pageId);
        } catch (err) {
          console.warn(
            `[crowi:collab] compaction: skipping store-only checkpoint for page ${pageId} — the live doc is empty and the ` +
              `baseline body read failed, so an empty overwrite cannot be ruled out: ${(err as Error).message}`,
          );
          return null;
        }
      }
      const result = await persistYjsState(Page, { pageId, document: fromDocument, baselineBody, origin: 'store-only' });
      if (!result.ok) {
        // Return `null` (not an ok-shaped 0-byte result) so `onStoreDocument`
        // does NOT treat the reject as "persisted": a null lets the 10-min
        // time-trigger fire and re-attempt the write once the content is
        // legitimately re-established. There are no folded rows on this
        // fast path, so the no-data-loss policy needs nothing further.
        return null;
      }
      debug('store-only checkpoint for page %s: %d bytes, no pending updates', pageId, result.bytes);
      return { compactedCount: 0, newYjsStateBytes: result.bytes };
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

    // editor-preview-reliability §1B + C1 fix: route the full-merge write
    // through the same `persistYjsState` chokepoint as every other path.
    //
    // The C1 data-loss bug lived HERE: the pre-fix code skipped the
    // yjsState write on a reject BUT still pruned the folded rows
    // unconditionally. With the stale yjsState surviving and the deltas
    // deleted, the next load applied the stale state, saw a non-empty doc,
    // took the fast path, and never replayed the deletion — reverting it.
    //
    // No-data-loss policy (defined once in the chokepoint): on a reject we
    // write NOTHING and — critically — we DO NOT prune the folded rows. The
    // deltas stay in `PageYjsUpdate`, so the next onLoadDocument replays
    // them over the surviving base state and the content is preserved. We
    // only prune the folded ids when the write actually landed.
    //
    // Round 2 (Decision 2): the guard is now a desync check (empty over a
    // non-empty body), NOT a shrink ratio — a legitimate large deletion is
    // a non-empty doc, so it PERSISTS here (durably in yjsState, fixing the
    // C1 TTL hole) instead of being rejected into 1h-TTL rows.
    //
    // Full-merge folds real pending deltas into the doc, so the candidate is
    // virtually never empty; a baseline read failure here can degrade to a
    // best-effort no-baseline (the empty-over-nonempty desync only bites when
    // the candidate is itself empty, which the deltas rule out). The
    // store-only fast path handles the empty-candidate case strictly above.
    let baselineBody: string | null = null;
    try {
      baselineBody = await latestRevisionBody(pageId);
    } catch (err) {
      console.warn(
        `[crowi:collab] compaction: failed to read baseline body for page ${pageId} during full-merge; proceeding without anti-shrink baseline.`,
        (err as Error).message,
      );
    }
    const result = await persistYjsState(Page, { pageId, document: ydoc, baselineBody, origin: 'full-merge' });

    if (!result.ok) {
      // Reject: leave yjsState AND the folded rows untouched (C1 fix).
      // C4 — return `null` (not an ok-shaped 0-byte result) so
      // `onStoreDocument` does NOT read the reject as "persisted" and skip
      // the 10-min time-trigger; a null lets the trigger re-attempt once the
      // content is legitimately re-established. The store-only fast path
      // already returns null on a reject — this makes full-merge consistent.
      debug('compaction reject for page %s: kept %d folded rows for replay (no data loss)', pageId, pendingRows.length);
      return null;
    }

    const collectedIds = pendingRows.map((row) => row._id);
    const deleteResult = await PageYjsUpdate.deleteMany({ _id: { $in: collectedIds } }).exec();
    const deletedCount = (deleteResult?.deletedCount ?? collectedIds.length) as number;

    debug('compacted page %s: %d updates folded, %d deleted, new yjsState=%d bytes', pageId, collectedIds.length, deletedCount, result.bytes);

    return { compactedCount: collectedIds.length, newYjsStateBytes: result.bytes };
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
