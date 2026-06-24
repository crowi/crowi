import Debug from 'debug';

const debug = Debug('crowi:collab:doc-base');

/**
 * editor-preview-reliability (round 2, Decision 1) — the SERVER-SIDE save
 * lock anchor.
 *
 * The previous design pinned an edit-base revision on the CLIENT (echoed
 * back in `crowi:save`) and optimistic-locked the page's live
 * `currentRevision` against it. That false-CONFLICTed genuine
 * co-editing: when peer A's save advanced `currentRevision`, peer B's
 * still-pinned (now stale) base diverged and B's next save was rejected
 * even though B was editing the same live doc A just saved.
 *
 * The fix anchors the lock to the revision the SERVER's Hocuspocus
 * document was materialised from, NOT to any individual client:
 *
 *   - `onLoadDocument` records the revision the server doc was seeded /
 *     restored from (its "base revision"), keyed by document name.
 *   - `executeSave` compares the page's live `currentRevision` against the
 *     doc's known base. Equal → the doc is current → commit. Diverged (an
 *     HTTP save or another instance moved the pointer underneath us) →
 *     reject CONFLICT → the client reloads.
 *   - A successful collab save advances the base to the revision it just
 *     created, so the NEXT save locks against the new pointer.
 *
 * Because every connected editor shares the ONE server doc (and therefore
 * the ONE base), multi-user co-editing never false-CONFLICTs: A saves →
 * base advances to A's revision (matching the live `currentRevision`) → B
 * saves against that same base → succeeds.
 *
 * Storage: a process-local `Map<documentName, baseRevisionId | null>`.
 * `null` means "the doc has no base yet" (a brand-new page with no
 * revision, or a doc seeded from an empty body). Single-instance is the
 * supported deployment shape for the checkpoint/lock invariants (RFC-0003
 * §5b out-of-scope for multi-instance data loss), so an in-memory map is
 * sufficient — a cross-instance HTTP/other-replica save that moves
 * `currentRevision` is still caught by the live-`currentRevision`
 * comparison below.
 *
 * Lifecycle: `onLoadDocument` (re)sets the base when a doc is
 * materialised; the doc is materialised once per Hocuspocus document
 * lifetime (first connection under `unloadImmediately: true`) and torn
 * down when its last client disconnects. We do NOT eagerly evict on
 * unload — a stale entry is harmless (the next `onLoadDocument` overwrites
 * it, and a save can only arrive on a live, materialised doc whose base
 * was just set), and there is no `onUnloadDocument` hook wired. The map
 * is bounded by the number of distinct pages edited in a process
 * lifetime, which is the same bound Hocuspocus's own document registry
 * has while docs are live.
 */
export interface DocBaseRevisionStore {
  /** Record the revision a freshly-materialised server doc was seeded from. */
  set(documentName: string, revisionId: string | null): void;
  /**
   * Read the base revision the server doc for `documentName` was
   * materialised from. `undefined` when the doc was never loaded in this
   * process (no base recorded) — distinct from `null` (loaded, but the
   * page had no revision to seed from). The save flow treats `undefined`
   * as "base unknown → fall back to the live-`currentRevision` self-check".
   */
  get(documentName: string): string | null | undefined;
  /** Forget the base for a document (teardown / external invalidation). */
  delete(documentName: string): void;
}

export function createDocBaseRevisionStore(): DocBaseRevisionStore {
  const bases = new Map<string, string | null>();
  return {
    set(documentName, revisionId) {
      bases.set(documentName, revisionId);
      debug('doc base set: %s -> %s', documentName, revisionId ?? '(none)');
    },
    get(documentName) {
      return bases.get(documentName);
    },
    delete(documentName) {
      bases.delete(documentName);
    },
  };
}
