'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateAccessTokenRequest } from '@crowi/api-contract';
import { apiClient } from './api-client';

/**
 * RFC-0010 Phase 2 — Personal Access Token (PAT) hooks. Replaces the
 * legacy `useApiToken` / `useResetApiToken`. Talks to `/me/access-tokens`
 * via the Hono RPC client. The create response carries the one-time
 * plaintext `token`; everything else is metadata only.
 */
export const accessTokenKeys = {
  all: ['access-tokens'] as const,
};

export function useAccessTokens() {
  return useQuery({
    queryKey: accessTokenKeys.all,
    queryFn: async () => {
      const response = await apiClient.me['access-tokens'].$get();
      if (!response.ok) {
        throw new Error('Failed to fetch access tokens');
      }
      return response.json();
    },
  });
}

export function useCreateAccessToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateAccessTokenRequest) => {
      const response = await apiClient.me['access-tokens'].$post({ json: data });
      if (response.status === 201) {
        return response.json();
      }
      if (response.status === 400) {
        const body = (await response.json()) as { error?: { message?: string } };
        throw new Error(body.error?.message || 'Failed to create access token');
      }
      throw new Error('Failed to create access token');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: accessTokenKeys.all });
    },
  });
}

export function useDeleteAccessToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await apiClient.me['access-tokens'][':id'].$delete({ param: { id } });
      if (response.status === 200) {
        return response.json();
      }
      throw new Error('Failed to revoke access token');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: accessTokenKeys.all });
    },
  });
}
