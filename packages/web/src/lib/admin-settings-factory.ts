'use client';

import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';

/**
 * Factory for the "throw on non-200, setQueryData on success" admin settings
 * hook pair (`useGet` + `useUpdate`). Three admin sections (share / auth /
 * security) all use this exact shape; collapsing them into one factory
 * removes ~80 lines of near-duplicate hook code.
 *
 * Notes / non-goals:
 * - The app and mail settings hooks use a *different* shape (return null on
 *   non-200, parse 400 ZodIssues into per-field errors, invalidate instead
 *   of setQueryData). Those don't fit here — keep them inline.
 * - The 422 validation error path is opt-in via `mapValidationError`. For
 *   the current call sites only auth has a 422 (self-lockout); share and
 *   security pass `mapValidationError: undefined` and the helper falls
 *   through to the generic Error.
 */

/**
 * Loose envelope matching the ts-rest result shape we care about.
 * ts-rest returns a wide union over every HTTP status; we only branch on
 * 200/401/403/422 so the rest is flattened into "the unknown failure path".
 */
type ApiResult<T> = { status: number; body: unknown } & ({ status: 200; body: T } | { status: number; body: unknown });

interface ErrorBody {
  error: { message: string };
}

const isErrorBody = (body: unknown): body is ErrorBody =>
  !!body && typeof body === 'object' && 'error' in body && typeof (body as ErrorBody).error?.message === 'string';

interface AdminSettingsHooksConfig<Settings, UpdateRequest> {
  /** Stable React Query key for this section. Same key is used for the
   *  GET and the post-PUT `setQueryData` so the form sees fresh data
   *  without a follow-up fetch. */
  queryKey: QueryKey;
  /** API client GET method. Returns the standard ts-rest result envelope. */
  fetch: () => Promise<ApiResult<Settings>>;
  /** API client PUT method. */
  update: (body: UpdateRequest) => Promise<ApiResult<Settings>>;
  /** User-facing fallback message when fetch fails for an unknown reason. */
  fetchErrorMessage: string;
  /** User-facing fallback message when update fails for an unknown reason. */
  updateErrorMessage: string;
  /**
   * Optional 422 mapper. Returning a non-null Error replaces the generic
   * one — used by auth.ts to surface `AdminAuthSettingsValidationError`
   * with its `code` discriminator.
   */
  mapValidationError?: (body: ErrorBody) => Error | null;
  /**
   * Optional extra side effect on a successful PUT. Useful for invalidating
   * cross-cutting caches (e.g. share toggles affect the app settings page's
   * read-only badge).
   */
  onUpdateSuccess?: (data: Settings, queryClient: ReturnType<typeof useQueryClient>) => void;
}

export interface AdminSettingsHooks<Settings, UpdateRequest> {
  useGet: () => ReturnType<typeof useQuery<Settings, Error>>;
  useUpdate: () => ReturnType<typeof useMutation<Settings, Error, UpdateRequest>>;
}

export function createAdminSettingsHooks<Settings, UpdateRequest>(
  config: AdminSettingsHooksConfig<Settings, UpdateRequest>,
): AdminSettingsHooks<Settings, UpdateRequest> {
  const { queryKey, fetch, update, fetchErrorMessage, updateErrorMessage, mapValidationError, onUpdateSuccess } = config;

  function useGet() {
    return useQuery<Settings, Error>({
      queryKey,
      queryFn: async () => {
        const result = await fetch();
        if (result.status === 200) {
          return result.body as Settings;
        }
        if ((result.status === 401 || result.status === 403) && isErrorBody(result.body)) {
          throw new Error(result.body.error.message);
        }
        throw new Error(fetchErrorMessage);
      },
      // Admin settings rarely change; the matching mutation seeds the cache
      // explicitly via setQueryData. No need to refetch on focus regain.
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    });
  }

  function useUpdate() {
    const queryClient = useQueryClient();

    return useMutation<Settings, Error, UpdateRequest>({
      mutationFn: async (data: UpdateRequest) => {
        const result = await update(data);
        if (result.status === 200) {
          return result.body as Settings;
        }
        if (result.status === 422 && mapValidationError && isErrorBody(result.body)) {
          const mapped = mapValidationError(result.body);
          if (mapped) throw mapped;
        }
        if ((result.status === 401 || result.status === 403) && isErrorBody(result.body)) {
          throw new Error(result.body.error.message);
        }
        throw new Error(updateErrorMessage);
      },
      onSuccess: (data) => {
        queryClient.setQueryData(queryKey, data);
        if (onUpdateSuccess) onUpdateSuccess(data, queryClient);
      },
    });
  }

  return { useGet, useUpdate };
}
