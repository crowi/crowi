'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';
import type { PageWithRevision, RenamePageRequest, SetPageGrantRequest, UpdatePageRequest } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

/**
 * RFC-0006 Phase 4 Batch 4 — switched from `apiClient.page.*` (ts-rest)
 * to `apiClientV2.pages.*.$method` (hc<AppType>). The legacy
 * `unwrapResult` helper is replaced with explicit `response.ok` /
 * `response.status` checks because hc returns a plain `Response`-shaped
 * object rather than ts-rest's `{ status, body }` discriminated union.
 *
 * Error messages mirror the legacy `unwrapResult` behaviour: a
 * resource-specific m['errors.*']() string for actionable cases and
 * a fallback for everything else. `PageRevisionConflictError` is still
 * thrown explicitly on 409 so callers can match on it.
 */

interface DeletePageRequest {
  page_id: string;
  revision_id?: string;
  completely?: boolean;
}

interface RevertDeletedPageRequest {
  page_id: string;
}

/**
 * Error thrown when a page update fails because the revision_id is stale
 * (someone else updated the page in the meantime).
 */
export class PageRevisionConflictError extends Error {
  readonly code = 'PAGE_REVISION_ERROR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PageRevisionConflictError';
  }
}

export function useUpdatePage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: UpdatePageRequest): Promise<PageWithRevision> => {
      const response = await apiClientV2.pages.$put({ json: data });
      if (response.ok) {
        const body = await response.json();
        return body.page as PageWithRevision;
      }
      if (response.status === 409) {
        throw new PageRevisionConflictError(m['errors.revision_conflict_edit']());
      }
      if (response.status === 404) {
        // 404 covers both "page not found" and grant-denied (existence-leak
        // guard in the handler collapses both to 404).
        throw new Error(m['errors.page_not_found']());
      }
      throw new Error(m['errors.update_failed']());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['page'] });
    },
  });
}

/**
 * Update only a page's grant (visibility). Unlike `useUpdatePage` this
 * does not push a new revision — it powers the editor's visibility
 * selector, where a grant change must not land in the page history.
 */
export function useSetPageGrant() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: SetPageGrantRequest): Promise<PageWithRevision> => {
      const response = await apiClientV2.pages.grant.$put({ json: data });
      if (response.ok) {
        const body = await response.json();
        return body.page as PageWithRevision;
      }
      if (response.status === 404) {
        throw new Error(m['errors.page_not_found']());
      }
      throw new Error(m['edit.grant_update_failed']());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['page'] });
    },
  });
}

/**
 * Soft-delete (or fully delete with completely=true) a page.
 * On success the returned page reflects the post-delete state:
 *  - soft delete: path is /trash/<original>, status === 'deleted'
 *  - completely=true: the page is gone from the DB; the body still echoes the
 *    original page object for client-side feedback, but a refetch will 404.
 */
export function useDeletePage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: DeletePageRequest): Promise<PageWithRevision> => {
      const response = await apiClientV2.pages.$delete({ json: data });
      if (response.ok) {
        const body = await response.json();
        return body.page as PageWithRevision;
      }
      if (response.status === 409) {
        throw new PageRevisionConflictError(m['errors.revision_conflict_edit']());
      }
      if (response.status === 404) {
        // 404 covers grant-denied as well (existence-leak guard).
        throw new Error(m['errors.page_not_found']());
      }
      throw new Error(m['errors.delete_failed']());
    },
    onSuccess: () => {
      // Invalidate page queries so the trashed view (or 404) is reflected.
      queryClient.invalidateQueries({ queryKey: ['page'] });
      // The /trash listing must drop the just-(soft|hard)-deleted row.
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      // /user/:username/pages may surface deleted pages — refresh only the
      // user/<username>/pages keys, not every cache under `['user']`.
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === 'user' && query.queryKey[2] === 'pages',
      });
    },
  });
}

/**
 * Revert a soft-deleted page (the one currently sitting under /trash/...).
 * The page document's path/status are restored and the redirect stub at the
 * original path is removed.
 */
export function useRevertDeletedPage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: RevertDeletedPageRequest): Promise<PageWithRevision> => {
      const response = await apiClientV2.pages.revert.$post({ json: data });
      if (response.ok) {
        const body = await response.json();
        return body.page as PageWithRevision;
      }
      if (response.status === 404) {
        // 404 covers grant-denied as well (existence-leak guard).
        throw new Error(m['errors.page_not_found']());
      }
      throw new Error(m['errors.revert_failed']());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['page'] });
      // The /trash listing must drop the just-restored row.
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === 'user' && query.queryKey[2] === 'pages',
      });
    },
  });
}

/**
 * Rename (move) a page to a new path. May also unlink an existing redirect
 * page sitting at the new path on the server side.
 */
export function useRenamePage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: RenamePageRequest): Promise<PageWithRevision> => {
      const response = await apiClientV2.pages.rename.$post({ json: data });
      if (response.ok) {
        const body = await response.json();
        return body.page as PageWithRevision;
      }
      if (response.status === 409) {
        throw new PageRevisionConflictError(m['errors.revision_conflict_update']());
      }
      if (response.status === 404) {
        // 404 covers grant-denied as well (existence-leak guard).
        throw new Error(m['errors.page_not_found']());
      }
      throw new Error(m['errors.rename_failed']());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['page'] });
    },
  });
}
