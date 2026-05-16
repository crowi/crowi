'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import { unwrapResult } from './unwrap-result';
import type { DraftConflictOwner, DraftSummary, ListDraftsResponse } from '@crowi/api-contract';

/**
 * RFC-0004 — react-query bindings for the drafts API
 * (`/api/v2/pages/drafts`), consumed by the `/me/creating-pages` view.
 * Drafts are a single flat user-scoped collection, so the key factory
 * has just `all`.
 */
export const draftsKeys = {
  all: ['drafts'] as const,
};

const EMPTY_DRAFTS: ListDraftsResponse = { drafts: [] };

/**
 * List the calling user's own drafts, newest first. A 401 collapses to
 * an empty list rather than throwing — the `(auth)` layout already
 * gates this route, so a 401 here only happens mid token-refresh and
 * should not surface an error card.
 */
export function useDrafts() {
  return useQuery({
    queryKey: draftsKeys.all,
    queryFn: async (): Promise<ListDraftsResponse> => {
      const result = await apiClient.draft.listDrafts();
      return unwrapResult(result, {
        ok: (body) => body,
        silent: { statuses: [401], value: EMPTY_DRAFTS },
        fallback: 'Failed to fetch drafts',
      });
    },
    // Drafts only change when the user creates / cancels / publishes
    // one — all of which invalidate this key explicitly. A short stale
    // time keeps "started N ago" labels fresh on revisit without a
    // network round-trip per focus.
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Thrown by {@link useCreateDraft} when the requested path is already
 * held by another user's draft (HTTP 409). Carries the `owner` identity
 * so the caller can render the contact-the-owner message without
 * re-parsing the wire body.
 */
export class DraftPathConflictError extends Error {
  readonly owner: DraftConflictOwner;
  constructor(message: string, owner: DraftConflictOwner) {
    super(message);
    this.name = 'DraftPathConflictError';
    this.owner = owner;
  }
}

/**
 * Create a new draft page at `path`. On success the caller navigates to
 * `/_edit?page_id=<pageId>`.
 *
 *   - 400 → plain `Error` (uncreatable path, or path held by a
 *     published page).
 *   - 409 → {@link DraftPathConflictError} with the owning user.
 *
 * Hand-rolled rather than via `unwrapResult`: success is 201 (not 200)
 * and the 409 must carry the `owner` object into a two-arg error, which
 * the helper's `ErrorClass` signature cannot express.
 */
export function useCreateDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { path: string; initialBody?: string }): Promise<{ pageId: string }> => {
      const result = await apiClient.draft.createDraft({ body: input });
      if (result.status === 201) return result.body;
      if (result.status === 409) {
        throw new DraftPathConflictError(result.body.message, result.body.owner);
      }
      if (result.status === 400) {
        throw new Error(result.body.message);
      }
      throw new Error('Failed to create draft');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: draftsKeys.all });
    },
  });
}

/**
 * Cancel (delete) a draft. Only the author may cancel; the server
 * collapses "no such draft" and "not yours" into one 404.
 */
export function useCancelDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (pageId: string): Promise<void> => {
      // ts-rest's typed client requires `body` in the call args even
      // when the contract's body schema is `z.unknown().optional()`.
      const result = await apiClient.draft.cancelDraft({ params: { id: pageId }, body: undefined });
      unwrapResult(result, {
        ok: () => undefined,
        errors: { 404: 'Failed to cancel draft' },
        fallback: 'Failed to cancel draft',
      });
    },
    // Optimistically drop the row so the list updates instantly, then
    // invalidate to reconcile with the server.
    onMutate: async (pageId: string) => {
      await queryClient.cancelQueries({ queryKey: draftsKeys.all });
      const previous = queryClient.getQueryData<ListDraftsResponse>(draftsKeys.all);
      if (previous) {
        queryClient.setQueryData<ListDraftsResponse>(draftsKeys.all, {
          drafts: previous.drafts.filter((d: DraftSummary) => d.pageId !== pageId),
        });
      }
      return { previous };
    },
    onError: (_err, _pageId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(draftsKeys.all, context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: draftsKeys.all });
    },
  });
}
