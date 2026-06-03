'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';

/**
 * Candidate source for the "create page" modal. Drives the Tab-cycle
 * completion: given the prefix the user has typed (a `/`-rooted path),
 * fetch existing pages whose path *starts with* that prefix
 * (`anchor: 'prefix'`), permission-filtered server-side via the shared
 * `/pages/autocomplete` endpoint.
 *
 * What the modal cycles through is **not** those existing pages — you
 * can't create a page that already exists, so cycling onto one is a dead
 * end. Instead it offers the *directory prefixes those pages occupy*:
 * the ancestor segments, each ending in `/`. Pages at
 * `/path/to/a` + `/path/to/b` (no portal at `/path/to`) yield the
 * completions `/path/` and `/path/to/` for the query `/pat` — namespaces
 * the user descends into and then types a fresh leaf under.
 *
 * The raw page paths are returned alongside (`existingPaths`) purely so
 * the caller can tell whether the path about to be submitted already
 * exists (e.g. a portal page sitting at a namespace root).
 */

// The endpoint hard-caps at 25; take the max so prefix derivation sees
// as many distinct namespaces as possible.
const CANDIDATE_LIMIT = 25;

export interface PagePathCandidates {
  /**
   * Directory prefixes (each ending in `/`) derived from existing pages'
   * ancestor segments, shallowest-first then lexicographic. These are the
   * Tab-cycle completions.
   */
  prefixes: string[];
  /** Raw existing page paths matching the query — for existence checks. */
  existingPaths: string[];
}

function pathDepth(path: string): number {
  return path.split('/').filter(Boolean).length;
}

/**
 * The ancestor directory prefixes of a page path, each ending in `/`,
 * excluding the page's own leaf and the root. `/path/to/a` →
 * `['/path/', '/path/to/']`.
 */
function ancestorPrefixes(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  const prefixes: string[] = [];
  let acc = '';
  // Stop before the last segment — that's the page leaf, not a namespace.
  for (let i = 0; i < segments.length - 1; i++) {
    acc += `/${segments[i]}`;
    prefixes.push(`${acc}/`);
  }
  return prefixes;
}

interface UsePagePathCandidatesOptions {
  /** When false, skip the request (e.g. modal closed / query too short). */
  enabled?: boolean;
}

/**
 * @param query The full `/`-rooted prefix the user has typed. Must be
 *   non-empty (the caller gates on `query.length > 1` so a bare `/`
 *   doesn't fan out a match against every page).
 */
export function usePagePathCandidates(
  query: string,
  options: UsePagePathCandidatesOptions = {},
): {
  data: PagePathCandidates | undefined;
  isFetching: boolean;
} {
  const result = useQuery({
    queryKey: ['page-path-candidates', query],
    enabled: (options.enabled ?? true) && query.length > 0,
    // Keep prior candidates visible while the next prefix loads so the
    // cycle list doesn't flicker empty between debounced keystrokes.
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    queryFn: async (): Promise<PagePathCandidates> => {
      const response = await apiClientV2.pages.autocomplete.$get({
        query: { q: query, anchor: 'prefix', limit: String(CANDIDATE_LIMIT) },
      });
      if (!response.ok) {
        throw new Error('Failed to fetch page path candidates');
      }
      const body = await response.json();
      const existingPaths = body.results.map((r) => r.label);

      // Collect the distinct ancestor namespaces that still start with
      // what the user typed (a page's shallower ancestors may not), then
      // present them shallowest-first so descending the tree is one Tab
      // per level.
      const prefixSet = new Set<string>();
      for (const path of existingPaths) {
        for (const prefix of ancestorPrefixes(path)) {
          if (prefix.startsWith(query) && prefix !== query) {
            prefixSet.add(prefix);
          }
        }
      }
      const prefixes = [...prefixSet].sort((a, b) => pathDepth(a) - pathDepth(b) || a.localeCompare(b));

      return { prefixes, existingPaths };
    },
  });

  return { data: result.data, isFetching: result.isFetching };
}
