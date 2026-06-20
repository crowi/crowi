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
   * editor-preview-reliability H4 — drop every pending `PageYjsUpdate` for
   * `pageId` WITHOUT applying them. Used only when we abandon the persisted
   * yjsState lineage and seed from the revision body instead: those deltas
   * descend from the discarded lineage and would duplicate / misplace
   * content if replayed onto the body-seeded doc. Best-effort — a delete
   * failure just leaves the rows for the 1-hour TTL to sweep (they are
   * never replayed onto this body-seeded doc because we returned early).
   */
  async function clearResidualUpdates(pageId: string): Promise<void> {
    try {
      const result = await PageYjsUpdate.deleteMany({ pageId }).exec();
      debug('cleared %d residual updates (abandoned yjsState lineage) for page %s', result?.deletedCount ?? 0, pageId);
    } catch (err) {
      console.warn(`[crowi:collab] onLoadDocument: failed to clear residual rows after body-seed fallback for page ${String(pageId)}:`, (err as Error).message);
    }
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
    // editor-preview-reliability H4 — set when we ABANDON the yjsState
    // lineage and seed from the revision body instead (empty/corrupt
    // yjsState). The residual `PageYjsUpdate` deltas were authored against
    // that discarded lineage; replaying them onto a body-seeded doc (whose
    // state vector differs) duplicates / misplaces content. So in this
    // branch we DROP the residual deltas instead of replaying them — the
    // body is the authoritative baseline.
    let bodySeedFallback = false;
    if (yjsState && yjsState.length > 0) {
      try {
        Y.applyUpdate(document, new Uint8Array(yjsState));
        // editor-preview-reliability §1C — a stale / empty yjsState
        // (e.g. an `[0,0]` empty-doc snapshot that slipped past an
        // older write path, or one that pre-dates the current revision)
        // applies cleanly but leaves the Y.Text empty. Without this
        // check `baseRestored=true` would skip the Path B body seed and
        // hand clients an empty doc — the first save then pushes that
        // empty body and the page content is lost. If the doc is empty
        // but the current revision body is non-empty, fall through to
        // Path B so the body seeds the doc instead of the stale state.
        if (document.getText(CONTENT_FIELD).length > 0) {
          debug('restored page %s from yjsState (%d bytes)', documentName, yjsState.length);
          baseRestored = true;
        } else {
          debug('page %s yjsState decoded to an empty doc — falling back to revision body seed', documentName);
          forceReloadReason = 'page-body-replaced';
          bodySeedFallback = true;
        }
      } catch (err) {
        // Phase 6 — broadcast reason 'yjs-state-corruption' below
        // after the fresh build seed runs.
        console.warn(`[crowi:collab] yjsState for page ${String(documentName)} failed Y.applyUpdate; falling back to body seed.`, (err as Error).message);
        forceReloadReason = 'yjs-state-corruption';
        bodySeedFallback = true;
      }
    }
    // else: yjsState is null or empty. This is the brand-new-page / never-
    // checkpointed case the SAVE + COMPACTION reject policy deliberately
    // produces (anti-shrink leaves yjsState alone and keeps the deltas).
    // The base is built from the body + residual deltas below; we do NOT
    // set `forceReloadReason` here (tail item): a null yjsState is the
    // normal state for a fresh page and for every checkpoint-rejected page,
    // so broadcasting `page-body-replaced` unconditionally would spam
    // spurious force-reloads at connected editors. Only the *abandoned
    // lineage* branches above (stale-empty / corrupt yjsState) signal it.

    // Path B — fresh build from the latest revision's body. Runs both when
    // a yjsState lineage was abandoned (`bodySeedFallback`) AND when there
    // was no yjsState at all — in the latter case the residual deltas below
    // still replay over the body to recover not-yet-folded edits.
    if (!baseRestored) {
      const revisionId = page.currentRevision ?? page.revision;
      if (revisionId) {
        const revision = await Revision.findById(revisionId).select('body').lean().exec();
        if (revision && typeof revision.body === 'string' && revision.body.length > 0) {
          // Normalize CRLF / lone CR → LF before seeding the Y.Text.
          // CodeMirror 6 builds its document by splitting on `/\r\n?|\n/`
          // and re-joining with `\n`, so it silently drops every `\r`.
          // Crowi v1-era revision bodies are CRLF, so seeding one verbatim
          // would leave the Y.Text one char longer *per line* than the
          // editor's view. y-codemirror.next maps positions 1:1 between
          // the two, so that per-line drift lands every subsequent edit at
          // the wrong offset and progressively corrupts the document
          // (worse toward the end, where the accumulated `\r` count is
          // highest). Seeding LF-only keeps the Y.Text and the editor in
          // lockstep; markdown rendering is line-ending agnostic, so this
          // is otherwise a no-op for already-LF (v2-authored) bodies.
          const body = revision.body.replace(/\r\n?/g, '\n');
          document.getText(CONTENT_FIELD).insert(0, body);
          debug('seeded page %s from revision %s (%d chars)', documentName, revisionId, body.length);
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

    if (bodySeedFallback) {
      // editor-preview-reliability H4 — we abandoned the persisted yjsState
      // lineage and seeded from the revision body instead. The residual
      // `PageYjsUpdate` deltas were authored against that discarded lineage;
      // applying them onto the body-seeded doc (different state vector)
      // would duplicate / misplace content rather than merge cleanly. The
      // body is authoritative in this branch, so DROP the stale deltas
      // instead of replaying them.
      await clearResidualUpdates(String(documentName));
      return;
    }

    // Phase 4 — replay residual append rows on top of the restored base
    // (Path A success, or a no-yjsState body seed whose deltas DO descend
    // from the same lineage — e.g. a checkpoint-rejected page whose deltas
    // ARE the deletion we must preserve), so a Hocuspocus crash between
    // compactions (or between an append and the next checkpoint) doesn't
    // lose edits. Yjs CRDT idempotency makes "already-folded" deltas safe
    // to re-apply. The abandoned-lineage cases already returned above.
    await replayResidualUpdates(String(documentName), document);
  };
}
