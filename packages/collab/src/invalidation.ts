import Debug from 'debug';
import type { DocBaseRevisionStore } from './doc-base-revision';

const debug = Debug('crowi:collab:invalidate');

/**
 * feature-editor-preview-reliability G1 — in-process external-edit
 * invalidation of a live collab document (single-instance).
 *
 * The problem: an external write (`Page.updatePage` via REST / MCP /
 * in-process callers) nulls `yjsState` + bumps `currentRevision`, but under
 * `unloadImmediately: true` the live Hocuspocus Y.Doc survives until its
 * LAST client disconnects. A force-reload broadcast ALONE is insufficient:
 * a client that reloads first re-attaches to the still-stale live doc (held
 * by another still-connected client) and the CONFLICT loop persists. The
 * broadcast must be paired with invalidation / drain.
 *
 * `invalidatePages` performs ONE atomic operation per page:
 *
 *   a. broadcast `crowi:force-reload` (reason) to the active connections;
 *   b. TOMBSTONE the page's doc base so any in-flight old-base save
 *      CONFLICTs (the save flow's compare-and-set early read sees the
 *      tombstone diverge from the live `currentRevision`); and gate NEW
 *      connections (`onLoadDocument`) on the tombstone epoch so a reconnect
 *      during the drain window re-materialises from the NEW
 *      `currentRevision` body instead of the stale live doc;
 *   c. after a short grace, close the document's connections so a client
 *      that ignored the broadcast is forced to reconnect (and then
 *      re-materialises clean).
 *
 * Out of scope (multi-instance / out-of-process — RFC-0003 §5b): a live doc
 * on a DIFFERENT replica, or an admin-CLI DB-direct `Page.updatePage`, is
 * NOT reachable by this in-process handle. That needs Redis pub/sub
 * (`collab:invalidate-page`) to every replica. Documented as a known
 * limitation in `apps/crowi-site/.../operations/realtime-collab.mdx`.
 */

/** Reason codes for an external-edit invalidation broadcast. */
export type InvalidateReason = 'page-body-replaced' | 'page-renamed' | 'page-deleted';

/**
 * Process-local tombstone store for pages whose live doc was invalidated by
 * an external edit. An entry exists only during the brief drain window
 * (`graceMs`) so a reconnect that races the drain re-materialises from the
 * new revision body rather than the stale live doc; the entry is then
 * cleared and the page returns to normal collab behaviour.
 *
 * Backed by `Map<documentName, expiry-epoch-ms>`: `isInvalidating` is a
 * simple time check, so a forgotten clear (e.g. the close throws) self-heals
 * after `graceMs` instead of permanently gating new connections.
 */
export interface InvalidatedPagesStore {
  /** Mark a page as invalidating until `now + graceMs`. */
  mark(documentName: string, graceMs: number): void;
  /** True while the page is within its drain window. */
  isInvalidating(documentName: string): boolean;
  /** Explicitly clear the tombstone (drain finished). */
  clear(documentName: string): void;
}

export function createInvalidatedPagesStore(): InvalidatedPagesStore {
  const expiries = new Map<string, number>();
  return {
    mark(documentName, graceMs) {
      expiries.set(documentName, Date.now() + graceMs);
      debug('mark invalidating: %s (grace=%dms)', documentName, graceMs);
    },
    isInvalidating(documentName) {
      const expiry = expiries.get(documentName);
      if (expiry === undefined) return false;
      if (Date.now() >= expiry) {
        // Self-heal a stale entry whose explicit clear never ran.
        expiries.delete(documentName);
        return false;
      }
      return true;
    },
    clear(documentName) {
      expiries.delete(documentName);
    },
  };
}

/**
 * Sentinel doc-base value written on invalidation. No real Mongo ObjectId
 * string can equal it, so the save flow's early divergence check
 * (`docBase !== liveRevisionStr`) and its compare-and-set pointer write both
 * reject an in-flight save on the stale doc — exactly the CONFLICT we want
 * (§G1 step 2c). The next `onLoadDocument` overwrites it with the real base
 * once the doc re-materialises from the new revision.
 */
export const INVALIDATED_DOC_BASE = '__crowi_invalidated__';

/**
 * Default drain grace (ms) between the force-reload broadcast and forcing
 * the stale connections closed. Long enough for a client to act on the
 * broadcast (open the force-reload dialog, snapshot its recovery buffer) and
 * reload on its own terms; short enough that a client that ignores the
 * broadcast is still kicked promptly so it can't keep saving against the
 * stale doc. Documented as an openQuestion — tune with telemetry.
 */
