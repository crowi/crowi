'use client';

import { useMutation, useQueryClient, type InfiniteData, type Query, type QueryClient } from '@tanstack/react-query';
import type {
  Bookmark,
  ListPagesResponse,
  Page,
  PageWithRevision,
  RecentlyViewedPagesResponse,
  SearchPagesResponse,
  UserBookmarksResponse,
  UserPageResponse,
  UserPagesResponse,
} from '@crowi/api-contract';
import { apiClient } from './api-client';
import { likersKeys } from './use-likers';
import { notify } from './notify';
import { m } from '@paraglide/messages.js';

/**
 * Query key prefix for like-related caches. Kept as a stable export even
 * though nothing else keys directly off it — `useToggleLike` invalidates
 * per-family keys (see the registry below) instead of a single `['like']`
 * root, since "is liked" is not cached on its own: it lives on every
 * cached Page object as `page.isLiked` (feature-page-relations-collections
 * D-2), never derived from a `liker` id array.
 */
export const likeKeys = {
  all: ['like'] as const,
};

/** Cached shape of a `['page', ...]` query (see `usePage`). */
interface CachedPageData {
  page: PageWithRevision | null;
  notFound: boolean;
  notGranted: boolean;
}

/** The 3 relation fields every cached Page-shaped object carries (D-2). */
interface PageRelationFields {
  isLiked: boolean;
  likerCount: number;
}

type ComputeNext = (current: PageRelationFields) => PageRelationFields;

/**
 * Patch a single page-shaped object IF its `_id` matches `pageId`.
 * Returns the SAME reference when there is no match or the computed
 * values are identical to the current ones (so a family patch function can
 * cheaply detect "nothing changed" by reference equality and skip
 * `setQueryData` on that entry).
 */
function patchPageIfMatch<P extends Pick<Page, '_id' | 'isLiked' | 'likerCount'>>(page: P, pageId: string, computeNext: ComputeNext): P {
  if (page._id !== pageId) return page;
  const next = computeNext({ isLiked: page.isLiked, likerCount: page.likerCount });
  if (next.isLiked === page.isLiked && next.likerCount === page.likerCount) return page;
  return { ...page, isLiked: next.isLiked, likerCount: next.likerCount };
}

/** True when `data` (of a family this patcher recognizes) embeds a page with this id, regardless of its current values. */
function collectorFor(finder: (data: unknown) => Iterable<Pick<Page, '_id'>>) {
  return (data: unknown, pageId: string): boolean => {
    for (const page of finder(data)) {
      if (page._id === pageId) return true;
    }
    return false;
  };
}

/**
 * D-2 reconciler registry — one entry per query-cache family that can hold
 * a Page (or Bookmark-wrapping-a-Page) object. `useToggleLike`'s
 * optimistic patch, server-response reflection, error rollback, and
 * post-toggle invalidation all go through this registry so a newly added
 * Page-holding cache family only needs one new entry here (see this file's
 * module doc / the spec's D-2 registry table — extend this array, not the
 * mutation logic below).
 *
 * `*Infinite` variants share their `*Detail` sibling's `patchOne` via
 * `asInfinite`, applied to each `InfiniteData.pages[]` element.
 */
interface FamilyHandler {
  /** True when `queryKey` belongs to this family. */
  matches: (queryKey: readonly unknown[]) => boolean;
  /** Returns a NEW data object if any embedded page matched `pageId` and changed, else the SAME reference. */
  patch: (data: unknown, pageId: string, computeNext: ComputeNext) => unknown;
  /** True when `data` embeds a page with this id (used to scope invalidation — never blanket-invalidate an unrelated list). */
  contains: (data: unknown, pageId: string) => boolean;
}

function asInfinite<T>(patchOne: (data: T, pageId: string, computeNext: ComputeNext) => T): FamilyHandler['patch'] {
  return (data, pageId, computeNext) => {
    const infinite = data as InfiniteData<T>;
    let changed = false;
    const pages = infinite.pages.map((page) => {
      const next = patchOne(page, pageId, computeNext);
      if (next !== page) changed = true;
      return next;
    });
    if (!changed) return data;
    return { ...infinite, pages };
  };
}

function asInfiniteContains<T>(findOne: (data: T) => Iterable<Pick<Page, '_id'>>): FamilyHandler['contains'] {
  const collect = collectorFor((data: unknown) => findOne(data as T));
  return (data, pageId) => (data as InfiniteData<T>).pages.some((page) => collect(page, pageId));
}

