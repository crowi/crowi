import type { onLoadDocumentPayload } from '@hocuspocus/server';
import * as Y from 'yjs';
import Debug from 'debug';
import type { CollabModels } from '../models';
import type { CollabContext } from '../types';
import { CONTENT_FIELD } from '../yjs-doc';
import { payloadToUint8Array } from '../yjs-payload';

const debug = Debug('crowi:collab:load');

export interface OnLoadDocumentDeps {
  models: Pick<CollabModels, 'Page' | 'Revision' | 'PageYjsUpdate'>;
}

/**
 * Build the Hocuspocus `onLoadDocument` hook.
 *
 * Restore order (RFC-0003 §Phase 3 + §Phase 4):
 *
 *   1. If `Page.yjsState` is a non-empty Buffer, `Y.applyUpdate` it into
 *      `document`. This is the canonical fast path — checkpoints are
 *      written by `onStoreDocument` on every debounce window.
 *
 *   2. On `applyUpdate` throw (yjsState corruption) **or** when
 *      `yjsState` is null/empty, fall through to a fresh build:
 *      load the latest revision (`page.currentRevision ?? page.revision`,
 *      v1.x rows only have `revision`) and seed the Y.Text with its
 *      `body`. Empty body → empty Y.Doc (Y.Text.insert on '' is a
 *      no-op).
 *
 *   3. **Phase 4 addition**: regardless of which path served the base
 *      state, replay every residual `PageYjsUpdate` (ordered by
 *      `createdAt`). This covers two crash recoveries:
 *      (a) Hocuspocus appended deltas via `onChange` but died before
 *          compaction could fold them into `yjsState`.
 *      (b) Compaction crashed *between* the `Page.updateOne` and the
 *          `PageYjsUpdate.deleteMany` — re-applying those deltas is
 *          idempotent in Yjs CRDT semantics (already-applied updates
 *          merge to a no-op), so this path is safe.
 *      Per-row try/catch: a single corrupt payload doesn't lock out
 *      the rest. We log + skip and continue.
 *
 *   4. Revision missing (= newly created page that never got a revision)
 *      → return the empty Y.Doc untouched (after the optional replay).
 *
 *   5. Page missing → throw. Hocuspocus terminates the connection.
 *      Should never happen at this stage because `onAuthenticate`
 *      already enforced page existence.
 */
export function createOnLoadDocument(deps: OnLoadDocumentDeps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Page = deps.models.Page as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Revision = deps.models.Revision as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const PageYjsUpdate = deps.models.PageYjsUpdate as any;

  /**
   * Apply every pending `PageYjsUpdate` for `pageId` into `document`
   * in chronological order. Corrupt rows are warn+skipped. Safe to
   * call on every load path because Y.applyUpdate is idempotent.
   */
  async function replayResidualUpdates(pageId: string, document: Y.Doc): Promise<void> {
    const rows: Array<{ _id: unknown; payload: unknown }> = await PageYjsUpdate.find({ pageId }).sort({ createdAt: 1 }).select('_id payload').lean().exec();
    if (rows.length === 0) return;

    let applied = 0;
    const poisoned: unknown[] = [];
    for (const row of rows) {
      try {
        Y.applyUpdate(document, payloadToUint8Array(row.payload));
        applied += 1;
      } catch (err) {
        poisoned.push(row._id);
        console.warn(`[crowi:collab] onLoadDocument: skipping corrupt PageYjsUpdate for page ${String(pageId)}:`, (err as Error).message);
      }
    }

    // Fail-closed cleanup: drop the corrupt rows so we don't repeat
    // the same warning on every subsequent load of this page. TTL
    // (1h) would eventually clear them anyway — this just shrinks
    // the warning window from an hour to one load.
    if (poisoned.length > 0) {
      try {
        await PageYjsUpdate.deleteMany({ _id: { $in: poisoned } }).exec();
      } catch (err) {
        console.warn(`[crowi:collab] onLoadDocument: failed to clean up ${poisoned.length} corrupt rows for page ${String(pageId)}:`, (err as Error).message);
      }
    }
    debug('replayed %d (poisoned %d) residual updates for page %s', applied, poisoned.length, pageId);
  }

  return async (data: onLoadDocumentPayload<CollabContext>): Promise<void> => {
    const { documentName, document } = data;

    const page = await Page.findById(documentName).select('_id revision currentRevision yjsState').exec();
    if (!page) {
      // Defensive — `onAuthenticate` already confirmed existence, so
      // this branch only fires on a race where the page was deleted
      // between auth and load.
      debug('page %s not found at load time', documentName);
      throw new Error('page not found');
    }

    // Path A — restore from the most recent checkpoint.
    const yjsState = page.yjsState as Buffer | null | undefined;
    let baseRestored = false;
    if (yjsState && yjsState.length > 0) {
      try {
        Y.applyUpdate(document, new Uint8Array(yjsState));
        debug('restored page %s from yjsState (%d bytes)', documentName, yjsState.length);
        baseRestored = true;
      } catch (err) {
        // Phase 6 will broadcast `crowi:force-reload` here; Phase 3
        // logs and falls through to the body-seed fallback so a
        // corrupt yjsState doesn't lock out edits.
        console.warn(`[crowi:collab] yjsState for page ${String(documentName)} failed Y.applyUpdate; falling back to body seed.`, (err as Error).message);
      }
    }

    // Path B — fresh build from the latest revision's body.
    if (!baseRestored) {
      const revisionId = page.currentRevision ?? page.revision;
      if (revisionId) {
        const revision = await Revision.findById(revisionId).select('body').lean().exec();
        if (revision && typeof revision.body === 'string' && revision.body.length > 0) {
          document.getText(CONTENT_FIELD).insert(0, revision.body);
          debug('seeded page %s from revision %s (%d chars)', documentName, revisionId, revision.body.length);
        }
      }
    }

    // Phase 4 — always replay residual append rows on top of whatever
    // base state we restored, so a Hocuspocus crash between compactions
    // (or between an append and the next checkpoint) doesn't lose edits.
    // Yjs CRDT idempotency makes "already-folded" deltas safe to
    // re-apply.
    await replayResidualUpdates(String(documentName), document);
  };
}
