import type { Page, PageWithRevision } from '@crowi/api-contract';

/**
 * Resolve the user to credit for a page: the last editor, else the
 * creator, else the revision author. Populated user fields may arrive as
 * bare ObjectId strings; only the object form carries name / image /
 * username, so the string form is treated as "not resolvable here" and
 * skipped. Returns `null` when none is populated.
 *
 * Accepts the bare `Page` shape too (not just `PageWithRevision`) —
 * `revision` there is `string | Revision | undefined` (unpopulated list /
 * search responses often carry just the ObjectId string), so it gets the
 * same populated-object guard as `creator` / `lastUpdateUser` before its
 * `.author` is read.
 *
 * Shared by the portal header, the page meta-chip row, and every
 * page-list row (`PageListItem`) so the "who touched this page"
 * precedence stays identical across surfaces.
 */
export function resolveDisplayUser(page: Page | PageWithRevision) {
  const creator = typeof page.creator === 'object' && page.creator ? page.creator : null;
  const lastUpdateUser = typeof page.lastUpdateUser === 'object' && page.lastUpdateUser ? page.lastUpdateUser : null;
  const revision = typeof page.revision === 'object' && page.revision ? page.revision : null;
  const author = revision?.author ?? null;
  return lastUpdateUser ?? creator ?? author;
}
