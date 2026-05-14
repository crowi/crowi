import type { Hocuspocus, onLoadDocumentPayload } from '@hocuspocus/server';
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
 * Wire-format reason codes for `crowi:force-reload`. Kept as string
 * literals (not an enum) since there are only two values today; client
 * (Phase 8) reads `kind` only and treats `reason` as debug telemetry.
 *
 *   - `'page-body-replaced'`   — `Page.yjsState` was set to null by
 *                                an external writer (admin tool /
 *                                legacy `/_api`). The Y.Doc has been
 *                                rebuilt from the latest revision
 *                                body. Active editors must reload to
 *                                see the new canonical state.
 *   - `'yjs-state-corruption'` — `Y.applyUpdate(yjsState)` threw.
 *                                Same fallback (revision body seed)
 *                                but rooted in a different cause —
 *                                operators care about the distinction
 *                                in logs.
 */
export type ForceReloadReason = 'page-body-replaced' | 'yjs-state-corruption';

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
 *      no-op). RFC-0003 §Phase 6 — broadcast `crowi:force-reload` so
 *      any *currently active* editor on this document reloads. See
 *      the helper docstring for the timing caveat.
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

  /**
   * Broadcast `crowi:force-reload` to all currently-connected clients
   * on `documentName`. Phase 6 wire — Phase 8 client subscribes to the
   * stateless channel.
   *
   * Timing caveat (see RFC-0003 §Phase 6 plan):
   *
   *   - `onLoadDocument` fires only when Hocuspocus *materialises* a
   *     Document — typically the first connection. With
   *     `unloadImmediately: true` (server.ts default) a document is
   *     destroyed the moment its last client disconnects, so
   *     `instance.documents.get(documentName)` is `undefined` at the
   *     point this hook runs for a previously-idle page.
   *   - In that "no active editors" case `documents.get` is undefined
   *     and we skip the broadcast — the broadcast is a no-op anyway
   *     when no clients are connected.
   *   - When `documents.get` is defined (rare: Hocuspocus re-loaded a
   *     document under `unloadImmediately: false` or a future
   *     explicit invalidator API), the broadcast reaches the active
   *     connections. Keeping the call here means a future toggle of
   *     `unloadImmediately` lights the path up automatically.
   *
   * The full "external edit reload" UX for currently-connected
   * editors needs an explicit invalidator API (Redis pub/sub or HTTP
   * POST from admin tools to collab) — tracked as a Phase 6
   * openQuestion and deferred to a later phase.
   */
  function broadcastForceReload(instance: Hocuspocus | undefined, documentName: string, reason: ForceReloadReason): void {
    // `instance` is always populated at runtime by Hocuspocus, but the
    // Phase 3 smoke test (and similar synthetic drivers) constructs
    // payloads without it. Treat undefined as "no audience" rather
    // than throwing — the same semantic the active-doc lookup uses
    // for an empty Map.
    if (!instance) {
      debug('skip force-reload broadcast: no instance handle (reason=%s)', reason);
      return;
    }
    try {
      const doc = instance.documents.get(documentName);
      if (!doc) {
        debug('skip force-reload broadcast: no active document for %s (reason=%s)', documentName, reason);
        return;
      }
      doc.broadcastStateless(JSON.stringify({ kind: 'crowi:force-reload', reason }));
      debug('broadcast crowi:force-reload (reason=%s) for document %s', reason, documentName);
    } catch (err) {
      // Broadcast failures must never break the load path. Worst case:
      // existing editors miss the reload signal and keep editing the
      // pre-replace state until they reconnect.
      console.warn(`[crowi:collab] onLoadDocument: broadcastStateless failed for ${documentName}:`, (err as Error).message);
    }
  }

  return async (data: onLoadDocumentPayload<CollabContext>): Promise<void> => {
    const { documentName, document, instance } = data;

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
    let forceReloadReason: ForceReloadReason | null = null;
    if (yjsState && yjsState.length > 0) {
      try {
        Y.applyUpdate(document, new Uint8Array(yjsState));
        debug('restored page %s from yjsState (%d bytes)', documentName, yjsState.length);
        baseRestored = true;
      } catch (err) {
        // Phase 6 — broadcast reason 'yjs-state-corruption' below
        // after the fresh build seed runs.
        console.warn(`[crowi:collab] yjsState for page ${String(documentName)} failed Y.applyUpdate; falling back to body seed.`, (err as Error).message);
        forceReloadReason = 'yjs-state-corruption';
      }
    } else {
      // yjsState is null or empty — could be (a) brand-new page that
      // never had a checkpoint (no broadcast needed; no editor was
      // looking at the pre-state state), or (b) an external writer
      // nuked it. We can't distinguish the two from inside the hook,
      // so we broadcast unconditionally with `page-body-replaced`.
      // The cost of a false positive is a single page reload at most;
      // the cost of a false negative is a stale editor.
      forceReloadReason = 'page-body-replaced';
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

    // Phase 6 — fire the broadcast *after* the fresh build seed so any
    // active client that survives the reload signal (race: it's mid-
    // reconnect) would at least pick up the rebuilt state from a
    // fresh syncProtocol. Skipped when path A succeeded (= no
    // fallback was needed).
    if (forceReloadReason !== null) {
      broadcastForceReload(instance, String(documentName), forceReloadReason);
    }

    // Phase 4 — always replay residual append rows on top of whatever
    // base state we restored, so a Hocuspocus crash between compactions
    // (or between an append and the next checkpoint) doesn't lose edits.
    // Yjs CRDT idempotency makes "already-folded" deltas safe to
    // re-apply.
    await replayResidualUpdates(String(documentName), document);
  };
}
