'use client';

import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';

/**
 * Factory for the "throw on non-200, setQueryData on success" admin settings
 * hook pair (`useGet` + `useUpdate`). Three admin sections (share / auth /
 * security) all use this exact shape; collapsing them into one factory
 * removes ~80 lines of near-duplicate hook code.
 *
 * RFC-0006 Phase 4 Batch 9 — adapted to the typed `apiClient` client
 * (`createClient`) which returns a `Response` rather than the ts-rest
 * `{ status, body }` envelope. The factory parses the body on demand so
 * the call sites stay declarative.
 *
 * Notes / non-goals:
 * - The app and mail settings hooks use a *different* shape (return null on
 *   non-200, parse 400 ZodIssues into per-field errors, invalidate instead
 *   of setQueryData). Those don't fit here — keep them inline.
 * - The 422 validation error path is opt-in via `mapValidationError`. No
 *   current call site uses it (share / security omit it and fall through to
 *   the generic Error); it is retained for sections that need to surface a
 *   discriminated validation failure.
 */

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
  /** `apiClient` GET method — returns a Response. */
  fetch: () => Promise<Response>;
  /** `apiClient` PUT method — returns a Response. */
  update: (body: UpdateRequest) => Promise<Response>;
  /** User-facing fallback message when fetch fails for an unknown reason. */
  fetchErrorMessage: string;
  /** User-facing fallback message when update fails for an unknown reason. */
  updateErrorMessage: string;
  /**
   * Optional 422 mapper. Returning a non-null Error replaces the generic
   * one — lets a section surface a discriminated validation failure with its
   * own `code` instead of the localised message string.
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

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

export function createAdminSettingsHooks<Settings, UpdateRequest>(
  config: AdminSettingsHooksConfig<Settings, UpdateRequest>,
): AdminSettingsHooks<Settings, UpdateRequest> {
  const { queryKey, fetch, update, fetchErrorMessage, updateErrorMessage, mapValidationError, onUpdateSuccess } = config;

  function useGet() {
    return useQuery<Settings, Error>({
      queryKey,
      queryFn: async () => {
        const response = await fetch();
        if (response.status === 200) {
          return (await response.json()) as Settings;
        }
        const body = await readJson(response);
        if ((response.status === 401 || response.status === 403) && isErrorBody(body)) {
          throw new Error(body.error.message);
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
        const response = await update(data);
        if (response.status === 200) {
          return (await response.json()) as Settings;
        }
        const body = await readJson(response);
        if (response.status === 422 && mapValidationError && isErrorBody(body)) {
          const mapped = mapValidationError(body);
          if (mapped) throw mapped;
        }
        if ((response.status === 401 || response.status === 403) && isErrorBody(body)) {
          throw new Error(body.error.message);
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
