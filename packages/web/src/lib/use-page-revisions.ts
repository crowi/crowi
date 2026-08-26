'use client';

import type { Revision } from '@crowi/api-contract';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiClient } from './api-client';

export interface UseRevisionPairResult {
  revisions: Revision[] | null;
  displayedFromId: string | null;
  displayedToId: string | null;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

const revisionPairKey = (idA: string, idB: string) => ['revisions-pair', { idA, idB }] as const;

interface RevisionPairData {
  revisions: Revision[];
  fromId: string | null;
  toId: string;
}

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
      if (!ids) return { revisions: [], fromId: idA ?? null, toId: idB ?? '' } satisfies RevisionPairData;
      const response = await apiClient.pages.revisions.$get({ query: { ids } });
      if (!response.ok) throw new Error('Failed to fetch revisions');
      const body = await response.json();
      return { revisions: body.revisions, fromId: idA ?? null, toId: idB ?? '' } satisfies RevisionPairData;
    },
    enabled,
    // Radio changes should not collapse the diff panel while its replacement loads.
    placeholderData: keepPreviousData,
  });

  return {
    revisions: query.data?.revisions ?? null,
    displayedFromId: query.data?.fromId ?? null,
    displayedToId: query.data?.toId ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
