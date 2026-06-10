import type { Types } from 'mongoose';
import type Crowi from 'src/crowi';
import { autoWatchPage } from './auto-watch';

/**
 * feature-watch-autosubscribe — one-shot WATCH backfill for pages that
 * predate auto-watch.
 *
 * Auto-watch only materialises `Watcher(STATUS_WATCH)` rows for *future*
 * participation (create / edit / comment — see `util/auto-watch.ts`). The
 * notification fan-out is now watcher-only
 * (`models/activity.ts:getNotificationTargetUsers`), so pages created
 * before auto-watch landed have no watcher rows and their past
 * participants silently stop being notified.
 *
 * This walks every non-redirect page and materialises a WATCH row for its
 * implicit pre-watcher notification set — creator + comment authors +
 * revision authors, exactly what `Page.getNotificationTargetUsers()`
 * returned and the old fan-out used. It reuses `autoWatchPage`, so an
 * existing IGNORE opt-out is respected and existing WATCH rows are left
 * untouched. Idempotent: a second run creates nothing.
 *
 * Run via `crowi-admin watcher backfill [--dry-run]`.
 */
export interface WatcherBackfillSummary {
  pagesScanned: number;
  /** WATCH rows created — or, in dry-run, that WOULD be created. */
  watchersCreated: number;
  dryRun: boolean;
}

export async function runWatcherBackfill(crowi: Crowi, opts: { dryRun?: boolean } = {}): Promise<WatcherBackfillSummary> {
  const dryRun = Boolean(opts.dryRun);
  const Page = crowi.model('Page');
  const Watcher = crowi.model('Watcher');

  let pagesScanned = 0;
  let watchersCreated = 0;

  // Redirect stubs never notify, so skip them. Cursor so a large
  // collection doesn't have to fit in memory.
  const cursor = Page.find({ redirectTo: null }).cursor();
  for (let page = await cursor.next(); page != null; page = await cursor.next()) {
    pagesScanned++;

    // creator + comment authors + revision authors (already de-duped).
    const targets = (await page.getNotificationTargetUsers()) as Array<Types.ObjectId | null | undefined>;
    const seen = new Set<string>();
    const pageId = page._id as Types.ObjectId;

    for (const userId of targets) {
      if (!userId) continue;
      const key = String(userId);
      if (seen.has(key)) continue;
      seen.add(key);

      if (dryRun) {
        // Mirror autoWatchPage's predicate without writing: a WATCH would
        // be created only when no Watcher row (WATCH or IGNORE) exists.
        const existing = await Watcher.findByUserIdAndTargetId(userId, pageId);
        if (!existing) watchersCreated++;
      } else {
        const { newlyWatching } = await autoWatchPage(Watcher, userId, pageId);
        if (newlyWatching) watchersCreated++;
      }
    }
  }

  return { pagesScanned, watchersCreated, dryRun };
}
