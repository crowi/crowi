'use client';

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ListPluginsResponse, PluginConfigResponse, UpdatePluginConfigRequest, UpdatePluginConfigResponse } from '@crowi/api-contract';
import { apiClient } from './api-client';
import { unwrapResult } from './unwrap-result';

export const adminPluginsKeys = {
  all: ['admin', 'plugins'] as const,
  list: () => ['admin', 'plugins', 'list'] as const,
  config: (name: string) => ['admin', 'plugins', name, 'config'] as const,
};

export function useAdminPlugins() {
  return useQuery<ListPluginsResponse, Error>({
    queryKey: adminPluginsKeys.list(),
    queryFn: async () => {
      const result = await apiClient.admin.plugins.listPlugins();
      return unwrapResult(result, {
        ok: (body) => body,
        errors: { 401: 'Failed to fetch plugins', 403: 'Failed to fetch plugins' },
        fallback: 'Failed to fetch plugins',
      });
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

export function useAdminPluginConfig(name: string | null) {
  return useQuery<PluginConfigResponse, Error>({
    queryKey: name ? adminPluginsKeys.config(name) : adminPluginsKeys.all,
    queryFn: async () => {
      if (!name) throw new Error('plugin name is required');
      const result = await apiClient.admin.plugins.getPluginConfig({ query: { name } });
      return unwrapResult(result, {
        ok: (body) => body,
        errors: {
          401: 'Failed to fetch plugin config',
          403: 'Failed to fetch plugin config',
          404: 'Plugin not found',
        },
        fallback: 'Failed to fetch plugin config',
      });
    },
    enabled: !!name,
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

// useQueries (rather than N useQuery calls) because `names.length` varies
// per plugin's `requires` array.
export function useAdminPluginConfigs(names: string[]) {
  return useQueries({
    queries: names.map((name) => ({
      queryKey: adminPluginsKeys.config(name),
      queryFn: async (): Promise<PluginConfigResponse> => {
        const result = await apiClient.admin.plugins.getPluginConfig({ query: { name } });
        return unwrapResult(result, {
          ok: (body) => body,
          errors: {
            401: 'Failed to fetch plugin config',
            403: 'Failed to fetch plugin config',
            404: 'Plugin not found',
          },
          fallback: 'Failed to fetch plugin config',
        });
      },
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

export function useUpdateAdminPluginConfig(name: string) {
  const queryClient = useQueryClient();
  return useMutation<UpdatePluginConfigResponse, Error, UpdatePluginConfigRequest>({
    mutationFn: async (data) => {
      const result = await apiClient.admin.plugins.updatePluginConfig({
        query: { name },
        body: data,
      });
      if (result.status === 200) return result.body;
      if (result.status === 422) {
        throw new PluginConfigValidationError(result.body.error.message, result.body.error.issues);
      }
      const message = (result.body as { error?: { message?: string } } | undefined)?.error?.message ?? 'Failed to update plugin config';
      throw new Error(message);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminPluginsKeys.config(name) });
      queryClient.invalidateQueries({ queryKey: adminPluginsKeys.list() });
    },
  });
}
