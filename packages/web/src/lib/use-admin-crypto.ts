'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';
import type { CryptoStatusResponse, ReencryptResponse } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

export const adminCryptoKeys = {
  status: ['admin-crypto-status'] as const,
};

/**
 * RFC-0006 Phase 4 Batch 8 — switched from `apiClient.adminCrypto.*`
 * (ts-rest) to `apiClientV2.admin.crypto.*.$method` (`createClient`). Wire
 * payload unchanged. Non-200 responses (401 / 403 from regressions —
 * the admin layout is responsible for gating) collapse to `null` so
 * the card hides itself instead of throwing.
 */
export function useCryptoStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: adminCryptoKeys.status,
    queryFn: async (): Promise<CryptoStatusResponse | null> => {
      const response = await apiClientV2.admin.crypto.status.$get();
      if (response.status !== 200) {
        return null;
      }
      return (await response.json()) as CryptoStatusResponse;
    },
    enabled: options?.enabled !== false,
    // The status only changes when an admin saves a new value or runs the
    // re-encrypt mutation; both invalidate this key explicitly.
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

export function useReencryptSensitive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<ReencryptResponse> => {
      const response = await apiClientV2.admin.crypto.reencrypt.$post({
        // Body is empty in practice; the contract declares it as
        // `z.unknown()` so an empty object satisfies validation.
        json: {},
      });
      if (response.status === 503) {
        throw new Error(m['errors.encryption_key_not_set']());
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(m['errors.unauthorized']());
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? m['errors.reencrypt_failed']());
      }
      return (await response.json()) as ReencryptResponse;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminCryptoKeys.status });
    },
  });
}
