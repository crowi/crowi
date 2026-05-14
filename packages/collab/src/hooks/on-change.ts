import type { onChangePayload } from '@hocuspocus/server';
import Debug from 'debug';
import type { CollabModels } from '../models';
import type { CollabContext } from '../types';
import type { Compactor } from '../compaction';

const debug = Debug('crowi:collab:change');

/**
 * Threshold for the count-based compaction trigger. Spec: "100 updates
 * or 10 min, whichever first". The exact threshold is approximate
 * (±10 because we throttle the DB countDocuments check) — see
 * `COUNT_QUERY_INTERVAL` below.
 */
const COMPACT_AT = 100;

/**
 * How often (per pageId) we re-query the DB for the actual pending
 * count. Hot path optimization: `onChange` fires per Yjs update, so
 * doing `countDocuments` every time is wasteful. We use an in-memory
 * counter to throttle the check to every Nth call. Exact-100 threshold
 * is not required — spec calls for "approximately 100".
 */
const COUNT_QUERY_INTERVAL = 10;

export interface OnChangeDeps {
  models: Pick<CollabModels, 'PageYjsUpdate'>;
  compactor: Pick<Compactor, 'compactPage'>;
}

/**
 * Build the Hocuspocus `onChange` hook.
 *
 * Hocuspocus v4 fires `onChange` on every Yjs update merged into the
 * Document (`Hocuspocus.handleDocumentUpdate`, no debounce). We use it
 * as the firehose append path:
 *
 *   1. Skip when the connection is readonly. Defence-in-depth — readonly
 *      clients are normally rejected at the protocol layer by
 *      Hocuspocus, but a future version bump could change that, and we
 *      never want a readonly observer to inflate `PageYjsUpdate`.
 *
 *   2. Insert one `PageYjsUpdate` row per delta. Buffer-wrap the
 *      `Uint8Array` because Mongoose stores `Buffer`, not typed arrays
 *      (BSON's binary subtype).
 *
 *   3. Bump an in-memory counter for the page. Every
 *      `COUNT_QUERY_INTERVAL` calls, ask the DB for the real pending
 *      count and fire the compactor when ≥ `COMPACT_AT`. We
 *      fire-and-forget because `compactPage` has its own in-process
 *      mutex (the compactor's `inflight` Set) — chaining `await` here
 *      would serialize edits behind compaction.
 *
 * The 10-minute time trigger lives in `onStoreDocument` so it
 * piggybacks on Hocuspocus's debounce. Splitting the triggers across
 * hooks keeps `onChange` cheap.
 */
export function createOnChange(deps: OnChangeDeps) {
  // Per-pageId append counter. Process-local; resets on collab restart.
  // The counter is *only* a DB-query throttle — actual threshold
  // decisions are made against the real `countDocuments`, so a reset
  // never causes spurious or missed compactions, just a slightly
  // earlier check after the next 10 appends.
  const counters = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const PageYjsUpdate = deps.models.PageYjsUpdate as any;

  return async (data: onChangePayload<CollabContext>): Promise<void> => {
    const { documentName, update, context } = data;

    if (context?.readonly) {
      debug('onChange ignored for page %s: readonly context', documentName);
      return;
    }

    const payload = Buffer.from(update);
    await PageYjsUpdate.create({
      pageId: documentName,
      payload,
      createdAt: new Date(),
    });

    const next = (counters.get(documentName) ?? 0) + 1;
    counters.set(documentName, next);

    if (next % COUNT_QUERY_INTERVAL !== 0) return;

    const actualCount = await PageYjsUpdate.countDocuments({ pageId: documentName }).exec();
    debug('onChange counter probe for page %s: in-memory=%d, db=%d', documentName, next, actualCount);
    if (actualCount < COMPACT_AT) return;

    // Reset the local counter so we don't fire again on every probe
    // until the compaction actually finishes. The compactor's own
    // inflight guard prevents pile-up regardless.
    counters.set(documentName, 0);

    // Fire-and-forget: never block onChange. The compactor swallows
    // errors internally (its callers log) — we add a defensive catch
    // here to keep an unhandled promise rejection from killing the
    // process if something deep inside Mongoose throws.
    // TODO(observability): wire to a metrics / debug counter so a
    // persistently-failing compactor surfaces beyond the warn log.
    void deps.compactor.compactPage(documentName).catch((err: unknown) => {
      console.warn(`[crowi:collab] compactPage from onChange failed for ${String(documentName)}:`, err);
    });
  };
}
