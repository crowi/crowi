'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';
import type { DraftConflictOwner, DraftSummary, ListDraftsResponse } from '@crowi/api-contract';

/**
 * RFC-0004 — react-query bindings for the drafts API
 * (`/api/v2/pages/drafts`), consumed by the `/me/creating-pages` view.
 * Drafts are a single flat user-scoped collection, so the key factory
 * has just `all`.
 *
 * RFC-0006 Phase 4 Batch 6 — switched from `apiClient.draft.*` (ts-rest)
 * to `apiClientV2.pages.drafts.*.$method` (hc<AppType>). Wire payload is
 * unchanged; the only call-site difference is `response.ok` /
 * `response.json()` instead of ts-rest's `result.status` + `result.body`.
 */
export const draftsKeys = {
  all: ['drafts'] as const,
};

/**
 * Editor route for a draft, by page id. Mirrors the `_edit?page_id=`
 * form `UpdatePageEditor` resolves. Shared by `/me/creating-pages`
 * (the New page form + draft rows) and the `_edit?path=` create flow,
 * which `router.replace`s to this URL once its draft exists.
 */
export function draftEditHref(pageId: string): string {
  return `/_edit?page_id=${encodeURIComponent(pageId)}`;
}

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
      const response = await apiClientV2.pages.drafts.$get();
      if (response.status === 401) return EMPTY_DRAFTS;
      if (response.ok) {
        return (await response.json()) as ListDraftsResponse;
      }
      throw new Error('Failed to fetch drafts');
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
 */
export function useCreateDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { path: string; initialBody?: string }): Promise<{ pageId: string }> => {
      const response = await apiClientV2.pages.drafts.$post({ json: input });
      if (response.status === 201) {
        return (await response.json()) as { pageId: string };
      }
      if (response.status === 409) {
        const body = (await response.json()) as { message: string; owner: DraftConflictOwner };
        throw new DraftPathConflictError(body.message, body.owner);
      }
      if (response.status === 400) {
        const body = (await response.json()) as { message?: string };
        throw new Error(body.message ?? 'Failed to create draft');
      }
      throw new Error('Failed to create draft');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: draftsKeys.all });
      // A draft is visible to its author in the parent's child listing
      // (`findChildSegments` includes own drafts), so the sidebar tree
      // (`['pages','children',…]`) and any page list (`['pages','list',…]`)
      // must refresh too — both live under the `['pages']` family. Without
      // this, returning to an already-cached parent omits the just-created
      // page until its 60s staleTime lapses.
      queryClient.invalidateQueries({ queryKey: ['pages'] });
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
      const response = await apiClientV2.pages.drafts[':id'].$delete({ param: { id: pageId } });
      if (!response.ok) {
        throw new Error('Failed to cancel draft');
      }
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