/** Shared by every family whose payload is exactly `{ pages: Page[], ...rest }` (`UserPagesResponse`, `RecentlyViewedPagesResponse`). */
function* pagesArrayPages<T extends { pages: Page[] }>(data: T): Iterable<Pick<Page, '_id'>> {
  yield* data.pages;
}
function patchPagesArrayResponse<T extends { pages: Page[] }>(data: T, pageId: string, computeNext: ComputeNext): T {
  let changed = false;
  const pages = data.pages.map((p) => {
    const next = patchPageIfMatch(p, pageId, computeNext);
    if (next !== p) changed = true;
    return next;
  });
  if (!changed) return data;
  return { ...data, pages };
}

// -- pageKeys — { page: PageWithRevision | null, notFound, notGranted } ----
function* pagePages(data: CachedPageData): Iterable<Pick<Page, '_id'>> {
  if (data.page) yield data.page;
}
const pageFamily: FamilyHandler = {
  matches: (key) => key[0] === 'page',
  patch: (data, pageId, computeNext) => {
    const d = data as CachedPageData;
    if (!d.page) return data;
    const patched = patchPageIfMatch(d.page, pageId, computeNext);
    if (patched === d.page) return data;
    return { ...d, page: patched };
  },
  contains: collectorFor((data) => pagePages(data as CachedPageData)),
};

// -- pageListKeys — ListPagesResponse: pages[], portalPage, contentPage ----
function* listPages(data: ListPagesResponse): Iterable<Pick<Page, '_id'>> {
  yield* data.pages;
  if (data.portalPage) yield data.portalPage;
  if (data.contentPage) yield data.contentPage;
}
const pageListFamily: FamilyHandler = {
  matches: (key) => key[0] === 'pages' && key[1] === 'list',
  patch: (data, pageId, computeNext) => {
    const d = data as ListPagesResponse;
    let changed = false;
    const pages = d.pages.map((p) => {
      const next = patchPageIfMatch(p, pageId, computeNext);
      if (next !== p) changed = true;
      return next;
    });
    const portalPage = d.portalPage ? patchPageIfMatch(d.portalPage, pageId, computeNext) : d.portalPage;
    if (portalPage !== d.portalPage) changed = true;
    const contentPage = d.contentPage ? patchPageIfMatch(d.contentPage, pageId, computeNext) : d.contentPage;
    if (contentPage !== d.contentPage) changed = true;
    if (!changed) return data;
    return { ...d, pages, portalPage, contentPage };
  },
  contains: collectorFor((data) => listPages(data as ListPagesResponse)),
};

// -- userPageKeys.profile — UserPageResponse: recentPages[], recentBookmarks[].page --
function* profilePages(data: UserPageResponse): Iterable<Pick<Page, '_id'>> {
  if (data.recentPages) yield* data.recentPages;
  if (data.recentBookmarks) {
    for (const b of data.recentBookmarks) yield b.page;
  }
}
const userProfileFamily: FamilyHandler = {
  matches: (key) => key[0] === 'user' && key.length === 2,
  patch: (data, pageId, computeNext) => {
    const d = data as UserPageResponse;
    let changed = false;
    const recentPages = d.recentPages?.map((p) => {
      const next = patchPageIfMatch(p, pageId, computeNext);
      if (next !== p) changed = true;
      return next;
    });
    const recentBookmarks = d.recentBookmarks?.map((b) => {
      const next = patchPageIfMatch(b.page, pageId, computeNext);
      if (next === b.page) return b;
      changed = true;
      return { ...b, page: next };
    });
    if (!changed) return data;
    return { ...d, recentPages: recentPages ?? d.recentPages, recentBookmarks: recentBookmarks ?? d.recentBookmarks };
  },
  contains: collectorFor((data) => profilePages(data as UserPageResponse)),
};

