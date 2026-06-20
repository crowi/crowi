'use client';

import type { ListPageChildrenResponse } from '@crowi/api-contract';
import { useQueries, useQuery } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';

/**
 * Sidebar hierarchy data. The sidebar tree fetches the children of every
 * ancestor directory along the current path in parallel and stitches
 * them into the expanded tree (see `pageSidebarLayout`).
 *
 * The server returns the *complete* first-level segment set (unpaginated),
 * so the sidebar never drops a directory the way a `/pages/list` slice
 * would.
 */

export const pageChildrenKeys = {
  all: ['pages', 'children'] as const,
  detail: (path: string) => ['pages', 'children', path] as const,
};

async function fetchPageChildren(path: string): Promise<ListPageChildrenResponse> {
  const response = await apiClientV2.pages.children.$get({ query: { path } });
  if (!response.ok) {
    throw new Error('Failed to fetch page children');
  }
  return await response.json();
}

/**
 * Fetch children for several ancestor directory paths at once. Returns
 * the array of query results positionally aligned with `paths`. Each
 * path keys its own cache entry, so sibling pages that share ancestors
 * reuse the same fetched levels.
 */
export function usePageChildrenLevels(paths: string[], options: { enabled?: boolean } = {}) {
  return useQueries({
    queries: paths.map((path) => ({
      queryKey: pageChildrenKeys.detail(path),
      enabled: options.enabled ?? true,
      queryFn: () => fetchPageChildren(path),
    })),
  });
}

/**
 * Children of a single portal path. Shares its cache key with the sidebar's
 * `usePageChildrenLevels`, so a content-page view asking "do I have
 * descendants?" reuses the (already in-flight) sidebar fetch for the same
 * path rather than issuing a second request.
 */
export function usePageChildren(path: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: pageChildrenKeys.detail(path),
    enabled: options.enabled ?? true,
    queryFn: () => fetchPageChildren(path),
  });
}
