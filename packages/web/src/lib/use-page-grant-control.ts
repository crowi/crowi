'use client';

import { PageGrantEnum, type PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { PAGE_GRANT_MUTATION_KEY, useSetPageGrant } from './use-page-mutations';

type GrantAuthorityMode = 'legacy' | 'model' | null;
type GrantControlPage = Pick<PageWithRevision, '_id' | 'grant' | 'status' | 'redirectTo'>;

export interface UsePageGrantControlOptions {
  page: GrantControlPage | null;
  actorId: string | null;
  authorityMode: GrantAuthorityMode;
  /** The host's own reading of "may act on this page" (authenticated, not a read-only view such as an old revision). */
  enabled: boolean;
  /** `isFetching` / `isError` of the `usePage` query the host actually renders from — never another entry's state. */
  isPageRefreshing: boolean;
  isPageError: boolean;
}

export interface PageGrantController {
  currentGrant: number | null;
  disabled: boolean;
  isSaving: boolean;
  error: string | null;
  confirmation: { pageId: string; fromGrant: number; toGrant: number } | null;
  requestChange(nextGrant: number): Promise<void>;
  confirmChange(): Promise<void>;
  cancelConfirmation(): void;
}

const KNOWN_GRANTS: readonly number[] = [PageGrantEnum.PUBLIC, PageGrantEnum.RESTRICTED, PageGrantEnum.SPECIFIED, PageGrantEnum.OWNER];
const SENDABLE_GRANTS: readonly number[] = [PageGrantEnum.PUBLIC, PageGrantEnum.RESTRICTED, PageGrantEnum.OWNER];

type Candidate = { pageId: string; fromGrant: number; toGrant: number };

/**
 * Owns select / confirm / send / error for one page's visibility. Several
 * surfaces (header expanded + compact, editor drawer) share one controller per
 * host, so candidates and errors can never diverge between copies of the UI.
 *
 * Authority and the host's query state arrive as plain arguments: opening the
 * menu never waits on a refetch, and the server stays the final judge of a
 * write that a stale screen should not have made.
 */
export function usePageGrantControl({ page, actorId, authorityMode, enabled, isPageRefreshing, isPageError }: UsePageGrantControlOptions): PageGrantController {
  const queryClient = useQueryClient();
  const mutation = useSetPageGrant();
  const { mutateAsync } = mutation;

  const pageId = page?._id ? page._id : null;
  const currentGrant = page?.grant != null && KNOWN_GRANTS.includes(page.grant) ? page.grant : null;

  // Everything pending belongs to one (actor, page, authority, grant) view;
  // when any of them changes an unsent candidate or an old error must not
  // appear on the new view.
  const contextKey = `${actorId ?? ''}|${pageId ?? ''}|${authorityMode ?? ''}|${currentGrant ?? ''}`;
  const [seenContextKey, setSeenContextKey] = useState(contextKey);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (seenContextKey !== contextKey) {
    setSeenContextKey(contextKey);
    setCandidate(null);
    setError(null);
  }

  const identityRef = useRef(`${actorId ?? ''}|${pageId ?? ''}`);
  identityRef.current = `${actorId ?? ''}|${pageId ?? ''}`;
  const inflightRef = useRef(false);

  const pendingForPage = useIsMutating({
    mutationKey: PAGE_GRANT_MUTATION_KEY,
    predicate: (mutation) => pageId != null && (mutation.state.variables as { page_id?: string } | undefined)?.page_id === pageId,
  });
  const isSaving = pendingForPage > 0;

  const disabled =
    !enabled ||
    authorityMode !== 'legacy' ||
    actorId == null ||
    pageId == null ||
    currentGrant == null ||
    page?.status === 'deleted' ||
    Boolean(page?.redirectTo) ||
    isPageRefreshing ||
    isPageError ||
    isSaving;

  const submit = useCallback(
    async (targetPageId: string, grant: number) => {
      const alreadyPending =
        queryClient.isMutating({
          mutationKey: PAGE_GRANT_MUTATION_KEY,
          predicate: (pending) => (pending.state.variables as { page_id?: string } | undefined)?.page_id === targetPageId,
        }) > 0;
      if (inflightRef.current || alreadyPending) return;

      inflightRef.current = true;
      const sentFrom = identityRef.current;
      setError(null);
      try {
        await mutateAsync({ page_id: targetPageId, grant });
      } catch (err) {
        if (identityRef.current === sentFrom) {
          setError(err instanceof Error ? err.message : m['edit.grant_update_failed']());
        }
      } finally {
        inflightRef.current = false;
      }
    },
    [mutateAsync, queryClient],
  );

  const requestChange = useCallback(
    async (nextGrant: number) => {
      if (disabled || pageId == null || currentGrant == null) return;
      if (nextGrant === currentGrant || !SENDABLE_GRANTS.includes(nextGrant)) return;
      if (currentGrant === PageGrantEnum.SPECIFIED) {
        setError(null);
        setCandidate({ pageId, fromGrant: currentGrant, toGrant: nextGrant });
        return;
      }
      await submit(pageId, nextGrant);
    },
    [currentGrant, disabled, pageId, submit],
  );

  const confirmation = candidate != null && candidate.pageId === pageId && candidate.fromGrant === currentGrant ? candidate : null;

  const confirmChange = useCallback(async () => {
    if (confirmation == null || disabled) return;
    setCandidate(null);
    await submit(confirmation.pageId, confirmation.toGrant);
  }, [confirmation, disabled, submit]);

  const cancelConfirmation = useCallback(() => setCandidate(null), []);

  return { currentGrant, disabled, isSaving, error, confirmation, requestChange, confirmChange, cancelConfirmation };
}
