import type { GetPageRequest, PaginationRequest } from '@crowi/api-contract';
import type { UsePageListParams } from './use-page-list';

/**
 * Single registry for every react-query key that touches page content
 * (single page / list / children / revisions) and user-page pagination.
 *
 * Follows the `{ all, detail(...) }` shape already used by `bookmarkKeys`
 * (`use-bookmark.ts`), `seenKeys` (`use-seen.ts`), `watchKeys`
 * (`use-watch.ts`) and `draftsKeys` (`use-drafts.ts`) — this file brings the
 * page/list/children/revisions/user-page families up to the same standard
 * so their root strings and shapes have exactly one owner each.
 *
 * `pageListKeys` and `pageChildrenKeys` intentionally share
 * `PAGE_LIST_FAMILY_ROOT`: a page's parent portal listing (`usePageList`)
 * and the sidebar tree (`usePageChildrenLevels`/`usePageChildren`) must be
 * invalidated together whenever a page's content changes (see
 * `use-page-mutations.ts`'s `invalidatePageContentQueries` and
 * `use-drafts.ts`'s `useCreateDraft`), so callers that want "the whole
 * `pages` family" invalidate `PAGE_LIST_FAMILY_ROOT` directly rather than
 * picking one of the two sub-families by hand.
 */
export const PAGE_LIST_FAMILY_ROOT = ['pages'] as const;

export const pageKeys = {
  all: ['page'] as const,
  detail: (params: GetPageRequest) => ['page', params] as const,
};

export const pageListKeys = {
  all: [...PAGE_LIST_FAMILY_ROOT, 'list'] as const,
  detail: (params: UsePageListParams) => [...PAGE_LIST_FAMILY_ROOT, 'list', params] as const,
};

/**
 * Moved from `use-page-children.ts` (its only prior import source — the
 * sidebar tree hooks in that same file). Not re-exported there.
 */
export const pageChildrenKeys = {
  all: [...PAGE_LIST_FAMILY_ROOT, 'children'] as const,
  detail: (path: string) => [...PAGE_LIST_FAMILY_ROOT, 'children', path] as const,
};

export const revisionsKeys = {
  all: ['revisions'] as const,
  list: (pageId: string, params: { limit?: number; offset?: number }) =>
    ['revisions', { pageId, limit: params.limit ?? null, offset: params.offset ?? null }] as const,
};

/**
 * `use-user-page.ts`'s query families (profile / bookmarks / pages, each
 * with a shared `*All` root plus `*Detail`/`*Infinite` leaves).
 * `isBookmarksQuery`/`isPagesQuery` centralize the positional predicate used by
 * `invalidateQueries({ predicate })` call sites that must refresh every
 * user's bookmark/page list regardless of username (an exact-key
 * `invalidateQueries({ queryKey })` can't express "any username" because
 * react-query only matches a prefix, not a wildcard in the middle of the
 * array) — see `use-page-mutations.ts` (`useDeletePage`/
 * `useRevertDeletedPage`) and `use-bookmark.ts` (`useToggleBookmark`).
 */
export const userPageKeys = {
  profile: (username: string) => ['user', username] as const,
  bookmarksAll: (username: string) => ['user', username, 'bookmarks'] as const,
  bookmarksDetail: (username: string, params: PaginationRequest) => ['user', username, 'bookmarks', params] as const,
  bookmarksInfinite: (username: string, limit: number) => ['user', username, 'bookmarks', 'infinite', limit] as const,
  pagesAll: (username: string) => ['user', username, 'pages'] as const,
  pagesDetail: (username: string, params: PaginationRequest) => ['user', username, 'pages', params] as const,
  pagesInfinite: (username: string, limit: number) => ['user', username, 'pages', 'infinite', limit] as const,
  isBookmarksQuery: (queryKey: readonly unknown[]): boolean => queryKey[0] === 'user' && queryKey[2] === 'bookmarks',
  isPagesQuery: (queryKey: readonly unknown[]): boolean => queryKey[0] === 'user' && queryKey[2] === 'pages',
};
