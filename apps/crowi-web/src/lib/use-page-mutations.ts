'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { CreatePageRequest, UpdatePageRequest } from '@crowi/api-contract';

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
