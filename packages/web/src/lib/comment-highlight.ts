/**
 * feature-live-page-comment-sync — new-comment highlight diff.
 *
 * The live comment list highlights comments that appear *after* the
 * first load (someone else's `comment-changed` triggered a re-fetch),
 * fading the amber background after a few seconds. Which ids are "new"
 * is derived purely from a client-side seen-set diff — NOT from the
 * presence payload's `commentId` — so the highlight is robust to a
 * dropped / duplicated / out-of-order frame and to the origin-instance
 * double delivery: a second delivery re-runs the diff against an
 * already-seen set and yields no new ids.
 *
 * This is factored out as a pure function so the seen-set semantics
 * (first-load suppression + idempotent re-delivery) are unit-testable
 * without rendering the component.
 */

/** Duration the amber background stays before it fades out (ms). */
export const COMMENT_HIGHLIGHT_MS = 3_000;

export interface CommentHighlightDiff {
  /**
   * Comment ids present in `currentIds` that were not in `prevSeen` AND
   * are not authored by the reader — the ones to highlight. Empty on the
   * very first load (see `firstLoad`) and empty for a repeat delivery of
   * an already-seen set.
   */
  newIds: string[];
  /**
   * The seen set to carry forward: `prevSeen` ∪ `currentIds`. Callers
   * store this as the next `prevSeen`. Deleted ids are intentionally
   * retained (harmless — highlight only keys off `newIds`). The reader's
   * own comments are folded in here too so a later re-delivery never
   * re-examines them.
   */
  nextSeen: Set<string>;
}

/**
 * Diff the currently-rendered comment ids against the set already seen.
 *
 *   - `firstLoad` (prevSeen === null): seed the seen set with every
 *     current id and highlight NONE — existing comments on initial load
 *     must not flash.
 *   - otherwise: highlight ids not yet seen; fold them into the seen set.
 *
 * `ownIds` are comment ids authored by the reader. They are folded into
 * the seen set but NEVER returned as new: the reader's own add-mutation
 * invalidates the list and re-fetches it locally (independent of the
 * presence WebSocket, which the client already self-suppresses), so the
 * reader's freshly-posted comment surfaces here as a "newly seen" id.
 * Highlighting it would flash the reader's own comment, violating the
 * self-suppression contract. Author-keyed suppression is authoritative
 * because it holds regardless of which path (local mutation vs. presence
 * fan-out) first surfaced the id.
 */
export function diffNewCommentIds(prevSeen: Set<string> | null, currentIds: readonly string[], ownIds?: ReadonlySet<string>): CommentHighlightDiff {
  if (prevSeen === null) {
    return { newIds: [], nextSeen: new Set(currentIds) };
  }
  const newIds: string[] = [];
  const nextSeen = new Set(prevSeen);
  for (const id of currentIds) {
    if (nextSeen.has(id)) continue;
    nextSeen.add(id);
    // Fold the reader's own comment into the seen set but do not
    // highlight it — see the doc comment above.
    if (ownIds?.has(id)) continue;
    newIds.push(id);
  }
  return { newIds, nextSeen };
}
