import type { Hocuspocus, onLoadDocumentPayload } from '@hocuspocus/server';
import Debug from 'debug';
import * as Y from 'yjs';
import type { DocBaseRevisionStore } from '../doc-base-revision';
import { type DocEpochStore, resolvePageEpoch } from '../doc-epoch';
import type { InvalidatedPagesStore } from '../invalidation';
import type { CollabModels } from '../models';
import { DELETED_STATUS } from '../page-status';
import type { CollabContext } from '../types';
import { CONTENT_FIELD } from '../yjs-doc';
import { payloadToUint8Array } from '../yjs-payload';

const debug = Debug('crowi:collab:load');

export interface OnLoadDocumentDeps {
  models: Pick<CollabModels, 'Page' | 'Revision' | 'PageYjsUpdate'>;
  /**
   * Round 2, Decision 1 — the server-doc save lock anchor. When the doc is
   * materialised we record the revision it was seeded / restored from here
   * so `executeSave` can compare-and-set the page pointer against it.
   * Optional so synthetic test drivers / the Phase 3 smoke test can omit it.
   */
  docBaseRevisions?: DocBaseRevisionStore;
  /**
   * RFC-0017 Phase 1 §4.1.1 — the collab lifecycle epoch anchor,
   * recorded UNCONDITIONALLY on every load (drain or not — see
   * `doc-epoch.ts`'s doc comment for why this differs from
   * `docBaseRevisions`'s conditional recording). Optional so synthetic test
   * drivers can omit it (epoch enforcement then degrades to the fail-safe
   * "expected epoch unknown" fallback everywhere it's read).
   */
  docEpochRevisions?: DocEpochStore;
  /**
   * G1 — the external-edit invalidation tombstone store. When a page is
   * mid-drain (its live doc was just invalidated by an external write) the
   * persisted `yjsState` is already null, so the fresh build below
   * re-materialises from the NEW `currentRevision` body anyway; we just skip
   * recording a doc base while the tombstone is active so an in-flight stale
   * save still CONFLICTs (the invalidator's sentinel base stays in place
   * until the drain ends). Optional so synthetic test drivers can omit it.
   */
  invalidatedPages?: InvalidatedPagesStore;
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
  const docBaseRevisions = deps.docBaseRevisions;
  const docEpochRevisions = deps.docEpochRevisions;
  const invalidatedPages = deps.invalidatedPages;