export const DEFAULT_INVALIDATE_GRACE_MS = 1500;

export interface PageInvalidator {
  /**
   * Invalidate the live collab doc(s) for `pageIds` after an external edit
   * committed. Always resolves (best-effort): a failure to reach a doc must
   * never propagate back into the HTTP / model write that triggered it.
   */
  invalidatePages(pageIds: string[], reason: InvalidateReason): Promise<void>;
}

/**
 * A live Hocuspocus connection, as exposed by `Document.getConnections()`.
 * `close(event)` is `Connection.prototype.close` (installed
 * `@hocuspocus/server@4.0.0`, `dist/hocuspocus-server.cjs`): if the
 * connection is still attached to its document, it detaches, fires the
 * `onClose` callbacks, and sends a close frame to the client — the same
 * effect `Hocuspocus.closeConnections` produces, just reached via the
 * document object directly instead of a registry name lookup (see
 * `InvalidatorInstance`'s doc comment below for why that distinction is
 * load-bearing).
 */
export interface InvalidatorConnection {
  close(event?: { code: number; reason: string }): void;
}

/**
 * The narrow slice of a Hocuspocus engine/document the invalidator touches:
 * look up a live document (to broadcast force-reload and enumerate its
 * connections), **detach it from the registry** (so a reconnect during the
 * drain can't re-attach to the stale Y.Doc), and force-close the
 * connections that were attached to THAT captured document object. A real
 * `Hocuspocus` / `Document` (installed `@hocuspocus/server@4.0.0`)
 * satisfies this structurally; tests pass a minimal fake.
 *
 * **AC-34 (bug fix, verified against the installed `@hocuspocus/server@4.0.0`
 * dist)**: `Hocuspocus.prototype.closeConnections(documentName)` re-looks-up
 * the document BY NAME every time it's called (`this.documents.forEach((d)
 * => { if (documentName && d.name !== documentName) return; ... })`). Once
 * `instance.documents.delete(documentName)` below has run (the SAME-tick
 * detach that lets a reconnect materialise fresh instead of re-attaching to
 * the stale doc), a LATER `instance.closeConnections(documentName)` call —
 * exactly what the scheduled drain used to do — finds NOTHING under that
 * name and closes ZERO connections, silently stranding any client that
 * ignored the force-reload broadcast and kept its stale connection open.
 * Worse, if a NEW document has since been registered under the same name
 * (a reconnect that raced the drain and re-materialised), a name-based
 * `closeConnections` call would kick THAT fresh connection instead — wrong
 * target entirely. The fix: capture the `Document` reference BEFORE
 * detaching it, and after the grace period close ITS connections directly
 * via `getConnections()` — a reference to a JS object stays valid after its
 * registry entry is deleted, and only its actual attached connections are
 * closed regardless of what (if anything) is registered under the name by
 * then.
 */
export interface InvalidatorInstance {
  documents: {
    get(documentName: string): { broadcastStateless(payload: string): void; getConnections(): InvalidatorConnection[] } | undefined;
    delete(documentName: string): void;
  };
}

/**
 * Mirrors `@hocuspocus/common`'s `ResetConnection` `CloseEvent` (code 4205:
 * "the server successfully processed the request, asks that the requester
 * reset its document view, and is not returning any content"). Duplicated
 * as a plain object here rather than adding `@hocuspocus/common` as a
 * direct dependency for one constant — `@hocuspocus/server` re-exports the
 * `Connection` / `Document` TYPES but not this value.
 */
const RESET_CONNECTION_CLOSE_EVENT = { code: 4205, reason: 'Reset Connection' };

export interface CreatePageInvalidatorOptions {
  /** The live Hocuspocus engine whose documents we broadcast to / close. */
  instance: InvalidatorInstance;
  /** Shared doc-base store — tombstoned so in-flight stale saves CONFLICT. */
  docBaseRevisions: DocBaseRevisionStore;
  /** Shared tombstone store gating new connections during the drain. */
  invalidatedPages: InvalidatedPagesStore;
  /** Drain grace (ms). Defaults to {@link DEFAULT_INVALIDATE_GRACE_MS}. */
  graceMs?: number;
  /**
   * Schedule the post-grace close. Defaults to `setTimeout` (with `unref` so
   * the timer can't keep a process alive). Tests inject a synchronous
   * scheduler so they can drive the drain deterministically.
   */
  schedule?: (fn: () => void, ms: number) => void;
}

