import Debug from 'debug';

const debug = Debug('crowi:collab:doc-epoch');

/**
 * RFC-0017 Phase 1 §4.1.1/§4.2 — the collab lifecycle epoch anchor.
 *
 * `Page.collabLifecycleVersion` is a monotonic integer, `$inc`'d atomically
 * (same `updateOne`) by every lifecycle transition that durably changes
 * what a live collab editor is attached to (rename / soft delete / revert /
 * external body replace). This store records the epoch a server doc was
 * materialised from — `onLoadDocument`'s "expected epoch" — so
 * `executeSave`'s atomic CAS and `onChange`'s best-effort stamp/refuse can
 * read it without a per-call DB round trip.
 *
 * **Critical (unconditional recording)**: unlike `DocBaseRevisionStore`,
 * which SKIPS its `.set(...)` while a page is mid external-edit-invalidation
 * drain (so the sentinel base stays in place and an in-flight stale save
 * still CONFLICTs — see `doc-base-revision.ts` and `hooks/on-load-document.ts`),
 * the epoch MUST be recorded on every load, drain or not. Skipping it during
 * a drain would leave `expectedEpoch` undefined for the fresh-materialising
 * doc, degrading `executeSave`'s epoch predicate to the fail-safe fallback
 * (§4.1) — which is safe, but pointlessly weaker than just recording the
 * real (already-current, since the transition already landed) epoch. There
 * is no epoch-equivalent of the doc-base sentinel: epoch advance ITSELF is
 * the correctness signal (RFC-0017 §0.1's "path/status CAS is insufficient"
 * argument doesn't apply to epoch, which — unlike path — always actually
 * changes on every lifecycle transition).
 *
 * Lifecycle: same overwrite-on-load safety as `DocBaseRevisionStore` — no
 * eager eviction on unload (a stale entry is harmless; a save can only
 * arrive on a live, materialised doc whose epoch was just recorded, and the
 * next `onLoadDocument` for the same documentName always overwrites it).
 * Bounded by the number of distinct pages loaded in this process's
 * lifetime, same bound as `DocBaseRevisionStore` and Hocuspocus's own
 * document registry while docs are live.
 */
export interface DocEpochStore {
  /** Record the `collabLifecycleVersion` a freshly-materialised server doc was seeded from. */
  set(documentName: string, epoch: number): void;
  /**
   * Read the epoch the server doc for `documentName` was materialised from.
   * `undefined` when the doc was never loaded in this process — the save
   * flow / `persistYjsState` treat this as "expected epoch unknown → fall
   * back to the non-epoch predicate" (fail-safe, not a bypass: a process
   * that never recorded a base cannot forge a MATCHING stale epoch either).
   */
  get(documentName: string): number | undefined;
  /** Forget the epoch for a document (teardown / external invalidation). */
  delete(documentName: string): void;
}

export function createDocEpochStore(): DocEpochStore {
  const epochs = new Map<string, number>();
  return {
    set(documentName, epoch) {
      epochs.set(documentName, epoch);
      debug('doc epoch set: %s -> %d', documentName, epoch);
    },
    get(documentName) {
      return epochs.get(documentName);
    },
    delete(documentName) {
      epochs.delete(documentName);
    },
  };
}

/**
 * Normalise a `Page.collabLifecycleVersion` field read off a `.lean()`
 * document to a defined epoch. A non-`number` value only occurs on a
 * pre-migration legacy row that bypassed the schema `default: 0` (raw
 * insert, or a projection that dropped the field) — treated as epoch `0`,
 * matching the schema default every other read path sees. Shared by
 * `onAuthenticate` and `onLoadDocument`, the two hooks that read the field
 * directly off Mongo rather than off an in-memory store.
 */
export function resolvePageEpoch(raw: number | undefined): number {
  return typeof raw === 'number' ? raw : 0;
}
