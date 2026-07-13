import type { PageWithRevision, Revision } from '@crowi/api-contract';

/**
 * feature-live-page-sync-reconcile — pure comparison / merge helpers for
 * the head-GET reconcile path (`PageView`'s `reconcilePageHead` /
 * `applySwap`). Split out of `page-view.tsx` so the tie-break /
 * lifecycle / page-level-merge decisions — the parts of the spec with
 * the most edge cases — are unit-testable without mounting the full
 * component tree (see "設計の主な判断" §5 in the spec, which explicitly
 * leaves this extraction to implementer discretion).
 *
 * These helpers are used ONLY by the head-GET path (reconcile +
 * `handleShowLatest`'s `showing-latest-again` trigger). The push path's
 * `swapToRevision` (by-id, strict compare, narrow field-set) is
 * deliberately NOT routed through here — a push frame's revision id is
 * not guaranteed to be the server's absolute head, so it keeps its own
 * stricter rule (see `page-view.tsx`).
 */

/**
 * Whether `fetched`'s revision supersedes `current`'s. Widened with a
 * tie-break for same-millisecond saves: `Revision.createdAt` is
 * millisecond-precision (`Date.now()`-derived), so two saves inside the
 * same millisecond compare equal under a naive `>` — which would wrongly
 * reject a swap to what IS the server's current head. Safe to widen only
 * for a head-GET result: the frame fence (`pageUpdatedSeq` in
 * `use-presence.ts`) already guarantees no live `page-updated` frame
 * arrived while this GET was in flight, so whatever it read WAS the head
 * at read time. The push path's by-id fetch carries no such guarantee
 * and must keep the strict `>`.
 */
export function isHeadNewer(current: Pick<Revision, '_id' | 'createdAt'>, fetched: Pick<Revision, '_id' | 'createdAt'>): boolean {
  const currentTime = Date.parse(current.createdAt);
  const fetchedTime = Date.parse(fetched.createdAt);
  return fetchedTime > currentTime || (fetchedTime === currentTime && fetched._id !== current._id);
}

/**
 * True when `fetched` is not the same live page as `current` — either a
 * `Page.deletePage` redirect stub (`redirectTo` set on the path that used
 * to hold this page) or a wholesale page replacement (`_id` mismatch,
 * possible if the path was reused). Checked BEFORE any revision compare:
 * a tie-break / swap decision made against a redirect stub's "revision"
 * would be meaningless, and this is exactly the case the stub exists to
 * signal.
 */
export function isLifecycleChanged(current: Pick<PageWithRevision, '_id'>, fetched: Pick<PageWithRevision, '_id' | 'redirectTo'>): boolean {
  return fetched.redirectTo != null || fetched._id !== current._id;
}

/**
 * The page-level fields the grant-only merge branch tracks — everything
 * about the page EXCEPT its revision content. `revision` / `latestRevision`
 * / `updatedAt` / `lastUpdateUser` are deliberately excluded: they all
 * move together whenever the revision itself advances (see
 * `Page.pushRevision`), so that case is already handled by the full-swap
 * branch. This set exists for the OTHER case — `Page.updateGrant` (`PUT
 * /pages/grant`) mutates `grant` / `grantedUsers` without creating a
 * revision, so a revision-only compare would miss it entirely.
 */
const PAGE_LEVEL_KEYS: ReadonlyArray<keyof PageWithRevision> = [
  'grant',
  'grantedUsers',
  'status',
  'creator',
  'liker',
  'commentCount',
  'extended',
  'likerCount',
  'seenUsersCount',
];

/** Whether any page-level (non-revision) field differs between `current` and `fetched`. */
export function pageLevelFieldsChanged(current: PageWithRevision, fetched: PageWithRevision): boolean {
  return PAGE_LEVEL_KEYS.some((key) => JSON.stringify(current[key]) !== JSON.stringify(fetched[key]));
}

/** Assigns a single (matching) key between two same-shaped objects — kept generic so the key's own type is never widened to `any`. */
function copyKey<K extends keyof PageWithRevision>(target: PageWithRevision, source: PageWithRevision, key: K): void {
  target[key] = source[key];
}

/**
 * Merge ONLY the page-level fields from `fetched` into `current`,
 * leaving `revision` / `latestRevision` / `updatedAt` / `lastUpdateUser`
 * untouched. Used for the grant-only branch (spec §5): the displayed
 * body hasn't changed, so the caller must NOT take a pre-swap snapshot,
 * dispatch the banner, or restore scroll for this merge.
 */
export function mergePageLevelFields(current: PageWithRevision, fetched: PageWithRevision): PageWithRevision {
  const merged: PageWithRevision = { ...current };
  for (const key of PAGE_LEVEL_KEYS) {
    copyKey(merged, fetched, key);
  }
  return merged;
}

/**
 * The display name shown in the "◯◯さんが更新しました" banner, mirroring
 * the server's own `editorDisplayName` derivation for the push frame
 * (`packages/api/src/events/presence-broadcast.ts`) so the head-GET path
 * renders the same fallback order.
 */
export function pageUserDisplayName(user: PageWithRevision['lastUpdateUser'] | null | undefined): string {
  return user?.name || user?.username || '';
}
