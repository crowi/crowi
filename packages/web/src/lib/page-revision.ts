import type { Page } from '@crowi/api-contract';

/**
 * A page is being viewed at a *stale* (past) revision: the server rewound
 * `revision` to the requested past version and kept the current one in
 * `latestRevision` (see `populatePageData`). Both the normal page view
 * (page-view) and the portal document (page-list) use this to decide whether
 * to show the "this version" warning banner + one-click revert button, so the
 * judgement lives here to stay in sync across the two call sites.
 */
export function isStalePageRevision(page: Pick<Page, 'latestRevision' | 'revision'> | null | undefined): boolean {
  const revisionId = typeof page?.revision === 'string' ? page.revision : page?.revision?._id;
  return Boolean(page?.latestRevision && revisionId && page.latestRevision !== revisionId);
}
