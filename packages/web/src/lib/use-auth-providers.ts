'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { m } from '@paraglide/messages.js';
import { apiClient } from './api-client';

/**
 * RFC-0014 phase 4 — React Query wrappers over the federated-auth routes
 * the UI consumes.
 *
 * Two audiences with different auth: the provider LIST is public (the
 * login screen renders it before anyone is signed in), while the linked
 * identities and unlink are the settings screen's authenticated view.
 * They are separate query keys for that reason — a signed-out login page
 * must never be able to populate, or be populated from, a cache entry
 * belonging to a session.
 */
export const authProviderKeys = {
  all: ['auth', 'providers'] as const,
  list: () => ['auth', 'providers', 'list'] as const,
  linked: () => ['auth', 'providers', 'linked'] as const,
};

export interface AuthProviderSummary {
  name: string;
  buttonLabel: string;
  iconUrl?: string;
}

/**
 * The enabled sign-in providers, in the order the API returns them.
 *
 * A provider only appears here once its plugin reports complete
 * credentials, so the login screen never has to decide what is usable —
 * anything in this list is startable.
 */
export function useAuthProviders() {
  return useQuery<AuthProviderSummary[]>({
    queryKey: authProviderKeys.list(),
    queryFn: async () => {
      const response = await apiClient.auth.providers.$get();
      if (response.status !== 200) throw new Error(m['auth.providers.load_failed']());
      const body = await response.json();
      return body.providers;
    },
    // Provider availability changes only when an admin edits plugin
    // config, so this does not need to follow window focus.
    refetchOnWindowFocus: false,
  });
}

/** Provider slugs the signed-in user has connected. Slugs only — see the API's response schema. */
export function useLinkedAuthProviders() {
  return useQuery<string[]>({
    queryKey: authProviderKeys.linked(),
    queryFn: async () => {
      const response = await apiClient.auth.providers.identities.$get();
      if (response.status !== 200) throw new Error(m['me.linked_accounts.load_failed']());
      const body = await response.json();
      return body.identities.map((identity) => identity.provider);
    },
  });
}

export interface UnlinkAuthProviderError extends Error {
  /** `PASSWORD_REQUIRED` / `FEDERATED_UNLINK_DISABLED` — the caller decides how to phrase each. */
  code?: string;
}

/**
 * Disconnect a provider.
 *
 * Deliberately NOT optimistic: the server refuses an unlink that would
 * leave the account with no way back in, and showing the row as already
 * disconnected before that verdict arrives would tell the user the
 * opposite of what happened. The linked list is only invalidated once the
 * server has actually removed the identity.
 */
export function useUnlinkAuthProvider() {
  const queryClient = useQueryClient();
  return useMutation<void, UnlinkAuthProviderError, string>({
    mutationFn: async (provider: string) => {
      const response = await apiClient.auth.providers[':name'].identity.$delete({ param: { name: provider } });
      if (response.status === 204) return;

      let code: string | undefined;
      let message: string | undefined;
      try {
        const body = (await response.json()) as { error?: { code?: string; message?: string } };
        code = body.error?.code;
        message = body.error?.message;
      } catch {
        // Fall through to the generic message below.
      }
      const error = new Error(message ?? m['me.linked_accounts.unlink_failed']()) as UnlinkAuthProviderError;
      error.code = code;
      throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: authProviderKeys.linked() });
    },
  });
}
