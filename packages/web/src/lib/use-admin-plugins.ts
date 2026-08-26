'use client';

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ClearRenderCacheResponse,
  ConfigReadinessResponse,
  ListPluginsResponse,
  PluginConfigResponse,
  UpdatePluginConfigRequest,
  UpdatePluginConfigResponse,
} from '@crowi/api-contract';
import { getLocale } from '@paraglide/runtime.js';
import { apiClient } from './api-client';

export const adminPluginsKeys = {
  all: ['admin', 'plugins'] as const,
  list: () => ['admin', 'plugins', 'list'] as const,
  // Locale is part of the key so switching language refetches the localized
  // field labels/descriptions (plugin `configI18n` overlay).
  config: (name: string, locale: string) => ['admin', 'plugins', name, 'config', locale] as const,
  // feature-plugin-config-readiness — not locale-scoped (readiness never
  // renders localized text, only field/plugin names).
  readiness: () => ['admin', 'plugins', 'readiness'] as const,
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
 * (ts-rest) to `apiClient.admin.plugins.*.$method` (`createClient`).
 * Wire payload byte-identical; 422 still surfaces
 * `PluginConfigValidationError`.
 */
export function useAdminPlugins() {
  return useQuery<ListPluginsResponse, Error>({
    queryKey: adminPluginsKeys.list(),
    queryFn: async () => {
      const response = await apiClient.admin.plugins.$get();
      if (response.status === 200) return (await response.json()) as ListPluginsResponse;
      return throwGenericError(response, 'Failed to fetch plugins');
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

/**
 * feature-plugin-config-readiness / feature-core-config-readiness-and-mail
 * — active plugins missing config their own `readiness` declaration says
 * is required, PLUS core config declarations (e.g. `mail:from`) that are
 * unset. `enabled` gates the request: callers pass `user.admin === true`
 * so the query (and thus the HTTP request) never fires for a non-admin or
 * before auth resolves — see `PluginReadinessBanner`.
 */
export function useAdminPluginReadiness(enabled: boolean) {
  return useQuery<ConfigReadinessResponse, Error>({
    queryKey: adminPluginsKeys.readiness(),
    queryFn: async () => {
      const response = await apiClient.admin.plugins.readiness.$get();
      if (response.status === 200) return (await response.json()) as ConfigReadinessResponse;
      return throwGenericError(response, 'Failed to fetch plugin readiness');
    },
    enabled,
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

async function fetchPluginConfig(name: string, locale: string): Promise<PluginConfigResponse> {
  const response = await apiClient.admin.plugins.config.$get({ query: { name, locale } });
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

/**
 * Thrown on a 409 `LINKED_IDENTITIES_EXIST` instead of routing through
 * `throwGenericError`, which would collapse the `count` the confirmation
 * dialog needs down to a plain string message (mirrors
 * `PluginConfigValidationError`'s handling of 422 `issues` for the same
 * reason).
 */
export class LinkedIdentitiesExistError extends Error {
  readonly count: number;
  constructor(message: string, count: number) {
    super(message);
    this.name = 'LinkedIdentitiesExistError';
    this.count = count;
  }
}

interface LinkedIdentitiesExistBody {
  error?: {
    message?: string;
    count?: number;
  };
}

export function useUpdateAdminPluginConfig(name: string) {
  const queryClient = useQueryClient();
  return useMutation<UpdatePluginConfigResponse, Error, UpdatePluginConfigRequest>({
    mutationFn: async (data) => {
      const response = await apiClient.admin.plugins.config.$put({ query: { name }, json: data });
      if (response.status === 200) {
        const body = (await response.json()) as UpdatePluginConfigResponse;
        // feature-plugin-config-live-verification — the wire field is
        // optional (an older api replica mid-rolling-deploy never sends
        // it at all); normalize here at the JSON boundary so every caller
        // downstream can treat `verificationResults` as always present.
        return { ...body, verificationResults: body.verificationResults ?? [] };
      }
      if (response.status === 422) {
        const body = (await response.json().catch(() => null)) as PluginConfigValidationBody | null;
        throw new PluginConfigValidationError(body?.error?.message ?? 'Plugin config failed validation', body?.error?.issues ?? []);
      }
      if (response.status === 409) {
        const body = (await response.json().catch(() => null)) as LinkedIdentitiesExistBody | null;
        throw new LinkedIdentitiesExistError(body?.error?.message ?? 'Users are linked through this provider', body?.error?.count ?? 0);
      }
      return throwGenericError(response, 'Failed to update plugin config', 'Plugin not found');
    },
    onSuccess: () => {
      // Prefix match (no locale) so every cached locale variant is refreshed.
      queryClient.invalidateQueries({ queryKey: ['admin', 'plugins', name, 'config'] });
      queryClient.invalidateQueries({ queryKey: adminPluginsKeys.list() });
      // feature-plugin-config-readiness — a save may have just resolved
      // (or introduced) a readiness issue for this plugin; refetch so
      // the banner/list/edit-page readiness UI reflects the new value
      // immediately rather than the pre-save snapshot.
      queryClient.invalidateQueries({ queryKey: adminPluginsKeys.readiness() });
    },
  });
}

/**
 * Trigger the "Clear all render cache" admin endpoint.
 */
export function useClearRenderCacheAll() {
  return useMutation<ClearRenderCacheResponse, Error, void>({
    mutationFn: async () => {
      const response = await apiClient.admin.plugins['render-cache']['clear-all'].$post({ json: {} });
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
      const response = await apiClient.admin.plugins['render-cache']['clear-plugin'].$post({ query: { name }, json: {} });
      if (response.status === 200) return (await response.json()) as ClearRenderCacheResponse;
      return throwGenericError(response, 'Failed to clear cache', 'Plugin not loaded');
    },
  });
}