export function createPageInvalidator(opts: CreatePageInvalidatorOptions): PageInvalidator {
  const { instance, docBaseRevisions, invalidatedPages } = opts;
  const graceMs = opts.graceMs ?? DEFAULT_INVALIDATE_GRACE_MS;
  const schedule =
    opts.schedule ??
    ((fn, ms): void => {
      const timer = setTimeout(fn, ms);
      // Never block process exit on a pending drain timer.
      if (typeof timer === 'object' && timer && 'unref' in timer && typeof timer.unref === 'function') {
        timer.unref();
      }
    });

  return {
    async invalidatePages(pageIds, reason) {
      for (const pageId of pageIds) {
        try {
          // Step 2c + 2d — tombstone FIRST so any save that arrives between
          // here and the close CONFLICTs, and any NEW connection's
          // onLoadDocument gate re-materialises from the new revision body
          // rather than the stale live doc.
          docBaseRevisions.set(pageId, INVALIDATED_DOC_BASE);
          invalidatedPages.mark(pageId, graceMs);

          // Step 2a — broadcast force-reload to whoever is connected now.
          const doc = instance.documents.get(pageId);
          if (doc) {
            try {
              doc.broadcastStateless(JSON.stringify({ kind: 'crowi:force-reload', reason }));
              debug('broadcast crowi:force-reload (reason=%s) for page %s', reason, pageId);
            } catch (err) {
              console.warn(`[crowi:collab] invalidatePages: broadcastStateless failed for page ${pageId}:`, (err as Error).message);
            }

            // Blocker 1 — SYNCHRONOUSLY detach the stale doc from the engine
            // registry, immediately after the broadcast and BEFORE the grace
            // fires. Hocuspocus's existing-doc fast path returns
            // `documents.get(documentName)` WITHOUT calling `onLoadDocument`,
            // so a reconnect that races the drain would otherwise re-attach to
            // the stale live Y.Doc (held alive by another still-connected
            // client under `unloadImmediately`). Removing it from the registry
            // forces the next connection through `onLoadDocument`, which
            // re-materialises from the NEW `currentRevision` body (the external
            // write already nulled `yjsState`). The `invalidatedPages`
            // tombstone STAYS in place until the scheduled close/unload
            // completes (cleared in the drain's `finally` below, NOT here) so
            // a still-attached client's in-flight save keeps CONFLICTing
            // against the sentinel doc base, and so the re-materialising
            // connection skips re-recording a real base (see `onLoadDocument`).
            // The captured `doc` reference above keeps the broadcast working;
            // the detach only governs NEW connections.
            try {
              instance.documents.delete(pageId);
              debug('invalidatePages: detached stale doc for page %s from the registry (reconnect re-materialises clean)', pageId);
            } catch (err) {
              console.warn(`[crowi:collab] invalidatePages: documents.delete failed for page ${pageId}:`, (err as Error).message);
            }
          } else {
            // No active doc — the external edit already nulled yjsState, so
            // the next connection rebuilds from the new body cleanly. Clear
            // the tombstone immediately; there is nothing to drain.
            debug('invalidatePages: no active doc for page %s — nothing to drain', pageId);
            invalidatedPages.clear(pageId);
            continue;
          }

          // Step 2b (close) — after the grace window, force the stale
          // connections closed so a client that ignored the broadcast is
          // kicked and must reconnect (then re-materialises clean).
          //
          // AC-34 fix: close the CAPTURED `doc`'s own connections directly
          // (`doc.getConnections()`) instead of `instance.closeConnections
          // (pageId)`. The latter re-looks-up the registry BY NAME — an
          // entry this same function already deleted above — and would
          // silently close nothing (or, worse, close a DIFFERENT document
          // that reconnected under the same name during the grace window).
          // The `doc` reference stays valid and its connections stay
          // attached to it regardless of the registry state; closing each
          // one directly reaches a stale client even though it's no longer
          // reachable by name.
          schedule(() => {
            try {
              const connections = doc.getConnections();
              for (const connection of connections) {
                connection.close(RESET_CONNECTION_CLOSE_EVENT);
              }
              debug('invalidatePages: closed %d stale connection(s) for page %s after %dms grace', connections.length, pageId, graceMs);
            } catch (err) {
              console.warn(`[crowi:collab] invalidatePages: closing stale connections failed for page ${pageId}:`, (err as Error).message);
            } finally {
              invalidatedPages.clear(pageId);
            }
          }, graceMs);
        } catch (err) {
          // Defensive — invalidation is best-effort and must never bubble
          // back into the triggering write.
          console.warn(`[crowi:collab] invalidatePages failed for page ${pageId}:`, (err as Error).message);
          invalidatedPages.clear(pageId);
        }
      }
    },
  };
}
