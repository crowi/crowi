'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';
import type { Pager, Revision, RevisionMeta } from '@crowi/api-contract';

/**
 * RFC-0006 Phase 4 Batch 3 — switched from `apiClient.revision.*`
 * (ts-rest) to `apiClientV2.pages.*.$get` (hc<AppType>). Wire payload
 * is unchanged.
 */
export interface UsePageRevisionsResult {
  revisions: RevisionMeta[];
  pager: Pager | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

const revisionsKey = (pageId: string, params: { limit?: number; offset?: number }) =>
  ['revisions', { pageId, limit: params.limit ?? null, offset: params.offset ?? null }] as const;

/**
 * List revisions for a single page (meta only — no body).
 * Backed by GET /pages/:page_id/revisions.
 */
export function usePageRevisions(pageId: string | null | undefined, params: { limit?: number; offset?: number } = {}): UsePageRevisionsResult {
  const query = useQuery({
    queryKey: revisionsKey(pageId ?? '', params),
    queryFn: async () => {
      if (!pageId) {
        return { revisions: [] as RevisionMeta[], pager: null as Pager | null };
      }
      const response = await apiClientV2.pages[':page_id'].revisions.$get({
        param: { page_id: pageId },
        query: {
          limit: String(params.limit ?? 50),
          offset: String(params.offset ?? 0),
        },
      });
      if (!response.ok) throw new Error('Failed to fetch revisions');
      const body = await response.json();
      return { revisions: body.revisions, pager: body.pager };
    },
    enabled: Boolean(pageId),
  });

  return {
    revisions: query.data?.revisions ?? [],
    pager: query.data?.pager ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}

export interface UseRevisionPairResult {
  revisions: Revision[] | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

const revisionPairKey = (idA: string, idB: string) => ['revisions-pair', { idA, idB }] as const;

/**
 * Fetch two revisions in one batch call. When `idA` is null the call reduces
 * to a single-revision fetch — used by the history view for pages with only
 * one revision so the initial creation can be diffed against an empty body.
 * Order of returned revisions is not guaranteed; callers look them up by `_id`.
 * Backed by GET /pages/revisions?ids=a,b.
 */
export function useRevisionPair(idA: string | null | undefined, idB: string | null | undefined): UseRevisionPairResult {
  const enabled = Boolean(idB) && (idA == null || idA !== idB);
  const ids = idA && idB && idA !== idB ? `${idA},${idB}` : (idB ?? '');

  const query = useQuery({
    queryKey: revisionPairKey(idA ?? '', idB ?? ''),
    queryFn: async () => {
      if (!ids) return [] as Revision[];
      const response = await apiClientV2.pages.revisions.$get({ query: { ids } });
      if (!response.ok) throw new Error('Failed to fetch revisions');
      const body = await response.json();
      return body.revisions;
    },
    enabled,
  });

  return {
    revisions: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
