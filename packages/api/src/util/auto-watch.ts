/**
 * feature-watch-autosubscribe — auto-watch helper.
 *
 * When a user participates in a page (creates it, saves a new revision, or
 * comments), we materialise an explicit `Watcher(STATUS_WATCH)` row so the
 * notification fan-out — now watcher-only (see
 * `models/activity.ts:getNotificationTargetUsers`) — reaches them, and so
 * they can plainly unwatch later.
 *
 * Semantics (single source of truth for all three call sites):
 *   - An existing IGNORE row is respected: never overwrite it (the user
 *     explicitly opted out). No-op, `newlyWatching = false`.
 *   - An existing WATCH row: no-op, `newlyWatching = false`.
 *   - No row at all: create a WATCH row, `newlyWatching = true`.
 *
 * `Watcher.upsertWatcher` is intentionally NOT used here: it does a
 * `findOneAndUpdate({ user, target }, { status })` with `upsert`, which
 * stomps an existing IGNORE back to WATCH. We must branch on the existing
 * row's status first.
 *
 * The `target` is always a Page (`targetModel = 'Page'`) for the current
 * call sites; this matches `Activity` / `Watcher` usage elsewhere.
 */
import type { Types } from 'mongoose';
import type { WatcherModel } from 'src/models/watcher';

const TARGET_MODEL_PAGE = 'Page';

export interface AutoWatchResult {
  /** true only when this call created a brand-new WATCH row. */
  newlyWatching: boolean;
}

/**
 * Materialise a WATCH watcher row for `userId` on `pageId`, respecting an
 * existing IGNORE opt-out. Returns whether a new WATCH row was created so
 * callers (e.g. the comment handler) can surface a "now watching" hint.
 */
export async function autoWatchPage(Watcher: WatcherModel, userId: Types.ObjectId, pageId: Types.ObjectId): Promise<AutoWatchResult> {
  const existing = await Watcher.findByUserIdAndTargetId(userId, pageId);
  if (existing) {
    // Either IGNORE (respect opt-out) or already WATCH — nothing to do.
    return { newlyWatching: false };
  }

  await Watcher.create({
    user: userId,
    targetModel: TARGET_MODEL_PAGE,
    target: pageId,
    status: Watcher.STATUS_WATCH,
  });
  return { newlyWatching: true };
}
