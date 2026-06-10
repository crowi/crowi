'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getLocale, setLocale, locales, type Locale } from '@paraglide/runtime.js';
import type { Theme, UpdatePasswordRequest, UpdateProfileRequest } from '@crowi/api-contract';
import { apiClientV2 } from './api-client';

function profileLangToLocale(lang: string | undefined | null): Locale | null {
  if (!lang) return null;
  const lower = lang.toLowerCase().replace('_', '-');
  if (locales.includes(lower as Locale)) return lower as Locale;
  const base = lower.split('-')[0];
  return locales.includes(base as Locale) ? (base as Locale) : null;
}

/**
 * RFC-0006 Phase 4 Batch 2 — switched all `me` hooks from
 * `apiClient.me.*` (ts-rest) to `apiClientV2.me.*.$method` (hc<AppType>).
 * Wire payload is unchanged; the only difference at the call site is
 * `response.ok` / `response.json()` instead of ts-rest's `result.status` +
 * `result.body`. The `unwrapResult` helper isn't reused here because the
 * legacy error envelopes (`{ status: 'error', errors: string[] }`) need
 * resource-specific handling, just as before.
 */
export function useProfile() {
  return useQuery({
    queryKey: ['profile'],
    queryFn: async () => {
      const response = await apiClientV2.me.$get();
      if (!response.ok) {
        throw new Error('Failed to fetch profile');
      }
      return response.json();
    },
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: UpdateProfileRequest) => {
      const response = await apiClientV2.me.$put({ json: data });
      if (response.status === 200) {
        return response.json();
      }
      // 400 surfaces a `{ status: 'error', code?, errors: string[], message? }`
      // body; carry the `code` on the thrown error so the form can show a
      // localized message (the server `message` is English).
      if (response.status === 400) {
        const body = (await response.json()) as { code?: string; errors?: string[]; message?: string };
        const err = new Error(body.errors?.[0] || body.message || 'Failed to update profile') as Error & { code?: string };
        err.code = body.code;
        throw err;
      }
      throw new Error('Failed to update profile');
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      const target = profileLangToLocale(variables.userForm?.lang);
      if (target && target !== getLocale()) {
        // Reloads the page so Server Components re-render in the new locale.
        setLocale(target);
      }
    },
  });
}

/**
 * Persist the preferred theme to `User.theme` so it syncs across devices.
 * Driven by `ThemeSync` (which observes the `next-themes` value), not by the
 * profile form. On success we patch the cached profile in place rather than
 * invalidating — the value we just wrote is authoritative and a refetch would
 * race the optimistic UI the toggle already applied.
 */
export function useUpdateTheme() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (theme: Theme) => {
      const response = await apiClientV2.me.theme.$patch({ json: { theme } });
      if (response.status === 200) {
        return response.json();
      }
      throw new Error('Failed to update theme');
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['profile'], (prev) => (prev ? { ...prev, theme: data.theme } : prev));
    },
  });
}

export function useUploadPicture() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (file: File) => {
      // hc<AppType>'s `$post` for multipart/form-data takes the field
      // map as `form` (mirrors Hono's `c.req.parseBody()` field shape).
      const response = await apiClientV2.me.picture.$post({
        form: { file },
      });
      if (response.status === 200) {
        return response.json();
      }
      if (response.status === 400) {
        const body = (await response.json()) as { errors?: string[]; message?: string };
        throw new Error(body.errors?.[0] || body.message || 'Failed to upload picture');
      }
      throw new Error('Failed to upload picture');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

export function useDeletePicture() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const response = await apiClientV2.me.picture.$delete();
      if (response.status === 200) {
        return response.json();
      }
      if (response.status === 400) {
        const body = (await response.json()) as { errors?: string[]; message?: string };
        throw new Error(body.errors?.[0] || body.message || 'Failed to delete picture');
      }
      throw new Error('Failed to delete picture');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

export function useUpdatePassword() {
  return useMutation({
    mutationFn: async (data: UpdatePasswordRequest) => {
      const response = await apiClientV2.me.password.$put({ json: data });
      if (response.status === 200) {
        return response.json();
      }
      // 400 surfaces a structured `{ errors: string[], message? }` shape
      // so we can join multiple validation messages.
      if (response.status === 400) {
        const body = (await response.json()) as { errors?: string[]; message?: string };
        const errors = body.errors || [];
        throw new Error(errors.length > 0 ? errors.join(', ') : body.message || 'Failed to update password');
      }
      throw new Error('Failed to update password');
    },
  });
}
