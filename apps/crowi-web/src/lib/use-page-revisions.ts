'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { Pager, Revision, RevisionMeta } from '@crowi/api-contract';

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
      const result = await apiClient.revision.listRevisions({
        params: { page_id: pageId },
        query: {
          limit: params.limit ?? 50,
          offset: params.offset ?? 0,
        },
      });
      if (result.status === 200) {
        return { revisions: result.body.revisions, pager: result.body.pager };
      }
      throw new Error('Failed to fetch revisions');
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
      const result = await apiClient.revision.getRevisions({
        query: { ids },
      });
      if (result.status === 200) {
        return result.body.revisions;
      }
      const message = result.status === 400 || result.status === 404 || result.status === 403 ? result.body.error.message : 'Failed to fetch revisions';
      throw new Error(message);
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
