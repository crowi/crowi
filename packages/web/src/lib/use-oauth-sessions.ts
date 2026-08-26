'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';

/**
 * OAuth session (refresh-token rotation-chain tip) list/revoke hooks. Talks to `/me/oauth-sessions` via the Hono RPC client, mirroring `use-access-tokens.ts`'s shape.
 *
 * DELETE settling is never used as the display source of truth: a 200 body, a 404 (already gone — the tip rotated or was TTL-swept), and a failure (500 / network / timeout) are ALL followed by an `oauthSessionKeys.all` invalidation in `onSettled`, and the section component renders only from the resulting refetch. The browser cannot tell a lost response from a failed commit, so a stale row is never kept alive from local mutation state either way.
 */
export const oauthSessionKeys = {
  all: ['oauth-sessions'] as const,
};

export function useOAuthSessions() {
  return useQuery({
    queryKey: oauthSessionKeys.all,
    queryFn: async () => {
      const response = await apiClient.me['oauth-sessions'].$get();
      if (!response.ok) {
        throw new Error('Failed to fetch OAuth sessions');
      }
      return response.json();
    },
  });
}

export function useDeleteOAuthSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await apiClient.me['oauth-sessions'][':id'].$delete({ param: { id } });
      if (response.status === 200) {
        return response.json();
      }
      // Already gone (rotated away / TTL-swept before this request landed, or a race with another tab's DELETE) — not an error the user needs to see; the list refetch below converges to the current state.
      if (response.status === 404) {
        return null;
      }
      throw new Error('Failed to revoke OAuth session');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: oauthSessionKeys.all });
    },
  });
}
