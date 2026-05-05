'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { CreatePageRequest, UpdatePageRequest } from '@crowi/api-contract';

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

      if (result.status === 200) {
        return result.body.page;
      }
      if (result.status === 409) {
        throw new PageRevisionConflictError(result.body.error.message || '他の人が編集しました。ページを再読み込みしてください。');
      }
      if (result.status === 400) {
        throw new Error(result.body.error.message || 'Failed to update page');
      }
      if (result.status === 403) {
        throw new Error('このページを編集する権限がありません。');
      }
      if (result.status === 404) {
        throw new Error('ページが見つかりませんでした。');
      }
      throw new Error('Failed to update page');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['page'] });
    },
  });
}

export function useCreatePage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreatePageRequest) => {
      const result = await apiClient.page.createPage({ body: data });

      if (result.status === 200) {
        return result.body.page;
      }
      if (result.status === 400) {
        throw new Error(result.body.error.message || 'Failed to create page');
      }
      throw new Error('Failed to create page');
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

      if (result.status === 200) {
        return result.body.page;
      }
      if (result.status === 409) {
        throw new PageRevisionConflictError(result.body.error.message || '他の人が編集しました。ページを再読み込みしてください。');
      }
      if (result.status === 400) {
        throw new Error(result.body.error.message || 'Failed to delete page');
      }
      if (result.status === 403) {
        throw new Error('このページを削除する権限がありません。');
      }
      if (result.status === 404) {
        throw new Error('ページが見つかりませんでした。');
      }
      throw new Error('Failed to delete page');
    },
    onSuccess: () => {
      // Invalidate page queries so the trashed view (or 404) is reflected.
      queryClient.invalidateQueries({ queryKey: ['page'] });
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

      if (result.status === 200) {
        return result.body.page;
      }
      if (result.status === 400) {
        throw new Error(result.body.error.message || 'Failed to revert page');
      }
      if (result.status === 403) {
        throw new Error('このページを復元する権限がありません。');
      }
      if (result.status === 404) {
        throw new Error('ページが見つかりませんでした。');
      }
      throw new Error('Failed to revert page');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['page'] });
      queryClient.invalidateQueries({ queryKey: ['user'] });
    },
  });
}
