'use client';

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { ListAdminUsersResponse } from '@crowi/api-contract';

/**
 * Query parameters accepted by `useAdminUsers`. Matches the wire shape of
 * GET /admin/users (q + page + limit) but everything is optional so the
 * caller only needs to spread URL search params.
 */
export interface UseAdminUsersParams {
  q?: string;
  page?: number;
  limit?: number;
}

export const adminUsersKeys = {
  all: ['admin', 'users'] as const,
  list: (params: UseAdminUsersParams) => [...adminUsersKeys.all, 'list', params.q ?? '', params.page ?? 1, params.limit ?? 50] as const,
};

/**
 * Fetch the paginated admin user list. Mirrors the patterns in
 * `useAdminSecuritySettings`:
 * - 401 / 403 are surfaced as Errors so the caller renders an alert instead
 *   of the loaded shape (the `(admin)` layout normally guards on user.admin
 *   so these only fire on backend regressions).
 * - `staleTime` is short — admin operators expect the list to reflect their
 *   recent changes (invitations from the legacy flow / status edits / etc.).
 * - `keepPreviousData` keeps the table populated while typing in the search
 *   box so the UI does not flash empty between requests.
 */
export function useAdminUsers(params: UseAdminUsersParams) {
  return useQuery({
    queryKey: adminUsersKeys.list(params),
    queryFn: async (): Promise<ListAdminUsersResponse> => {
      const result = await apiClient.admin.users.listUsers({
        query: {
          q: params.q,
          page: params.page,
          limit: params.limit,
        },
      });
      if (result.status === 200) {
        return result.body;
      }
      if (result.status === 401 || result.status === 403) {
        throw new Error(result.body.error.message);
      }
      throw new Error('Failed to fetch users');
    },
    placeholderData: keepPreviousData,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });
}