// -- userPageKeys.bookmarksDetail/Infinite — UserBookmarksResponse: bookmarks[].page --
function* bookmarksPages(data: UserBookmarksResponse): Iterable<Pick<Page, '_id'>> {
  for (const b of data.bookmarks) yield b.page;
}
function patchBookmarksResponse(data: UserBookmarksResponse, pageId: string, computeNext: ComputeNext): UserBookmarksResponse {
  let changed = false;
  const bookmarks = data.bookmarks.map((b: Bookmark) => {
    const next = patchPageIfMatch(b.page, pageId, computeNext);
    if (next === b.page) return b;
    changed = true;
    return { ...b, page: next };
  });
  if (!changed) return data;
  return { ...data, bookmarks };
}
const userBookmarksDetailFamily: FamilyHandler = {
  matches: (key) => key[0] === 'user' && key[2] === 'bookmarks' && key[3] !== 'infinite',
  patch: (data, pageId, computeNext) => patchBookmarksResponse(data as UserBookmarksResponse, pageId, computeNext),
  contains: collectorFor((data) => bookmarksPages(data as UserBookmarksResponse)),
};
const userBookmarksInfiniteFamily: FamilyHandler = {
  matches: (key) => key[0] === 'user' && key[2] === 'bookmarks' && key[3] === 'infinite',
  patch: asInfinite(patchBookmarksResponse),
  contains: asInfiniteContains(bookmarksPages),
};

// -- userPageKeys.pagesDetail/Infinite & subpagesDetail/Infinite — UserPagesResponse: pages[] --
// (shares its `{ pages: Page[] }` shape with RecentlyViewedPagesResponse below — see `pagesArrayPages` / `patchPagesArrayResponse`.)
const userPagesDetailFamily: FamilyHandler = {
  matches: (key) => key[0] === 'user' && key[2] === 'pages' && key[3] !== 'infinite',
  patch: (data, pageId, computeNext) => patchPagesArrayResponse(data as UserPagesResponse, pageId, computeNext),
  contains: collectorFor((data) => pagesArrayPages(data as UserPagesResponse)),
};
const userPagesInfiniteFamily: FamilyHandler = {
  matches: (key) => key[0] === 'user' && key[2] === 'pages' && key[3] === 'infinite',
  patch: asInfinite(patchPagesArrayResponse<UserPagesResponse>),
  contains: asInfiniteContains(pagesArrayPages<UserPagesResponse>),
};
const userSubpagesDetailFamily: FamilyHandler = {
  matches: (key) => key[0] === 'user' && key[2] === 'subpages' && key[3] !== 'infinite',
  patch: (data, pageId, computeNext) => patchPagesArrayResponse(data as UserPagesResponse, pageId, computeNext),
  contains: collectorFor((data) => pagesArrayPages(data as UserPagesResponse)),
};
const userSubpagesInfiniteFamily: FamilyHandler = {
  matches: (key) => key[0] === 'user' && key[2] === 'subpages' && key[3] === 'infinite',
  patch: asInfinite(patchPagesArrayResponse<UserPagesResponse>),
  contains: asInfiniteContains(pagesArrayPages<UserPagesResponse>),
};

// -- searchKeys — SearchPagesResponse: data[].page --
function* searchPages(data: SearchPagesResponse): Iterable<Pick<Page, '_id'>> {
  for (const hit of data.data) yield hit.page;
}
const searchFamily: FamilyHandler = {
  matches: (key) => key[0] === 'search',
  patch: (data, pageId, computeNext) => {
    const d = data as SearchPagesResponse;
    let changed = false;
    const hits = d.data.map((hit) => {
      const next = patchPageIfMatch(hit.page, pageId, computeNext);
      if (next === hit.page) return hit;
      changed = true;
      return { ...hit, page: next };
    });
    if (!changed) return data;
    return { ...d, data: hits };
  },
  contains: collectorFor((data) => searchPages(data as SearchPagesResponse)),
};

// -- recentlyViewedKeys — RecentlyViewedPagesResponse: pages[] (same `{ pages: Page[] }` shape as UserPagesResponse above) --
const recentlyViewedFamily: FamilyHandler = {
  matches: (key) => key[0] === 'me' && key[1] === 'recently-viewed',
  patch: (data, pageId, computeNext) => patchPagesArrayResponse(data as RecentlyViewedPagesResponse, pageId, computeNext),
  contains: collectorFor((data) => pagesArrayPages(data as RecentlyViewedPagesResponse)),
};

/**
 * D-2 registry — extend this array (and add a `FamilyHandler` above) when a
 * new query-cache family starts holding Page objects.
 */
