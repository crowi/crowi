'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import { unwrapResult } from './unwrap-result';
import type { RenamePageRequest, UpdatePageRequest } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

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
    mutationFn: async (data: UpdatePageRequest) => {
      const result = await apiClient.page.updatePage({ body: data });
      return unwrapResult(result, {
        ok: (body) => body.page,
        errors: {
          409: { message: m['errors.revision_conflict_edit'](), ErrorClass: PageRevisionConflictError },
          400: m['errors.update_failed'](),
          403: { message: m['errors.permission_denied_edit'](), preferLocal: true },
          404: { message: m['errors.page_not_found'](), preferLocal: true },
        },
        fallback: m['errors.update_failed'](),
      });
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
    mutationFn: async (data: DeletePageRequest) => {
      const result = await apiClient.page.deletePage({ body: data });
      return unwrapResult(result, {
        ok: (body) => body.page,
        errors: {
          409: { message: m['errors.revision_conflict_edit'](), ErrorClass: PageRevisionConflictError },
          400: m['errors.delete_failed'](),
          403: { message: m['errors.permission_denied_delete'](), preferLocal: true },
          404: { message: m['errors.page_not_found'](), preferLocal: true },
        },
        fallback: m['errors.delete_failed'](),
      });
    },
    onSuccess: () => {
      // Invalidate page queries so the trashed view (or 404) is reflected.
      queryClient.invalidateQueries({ queryKey: ['page'] });
      // The /trash listing must drop the just-(soft|hard)-deleted row.
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      // /user/:username/pages may surface deleted pages — refresh those too.
      queryClient.invalidateQueries({ queryKey: ['user'] });
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
    mutationFn: async (data: RevertDeletedPageRequest) => {
      const result = await apiClient.page.revertDeletedPage({ body: data });
      return unwrapResult(result, {
        ok: (body) => body.page,
        errors: {
          400: m['errors.revert_failed'](),
          403: { message: m['errors.permission_denied_revert'](), preferLocal: true },
          404: { message: m['errors.page_not_found'](), preferLocal: true },
        },
        fallback: m['errors.revert_failed'](),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['page'] });
      // The /trash listing must drop the just-restored row.
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['user'] });
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
    mutationFn: async (data: RenamePageRequest) => {
      const result = await apiClient.page.renamePage({ body: data });
      return unwrapResult(result, {
        ok: (body) => body.page,
        errors: {
          409: { message: m['errors.revision_conflict_update'](), ErrorClass: PageRevisionConflictError },
          400: m['errors.rename_failed'](),
          403: { message: m['errors.permission_denied_rename'](), preferLocal: true },
          404: { message: m['errors.page_not_found'](), preferLocal: true },
        },
        fallback: m['errors.rename_failed'](),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['page'] });
    },
  });
}
