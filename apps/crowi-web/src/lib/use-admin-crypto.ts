'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import type { CryptoStatusResponse, ReencryptResponse } from '@crowi/api-contract';
import { m } from '@/paraglide/messages.js';

export const adminCryptoKeys = {
  status: ['admin-crypto-status'] as const,
};

export function useCryptoStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: adminCryptoKeys.status,
    queryFn: async (): Promise<CryptoStatusResponse | null> => {
      const result = await apiClient.adminCrypto.getCryptoStatus();
      if (result.status === 200) return result.body;
      // 401/403: caller (admin layout) is responsible for gating; surface as null.
      return null;
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
      if (result.status === 200) return result.body;
      if (result.status === 503) {
        throw new Error(m['errors.encryption_key_not_set']());
      }
      if (result.status === 401 || result.status === 403) {
        throw new Error(m['errors.unauthorized']());
      }
      throw new Error(m['errors.reencrypt_failed']());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminCryptoKeys.status });
    },
  });
}