const FAMILIES: readonly FamilyHandler[] = [
  pageFamily,
  pageListFamily,
  userProfileFamily,
  userBookmarksDetailFamily,
  userBookmarksInfiniteFamily,
  userPagesDetailFamily,
  userPagesInfiniteFamily,
  userSubpagesDetailFamily,
  userSubpagesInfiniteFamily,
  searchFamily,
  recentlyViewedFamily,
];

function familyForQuery(query: Query): FamilyHandler | undefined {
  return FAMILIES.find((family) => family.matches(query.queryKey));
}

/**
 * Apply `computeNext` to every cached entry (across every family in the
 * registry) that embeds a Page matching `pageId`. Returns the touched
 * `[queryKey, previousData]` pairs so the caller can roll back on error.
 */
function patchCachedPages(queryClient: QueryClient, pageId: string, computeNext: ComputeNext): Array<[readonly unknown[], unknown]> {
  const snapshots: Array<[readonly unknown[], unknown]> = [];
  for (const query of queryClient.getQueryCache().getAll()) {
    const family = familyForQuery(query);
    if (!family) continue;
    const data = query.state.data;
    if (data === undefined) continue;
    const patched = family.patch(data, pageId, computeNext);
    if (patched === data) continue;
    snapshots.push([query.queryKey, data]);
    queryClient.setQueryData(query.queryKey, patched);
  }
  return snapshots;
}

/** Invalidate every cached family entry that currently embeds `pageId` (never a blanket "every list/search query"). */
function invalidateCachedPages(queryClient: QueryClient, pageId: string): void {
  queryClient.invalidateQueries({
    predicate: (query) => {
      const family = familyForQuery(query);
      if (!family) return false;
      const data = query.state.data;
      return data !== undefined && family.contains(data, pageId);
    },
  });
}

/**
 * Hook to toggle the current user's like on a specific page.
 *
 * "Is liked" lives on `page.isLiked` (feature-page-relations-collections
 * D-2) — never a `liker` id array, and never derived client-side. The
 * mutation:
 *   1. optimistically patches every cached Page-holding family (registry
 *      above) via `patchCachedPages`,
 *   2. on success, re-patches every family with the SERVER-returned
 *      `isLiked`/`likerCount` (reconciling with any concurrent toggle by
 *      another request that landed in between),
 *   3. on error, rolls every touched cache entry back to its snapshot,
 *   4. on settle, invalidates every family entry that still embeds this
 *      page (and the `likers` list) for eventual consistency.
 */
export function useToggleLike(pageId: string | undefined, isLiked: boolean) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      if (!pageId) {
        throw new Error('pageId is required');
      }

      const response = isLiked
        ? await apiClient.pages.unlike.$post({ json: { page_id: pageId } })
        : await apiClient.pages.like.$post({ json: { page_id: pageId } });

      if (response.status === 401) throw new Error('Authentication required');
      if (response.ok) {
        const data = await response.json();
        return { page: data.page };
      }
      throw new Error(isLiked ? 'Failed to unlike page' : 'Failed to like page');
    },
    onMutate: () => {
      if (!pageId) return { snapshots: [] };
      // `isLiked` is the state *before* the toggle, so the next state is `!isLiked`.
      const nextIsLiked = !isLiked;
      const snapshots = patchCachedPages(queryClient, pageId, (current) => ({
        isLiked: nextIsLiked,
        likerCount: Math.max(0, current.likerCount + (nextIsLiked ? 1 : -1)),
      }));
      return { snapshots };
    },
    onSuccess: (result) => {
      if (!pageId) return;
      const serverPage = result.page;
      patchCachedPages(queryClient, pageId, () => ({ isLiked: serverPage.isLiked, likerCount: serverPage.likerCount }));
    },
    onError: (_error, _vars, context) => {
      // Roll every touched cache entry back, then surface the failure.
      for (const [queryKey, previous] of context?.snapshots ?? []) {
        queryClient.setQueryData(queryKey, previous);
      }
      notify.error(isLiked ? m['page.unlike_failed']() : m['page.like_failed']());
    },
    onSettled: () => {
      if (!pageId) return;
      invalidateCachedPages(queryClient, pageId);
      queryClient.invalidateQueries({ queryKey: likersKeys.pagePrefix(pageId) });
    },
  });

  return {
    isLiked,
    toggle: mutation.mutate,
    toggleAsync: mutation.mutateAsync,
    isPending: mutation.isPending,
    isError: mutation.isError,
    error: mutation.error,
    reset: mutation.reset,
  };
}
