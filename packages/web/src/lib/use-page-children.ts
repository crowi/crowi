'use client';

import type { ListPageChildrenResponse } from '@crowi/api-contract';
import { useQueries, useQuery } from '@tanstack/react-query';
import { apiClient } from './api-client';
import { pageChildrenKeys } from './page-query-keys';

/**
 * Sidebar hierarchy data. The sidebar tree fetches the children of every
 * ancestor directory along the current path in parallel and stitches
 * them into the expanded tree (see `pageSidebarLayout`).
 *
 * The server returns the *complete* first-level segment set (unpaginated),
 * so the sidebar never drops a directory the way a `/pages/list` slice
 * would.
 *
 * `pageChildrenKeys` lives in `page-query-keys.ts` (this file's only prior
 * import source, besides itself).
 */

async function fetchPageChildren(path: string, depth: number): Promise<ListPageChildrenResponse> {
  // `depth: 1` is the server default; sending it explicitly keeps the request
  // shape uniform without changing what comes back.
  const response = await apiClient.pages.children.$get({ query: { path, depth: String(depth) } });
  if (!response.ok) {
    throw new Error('Failed to fetch page children');
  }
  return await response.json();
}

/**
 * Fetch children for several ancestor directory paths at once. Returns
 * the array of query results positionally aligned with `paths`. Each
 * (path, depth) pair keys its own cache entry, so sibling pages that share
 * ancestors reuse the same fetched levels.
 *
 * `depths` is positionally aligned with `paths` and defaults to 1 per
 * level. The sidebar passes 2 for a `YYYY/MM/` level so one request brings
 * back every day of the month WITH the pages inside it (see
 * `dateMonthPath`); the level below it is still fetched at depth 1, which
 * is what keeps the active branch's rendering unchanged.
 */
export function usePageChildrenLevels(paths: string[], depths: number[] = [], options: { enabled?: boolean } = {}) {
  return useQueries({
    queries: paths.map((path, index) => {
      const depth = depths[index] ?? 1;
      return {
        queryKey: pageChildrenKeys.detail(path, depth),
        enabled: options.enabled ?? true,
        queryFn: () => fetchPageChildren(path, depth),
      };
    }),
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
    queryFn: () => fetchPageChildren(path, 1),
  });
}
