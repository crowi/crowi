'use client';

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ClearRenderCacheResponse,
  ListPluginsResponse,
  PluginConfigResponse,
  UpdatePluginConfigRequest,
  UpdatePluginConfigResponse,
} from '@crowi/api-contract';
import { getLocale } from '@paraglide/runtime.js';
import { apiClientV2 } from './api-client';

export const adminPluginsKeys = {
  all: ['admin', 'plugins'] as const,
  list: () => ['admin', 'plugins', 'list'] as const,
  // Locale is part of the key so switching language refetches the localized
  // field labels/descriptions (plugin `configI18n` overlay).
  config: (name: string, locale: string) => ['admin', 'plugins', name, 'config', locale] as const,
};

const readWireMessage = async (response: Response): Promise<string | undefined> => {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } } | null;
    const msg = body?.error?.message;
    return typeof msg === 'string' ? msg : undefined;
  } catch {
    return undefined;
  }
};

const throwGenericError = async (response: Response, fallback: string, notFoundMessage?: string): Promise<never> => {
  const wire = await readWireMessage(response);
  if (response.status === 401 || response.status === 403) {
    throw new Error(wire ?? fallback);
  }
  if (response.status === 404) {
    throw new Error(wire ?? notFoundMessage ?? fallback);
  }
  throw new Error(wire ?? fallback);
};

/**
 * RFC-0006 Phase 4 Batch 9 — switched from `apiClient.admin.plugins.*`
 * (ts-rest) to `apiClientV2.admin.plugins.*.$method` (hc<AppType>).
 * Wire payload byte-identical; 422 still surfaces
 * `PluginConfigValidationError`.
 */
export function useAdminPlugins() {
  return useQuery<ListPluginsResponse, Error>({
    queryKey: adminPluginsKeys.list(),
    queryFn: async () => {
      const response = await apiClientV2.admin.plugins.$get();
      if (response.status === 200) return (await response.json()) as ListPluginsResponse;
      return throwGenericError(response, 'Failed to fetch plugins');
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

async function fetchPluginConfig(name: string, locale: string): Promise<PluginConfigResponse> {
  const response = await apiClientV2.admin.plugins.config.$get({ query: { name, locale } });
  if (response.status === 200) return (await response.json()) as PluginConfigResponse;
  return throwGenericError(response, 'Failed to fetch plugin config', 'Plugin not found');
}

export function useAdminPluginConfig(name: string | null) {
  const locale = getLocale();
  return useQuery<PluginConfigResponse, Error>({
    queryKey: name ? adminPluginsKeys.config(name, locale) : adminPluginsKeys.all,
    queryFn: () => {
      if (!name) throw new Error('plugin name is required');
      return fetchPluginConfig(name, locale);
    },
    enabled: !!name,
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

// useQueries (rather than N useQuery calls) because `names.length` varies
// per plugin's `requires` array.
export function useAdminPluginConfigs(names: string[]) {
  const locale = getLocale();
  return useQueries({
    queries: names.map((name) => ({
      queryKey: adminPluginsKeys.config(name, locale),
      queryFn: () => fetchPluginConfig(name, locale),
      staleTime: 60 * 1000,
      refetchOnWindowFocus: false,
    })),
  });
}

/**
 * Custom error subclass for the validation case so the form can pull
 * out per-field issue messages (rather than a generic Error string).
 */
export class PluginConfigValidationError extends Error {
  readonly issues: { path: (string | number)[]; message: string }[];
  constructor(message: string, issues: { path: (string | number)[]; message: string }[]) {
    super(message);
    this.name = 'PluginConfigValidationError';
    this.issues = issues;
  }
}

interface PluginConfigValidationBody {
  error?: {
    message?: string;
    issues?: { path: (string | number)[]; message: string }[];
  };
}

export function useUpdateAdminPluginConfig(name: string) {
  const queryClient = useQueryClient();
  return useMutation<UpdatePluginConfigResponse, Error, UpdatePluginConfigRequest>({
    mutationFn: async (data) => {
      const response = await apiClientV2.admin.plugins.config.$put({ query: { name }, json: data });
      if (response.status === 200) return (await response.json()) as UpdatePluginConfigResponse;
      if (response.status === 422) {
        const body = (await response.json().catch(() => null)) as PluginConfigValidationBody | null;
        throw new PluginConfigValidationError(body?.error?.message ?? 'Plugin config failed validation', body?.error?.issues ?? []);
      }
      return throwGenericError(response, 'Failed to update plugin config', 'Plugin not found');
    },
    onSuccess: () => {
      // Prefix match (no locale) so every cached locale variant is refreshed.
      queryClient.invalidateQueries({ queryKey: ['admin', 'plugins', name, 'config'] });
      queryClient.invalidateQueries({ queryKey: adminPluginsKeys.list() });
    },
  });
}

/**
 * Trigger the "Clear all render cache" admin endpoint.
 */
export function useClearRenderCacheAll() {
  return useMutation<ClearRenderCacheResponse, Error, void>({
    mutationFn: async () => {
      const response = await apiClientV2.admin.plugins['render-cache']['clear-all'].$post({ json: {} });
      if (response.status === 200) return (await response.json()) as ClearRenderCacheResponse;
      return throwGenericError(response, 'Failed to clear cache');
    },
  });
}

/**
 * Trigger the "Clear cache for this plugin" admin endpoint.
 */
export function useClearRenderCachePlugin() {
  return useMutation<ClearRenderCacheResponse, Error, { name: string }>({
    mutationFn: async ({ name }) => {
      const response = await apiClientV2.admin.plugins['render-cache']['clear-plugin'].$post({ query: { name }, json: {} });
      if (response.status === 200) return (await response.json()) as ClearRenderCacheResponse;
      return throwGenericError(response, 'Failed to clear cache', 'Plugin not loaded');
    },
  });
}
