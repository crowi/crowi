'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from './api-client';

/**
 * Member directory list hook — fetches active users (avatar + name +
 * @username) for the special `/user/` portal. Backed by `GET /users`
 * (authenticated, non-admin). `q` matches username/name; pagination is
 * offset-based, name-ascending.
 */
export interface UseUserListParams {
  q?: string;
  limit?: number;
  offset?: number;
}

export const userListKeys = {
  all: ['users', 'directory'] as const,
  list: (params: UseUserListParams) => [...userListKeys.all, params] as const,
};

export function useUserList(params: UseUserListParams = {}) {
  const { q = '', limit, offset } = params;

  return useQuery({
    queryKey: userListKeys.list({ q, limit, offset }),
    queryFn: async () => {
      const response = await apiClient.users.$get({
        query: {
          ...(q ? { q } : {}),
          // Omit when unset so the contract's server-side defaults apply
          // (avoids a second copy of the default page size on the client).
          ...(limit !== undefined ? { limit: String(limit) } : {}),
          ...(offset !== undefined ? { offset: String(offset) } : {}),
        },
      });
      if (!response.ok) {
        throw new Error('Failed to load members');
      }
      return response.json();
    },
    // Keep the previous page visible while the next page / search loads,
    // so the grid doesn't flash empty between requests.
    placeholderData: (prev) => prev,
  });
}
