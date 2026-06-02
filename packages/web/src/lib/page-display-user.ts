import type { PageWithRevision } from '@crowi/api-contract';

/**
 * Resolve the user to credit for a page: the last editor, else the
 * creator, else the revision author. Populated user fields may arrive as
 * bare ObjectId strings; only the object form carries name / image /
 * username, so the string form is treated as "not resolvable here" and
 * skipped. Returns `null` when none is populated.
 *
 * Shared by the portal header and the page meta-chip row so the
 * "who touched this page" precedence stays identical across surfaces.
 */
export function resolveDisplayUser(page: PageWithRevision) {
  const creator = typeof page.creator === 'object' && page.creator ? page.creator : null;
  const lastUpdateUser = typeof page.lastUpdateUser === 'object' && page.lastUpdateUser ? page.lastUpdateUser : null;
  const author = page.revision?.author ?? null;
  return lastUpdateUser ?? creator ?? author;
}
