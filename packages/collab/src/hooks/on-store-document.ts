import type { onStoreDocumentPayload } from '@hocuspocus/server';
import Debug from 'debug';
import type { CollabModels } from '../models';
import type { CollabContext } from '../types';
import type { Compactor } from '../compaction';

const debug = Debug('crowi:collab:store');

/**
 * 10-minute trigger: spec says "100 updates or 10 min, whichever
 * first". The count side is handled by `onChange`; the time side
 * piggybacks on Hocuspocus's debounce-driven `onStoreDocument` so we
 * don't need a separate process-wide timer.
 */
const TIME_TRIGGER_MS = 10 * 60 * 1000;

export interface OnStoreDocumentDeps {
  models: Pick<CollabModels, 'Page'>;
  compactor: Pick<Compactor, 'storeCheckpoint' | 'compactPage'>;
}

/**
 * Build the Hocuspocus `onStoreDocument` hook.
 *
 * Phase 4 behaviour:
 *   - readonly defence-in-depth (unchanged from Phase 3).
 *   - Delegate the actual checkpoint to `compactor.storeCheckpoint`,
 *     which rewrites `Page.yjsState` from the live `Y.Doc` and
 *     deletes any pending `PageYjsUpdate` rows that existed at
 *     snapshot time. Same idempotent 2-step design as
 *     `compactor.compactPage`; see `compaction.ts` for the rationale.
 *   - If the last checkpoint is older than `TIME_TRIGGER_MS`, follow
 *     up with `compactor.compactPage` to honour the "10-min trigger"
 *     in the spec. We read `yjsCheckpointAt` *before* the store
 *     checkpoint so we get the pre-store value — `storeCheckpoint`
 *     bumps it to `now` so the post-store value would always be
 *     fresh and the trigger would never fire.
 */
export function createOnStoreDocument(deps: OnStoreDocumentDeps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Page = deps.models.Page as any;

  return async (data: onStoreDocumentPayload<CollabContext>): Promise<void> => {
    const { documentName, document, lastContext } = data;

    if (lastContext?.readonly) {
      console.warn(`[crowi:collab] onStoreDocument fired with readonly context for page ${String(documentName)} — skipping checkpoint.`);
      return;
    }

    // Snapshot the previous checkpoint time before mutating the page.
    // A page that has never been checkpointed (yjsCheckpointAt =
    // null) is treated as "never compacted" → the time trigger fires
    // on the next store-after-edits so we get an early baseline.
    const prevCheckpoint = await Page.findById(documentName).select('yjsCheckpointAt').lean().exec();
    const prevCheckpointAt = prevCheckpoint?.yjsCheckpointAt as Date | null | undefined;

    const result = await deps.compactor.storeCheckpoint(documentName, document);
    debug('onStoreDocument for page %s: result=%o', documentName, result);

    // Time-trigger fire-and-forget is only meaningful when
    // `storeCheckpoint` was skipped (= another compaction was
    // in-flight via `inflight` mutex). When it ran, pending rows are
    // already flushed and `yjsCheckpointAt` was bumped — `compactPage`
    // would just walk an empty `PageYjsUpdate.find()` and return null,
    // wasting one round trip.
    if (result !== null) return;

    const sinceLastCheckpoint = prevCheckpointAt ? Date.now() - prevCheckpointAt.getTime() : Infinity;
    if (sinceLastCheckpoint <= TIME_TRIGGER_MS) return;

    // 10-min trigger. `compactPage` is idempotent and skips when no
    // pending rows exist, so the worst case is one extra DB read for
    // an idle page.
    debug('onStoreDocument firing time-trigger compaction for page %s (last checkpoint %dms ago)', documentName, sinceLastCheckpoint);
    // TODO(observability): wire to a metrics / debug counter so a
    // persistently-failing compactor surfaces beyond the warn log.
    void deps.compactor.compactPage(documentName).catch((err: unknown) => {
      console.warn(`[crowi:collab] time-trigger compactPage failed for ${String(documentName)}:`, err);
    });
  };
}