  /**
   * Apply every pending `PageYjsUpdate` for `pageId` into `document`
   * in chronological order. Corrupt rows are warn+skipped. Safe to
   * call on every load path because Y.applyUpdate is idempotent.
   *
   * RFC-0017 Phase 1 §4.2/AC-15 — replay ONLY current-epoch rows.
   * `collabLifecycleVersion` missing on a row (pre-RFC-0017, or a row
   * appended by an epoch-unaware process — see `on-change.ts`'s fail-safe
   * skip) is treated as epoch `0`: it replays fine on a never-transitioned
   * page (current epoch `0`) and is correctly excluded once any lifecycle
   * transition has advanced the page past `0`. Stale-epoch rows are
   * best-effort swept alongside poisoned ones — they can never become
   * current again (epoch only advances), so leaving them for the 1h TTL
   * buys nothing.
   */
  async function replayResidualUpdates(pageId: string, document: Y.Doc, currentEpoch: number): Promise<void> {
    const rows: Array<{ _id: unknown; payload: unknown; collabLifecycleVersion?: number }> = await PageYjsUpdate.find({ pageId })
      .sort({ createdAt: 1 })
      .select('_id payload collabLifecycleVersion')
      .lean()
      .exec();
    if (rows.length === 0) return;

    let applied = 0;
    let skippedStaleEpoch = 0;
    const toSweep: unknown[] = [];
    for (const row of rows) {
      const rowEpoch = row.collabLifecycleVersion ?? 0;
      if (rowEpoch !== currentEpoch) {
        skippedStaleEpoch += 1;
        toSweep.push(row._id);
        continue;
      }
      try {
        Y.applyUpdate(document, payloadToUint8Array(row.payload));
        applied += 1;
      } catch (err) {
        toSweep.push(row._id);
        console.warn(`[crowi:collab] onLoadDocument: skipping corrupt PageYjsUpdate for page ${String(pageId)}:`, (err as Error).message);
      }
    }

    // Fail-closed cleanup: drop the corrupt / stale-epoch rows so we don't
    // repeat the same warning (or the same stale-epoch skip) on every
    // subsequent load of this page. TTL (1h) would eventually clear them
    // anyway — this just shrinks the window.
    if (toSweep.length > 0) {
      try {
        await PageYjsUpdate.deleteMany({ _id: { $in: toSweep } }).exec();
      } catch (err) {
        console.warn(
          `[crowi:collab] onLoadDocument: failed to clean up ${toSweep.length} corrupt/stale-epoch rows for page ${String(pageId)}:`,
          (err as Error).message,
        );
      }
    }
    debug('replayed %d (stale-epoch skipped %d, of %d total) residual updates for page %s', applied, skippedStaleEpoch, rows.length, pageId);
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
   * High (G1) — count, then DROP, residual `PageYjsUpdate` rows that were
   * created strictly BEFORE `before` (the current revision's creation time)
   * WITHOUT applying them. We seeded the doc from a revision that is newer
   * than these rows, so they descend from a now-superseded lineage (an
   * external write nulled `yjsState` + bumped `currentRevision` but left the
   * append log behind). Replaying them onto the new body would auto-merge
   * stale content back in. Rows created at/after `before` are genuine
   * not-yet-folded collab edits and are LEFT for the caller to replay.
   *
   * Returns the number of rows that survive the purge (so the caller can skip
   * the replay round-trip when nothing is left). Best-effort: a delete failure
   * is logged and the surviving count is reported optimistically as
   * `total - olderRows` so the caller still replays the newer rows.
   *
   * RFC-0017 Phase 1 §4.2/AC-15/AC-29 — ALSO purges rows whose
   * `collabLifecycleVersion` doesn't match `currentEpoch`, independent of
   * the time check. This is what makes the revert scenario safe when a row
   * was appended (by a stale, epoch-unaware `onChange`) to the deleted
   * page's `_id` mid-drain, BEFORE the delete-time `purgeCollabLineage`
   * ran, and the drain hasn't re-purged yet: the row's epoch is stamped
   * from before the delete/revert transitions, so it's excluded here even
   * though its `createdAt` might be at/after `before` (a revert's reverted
   * revision can predate a same-timestamp stale append).
   */
  async function purgeStaleResidualUpdates(pageId: string, before: Date, currentEpoch: number): Promise<number> {
    let total = 0;
    let stale = 0;
    try {
      const rows: Array<{ _id: unknown; createdAt?: Date; collabLifecycleVersion?: number }> = await PageYjsUpdate.find({ pageId })
        .select('_id createdAt collabLifecycleVersion')
        .lean()
        .exec();
      total = rows.length;
      const staleIds = rows
        .filter((row) => (row.createdAt instanceof Date && row.createdAt.getTime() < before.getTime()) || (row.collabLifecycleVersion ?? 0) !== currentEpoch)
        .map((row) => row._id);
      stale = staleIds.length;
      if (staleIds.length > 0) {
        const result = await PageYjsUpdate.deleteMany({ _id: { $in: staleIds } }).exec();
        debug('purged %d stale (pre-external-edit or stale-epoch) residual updates for page %s', result?.deletedCount ?? staleIds.length, pageId);
      }
    } catch (err) {
      console.warn(`[crowi:collab] onLoadDocument: failed to purge stale residual rows for page ${String(pageId)}:`, (err as Error).message);
    }
    return Math.max(0, total - stale);
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

    const page = await Page.findById(documentName).select('_id revision currentRevision yjsState status collabLifecycleVersion').exec();
    if (!page) {
      // Defensive — `onAuthenticate` already confirmed existence, so
      // this branch only fires on a race where the page was deleted
      // between auth and load.
      debug('page %s not found at load time', documentName);
      throw new Error('page not found');
    }

    // RFC-0017 Phase 1 §4.1.1/AC-19 — record the epoch UNCONDITIONALLY
    // (drain or not, about-to-reject-as-deleted or not — see `doc-epoch.ts`'s
    // doc comment for why this store, unlike `docBaseRevisions` below, has
    // no conditional-skip branch). Missing on-disk (pre-migration legacy
    // row bypassing the schema default) reads as `0`.
    const currentEpoch = resolvePageEpoch(page.collabLifecycleVersion);
    docEpochRevisions?.set(String(documentName), currentEpoch);

    // RFC-0017 Phase 1 §5/AC-19 — reject a soft-deleted page BEFORE any
    // Y.Doc materialisation (no yjsState restore, no body seed). Generic
    // message — `onAuthenticate` already gated this connection once, so a
    // deleted-mid-session race is the only way to reach here; the message
    // must not distinguish "deleted" from "missing" (same leak-prevention
    // posture as the not-found branch above).
    if (page.status === DELETED_STATUS) {
      debug('page %s is deleted at load time — rejecting materialisation', documentName);
      throw new Error('page not found');
    }

    // Round 2, Decision 1 — record the revision THIS server doc is being
    // materialised from (its "base") so `executeSave`'s compare-and-set
    // locks against it. `currentRevision ?? revision` mirrors the pointer
    // the save flow advances; `null` when the page has no revision yet.
    //
    // G1 — but NOT while an external-edit invalidation is draining this
    // page. The invalidator wrote a sentinel base (`INVALIDATED_DOC_BASE`)
    // so any in-flight save on the stale doc CONFLICTs; if we overwrote it
    // here with the (already-advanced) live `currentRevision`, a save racing
    // the drain would suddenly match and clobber the external edit. The
    // tombstone self-clears after the grace window, after which the next
    // load records a real base normally. The doc still re-materialises from
    // the new revision body below (the external write nulled yjsState), so
    // the connection that survives the drain sees correct content.
    if (!invalidatedPages?.isInvalidating(String(documentName))) {
      const baseRevisionId = (page.currentRevision ?? page.revision ?? null) as { toString(): string } | null;
      docBaseRevisions?.set(String(documentName), baseRevisionId ? baseRevisionId.toString() : null);
    } else {
      debug('page %s is mid-invalidation drain — leaving the sentinel doc base in place', documentName);
    }

    // Path A — restore from the most recent checkpoint.
    const yjsState = page.yjsState as Buffer | null | undefined;
    let baseRestored = false;
    let forceReloadReason: ForceReloadReason | null = null;
    // editor-preview-reliability — set when we ABANDON the yjsState lineage
    // and seed from the revision body instead (empty/corrupt yjsState).
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
    let bodySeedChars = 0;
    // High (G1) — the current revision's creation time, used below to detect
    // residual `PageYjsUpdate` rows that predate the (externally written) body
    // we just seeded from and therefore descend from a superseded lineage.
    let bodySeedRevisionCreatedAt: Date | null = null;
    if (!baseRestored) {
      const revisionId = page.currentRevision ?? page.revision;
      if (revisionId) {
        const revision = await Revision.findById(revisionId).select('body createdAt').lean().exec();
        if (revision && revision.createdAt instanceof Date) {
          bodySeedRevisionCreatedAt = revision.createdAt;
        }
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
          bodySeedChars = body.length;
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

    // C2 (round 2) — decide how to treat the residual `PageYjsUpdate` deltas
    // when we ABANDONED a yjsState lineage and body-seeded instead.
    //
    //   - body seed put CONTENT in (`bodySeedChars > 0`): the body is the
    //     authoritative baseline and the deltas descend from the discarded
    //     lineage (a different state vector), so replaying them would
    //     duplicate / misplace content. DROP them — the original H4 fix.
    //   - body seed put NOTHING in (`bodySeedChars === 0`: empty / missing
    //     revision body): the residual deltas may carry the ONLY content the
    //     user has (e.g. a brand-new page whose first edits never folded, or
    //     a checkpoint-rejected deletion). Dropping them here would lose that
    //     content. So we DON'T abandon them — fall through to the replay
    //     below so they materialise the doc.
    //
    // This is the difference between the previous code (which dropped ALL
    // deltas on any `bodySeedFallback`, losing the only-content case) and
    // the C2-correct behaviour.
    if (bodySeedFallback && bodySeedChars > 0) {
      await clearResidualUpdates(String(documentName));
      return;
    }

    // High (G1) — the EXTERNAL-EDIT lineage break. When `yjsState` was
    // genuinely null/empty (NOT an abandoned-on-decode lineage: `!baseRestored
    // && !bodySeedFallback`) yet the current revision body seeded NON-empty
    // content (`bodySeedChars > 0`), an external write may have nulled
    // `yjsState` + bumped `currentRevision` to a new body (`Page.updatePage`
    // via REST / MCP / in-process). `Page.updatePage` nulls `yjsState` but does
    // not delete the append log, so any residual `PageYjsUpdate` rows from
    // BEFORE that new revision descend from the OLD (pre-external-edit) lineage;
    // replaying them onto the external body would auto-merge stale content back
    // in, contradicting the "external edit canonical, manual merge" design.
    //
    // We can't blanket-drop here, because the SAME shape (null yjsState +
    // non-empty body + residual rows) also occurs for a fresh page whose collab
    // edits were appended AFTER its revision and simply haven't folded yet —
    // those must replay. The discriminator is time: rows created strictly
    // before the seeded revision are stale (an external write superseded them);
    // rows created at/after it are genuine not-yet-folded edits. So we PURGE
    // only the pre-revision rows and replay the rest.
    //
    // Not reached by the legitimate Path-A cases (a checkpoint-rejected
    // deletion keeps the OLD non-null yjsState → `baseRestored`) nor by the C2
    // only-content case (`bodySeedChars === 0`).
    if (!baseRestored && !bodySeedFallback && bodySeedChars > 0 && bodySeedRevisionCreatedAt) {
      const surviving = await purgeStaleResidualUpdates(String(documentName), bodySeedRevisionCreatedAt, currentEpoch);
      if (surviving === 0) {
        return;
      }
    }

    // Phase 4 — replay residual append rows on top of the restored / seeded
    // base. Covers:
    //   - Path A success (deltas not yet folded into yjsState),
    //   - a no-yjsState body seed whose deltas descend from the same lineage
    //     (a checkpoint-rejected deletion we must preserve), and
    //   - C2: an abandoned-lineage fallback where the body seed was empty,
    //     so the deltas carry the only content.
    // Yjs CRDT idempotency makes already-folded deltas safe to re-apply.
    // RFC-0017 Phase 1 §4.2/AC-15 — current-epoch-only (see the function doc).
    await replayResidualUpdates(String(documentName), document, currentEpoch);
  };
}
