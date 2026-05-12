'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import { unwrapResult } from './unwrap-result';
import type { CryptoStatusResponse, ReencryptResponse } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

export const adminCryptoKeys = {
  status: ['admin-crypto-status'] as const,
};

export function useCryptoStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: adminCryptoKeys.status,
    queryFn: async (): Promise<CryptoStatusResponse | null> => {
      const result = await apiClient.adminCrypto.getCryptoStatus();
      // Any non-200 (401/403 from backend regressions; the admin layout is
      // responsible for gating) collapses to null so the card hides itself.
      return result.status === 200 ? result.body : null;
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
      const result = await apiClient.adminCrypto.reencryptAll({ body: {} });
      return unwrapResult(result, {
        ok: (body) => body,
        errors: {
          503: { message: m['errors.encryption_key_not_set'](), preferLocal: true },
          401: { message: m['errors.unauthorized'](), preferLocal: true },
          403: { message: m['errors.unauthorized'](), preferLocal: true },
        },
        fallback: m['errors.reencrypt_failed'](),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminCryptoKeys.status });
    },
  });
}
