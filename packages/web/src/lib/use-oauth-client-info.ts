'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';

/**
 * RFC-0016 §4.4 — `GET /oauth/client-info` lookup for the authorize page.
 * The response tells the consent screen whether the requesting client is
 * `trusted` (skip `ConsentCard`, auto-approve) and supplies its display
 * `name`. An unknown `client_id` (404) resolves to `null` rather than an
 * error — the authorize page then falls back to the non-trusted consent
 * flow, and the subsequent `POST /oauth/authorize` surfaces the real
 * `invalid_client` failure if the user tries to approve.
 */
export const oauthClientInfoKeys = {
  all: ['oauth', 'client-info'] as const,
  detail: (clientId: string) => [...oauthClientInfoKeys.all, clientId] as const,
};

export function useOAuthClientInfo(clientId: string) {
  return useQuery({
    queryKey: oauthClientInfoKeys.detail(clientId),
    queryFn: async () => {
      const response = await apiClientV2.oauth['client-info'].$get({ query: { client_id: clientId } });
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error('Failed to fetch OAuth client info');
      }
      return response.json();
    },
    enabled: clientId !== '',
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
