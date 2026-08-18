'use client';

import { encodeProviderRouteSegment, ProviderRouteSegmentError } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './api-client';
import { errorMessage } from './error-message';

/**
 * RFC-0014 phase 4 / React Query
 * wrappers over the federated-auth routes the UI consumes.
 *
 * Two audiences with different auth: the provider LIST is public (the
 * login screen renders it before anyone is signed in), while the linked
 * identities, unlink, and the 3-stage link flow are the settings screen's
 * authenticated view. They are separate query keys for that reason — a
 * signed-out login page must never be able to populate, or be populated
 * from, a cache entry belonging to a session.
 */
export const authProviderKeys = {
  all: ['auth', 'providers'] as const,
  list: () => ['auth', 'providers', 'list'] as const,
  linked: () => ['auth', 'providers', 'linked'] as const,
  /** A single pending link completion, scoped to `provider`+`code` so two flows never share a cache entry. */
  completion: (provider: string, code: string) => ['auth', 'providers', 'completion', provider, code] as const,
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

/**
 * Thrown by every hook below. Carries
 * the HTTP `status` (`0` for a network/timeout failure — no response was
 * ever received) and the server's machine-readable `code` (`undefined` for
 * a network failure or an unparseable body) alongside a localized
 * `message`. 401/403 messages come straight from `errorMessage`'s existing
 * `AUTHENTICATION_REQUIRED` / user-status mapping — no new wording for
 * those two statuses; callers needing different copy per 400/404/409
 * branch on `code` themselves.
 */
export class ProviderLinkError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ProviderLinkError';
    this.status = status;
    this.code = code;
  }
}

/**
 * `encodeProviderRouteSegment` throws for `.`/`..`/empty — see that
 * function's doc comment. The Hono typed client substitutes a path param
 * VERBATIM (no `encodeURIComponent` of its own), so this is the one place
 * a `/`/`?`/`#` in `provider` is closed off before it can steer the
 * request at a different route. A rejected value never reaches
 * `fetch` at all — it fails locally as the same `ProviderLinkError` shape
 * a 404 from the server would produce (current sign-in already can't
 * reach a dot-only provider either, so this narrows nothing that used to
 * work — see the module's contract in `@crowi/api-contract`).
 */
function encodeProviderOrThrow(provider: string): string {
  try {
    return encodeProviderRouteSegment(provider);
  } catch (err) {
    if (err instanceof ProviderRouteSegmentError) {
      throw new ProviderLinkError(404, errorMessage('NOT_FOUND'), 'NOT_FOUND');
    }
    throw err;
  }
}

async function parseErrorBody(response: Response): Promise<{ code?: string; message?: string }> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    return { code: body.error?.code, message: body.error?.message };
  } catch {
    return {};
  }
}

async function toProviderLinkError(response: Response): Promise<ProviderLinkError> {
  const { code, message } = await parseErrorBody(response);
  return new ProviderLinkError(response.status, errorMessage(code, message), code);
}

/** A `fetch` (or `fetchWithTimeout`) rejection — no response was ever received. */
function toNetworkError(err: unknown): ProviderLinkError {
  return new ProviderLinkError(0, err instanceof Error ? err.message : errorMessage(undefined), undefined);
}

/** Runs `send()`, mapping a rejection (no response ever received) to `toNetworkError` — shared by every hook below so each only declares the typed-client call once, not also a `let response: Awaited<ReturnType<...>>` for the try/catch. */
async function sendOrNetworkError<R>(send: () => Promise<R>): Promise<R> {
  try {
    return await send();
  } catch (err) {
    throw toNetworkError(err);
  }
}

/**
 * Stage 1 — `POST link-start`. The ONLY call in this file sent with
 * `credentials: 'include'` (design decision 25: lets a same-site
 * split-origin deployment's `AUTH_PUBLIC_WEB_URL` still ride the
 * credentialed preflight/POST the api's CORS resolver allow-lists) — every
 * other `apiFetch`-routed call keeps the default credentials mode
 * unchanged.
 */
export function useStartProviderLink() {
  return useMutation<{ authorizationUrl: string }, ProviderLinkError, string>({
    mutationFn: async (provider: string) => {
      const segment = encodeProviderOrThrow(provider);
      const response = await sendOrNetworkError(() =>
        apiClient.auth.providers[':name']['link-start'].$post({ param: { name: segment } }, { init: { credentials: 'include' } }),
      );
      if (response.status !== 200) throw await toProviderLinkError(response);
      return response.json();
    },
  });
}

export interface PendingLinkCompletionData {
  provider: string;
  accountLabel?: string;
}

/**
 * Stage 3a — `GET link-completions/{code}`, non-destructive. Enabled only
 * once both `provider`/`code` are non-null; `retry: false` (a single
 * automatic retry would blur the distinction between "still loading" and
 * "the caller explicitly asked to try again") — the confirmation dialog's
 * own "retry" action calls the returned `refetch()` explicitly.
 */
export function usePendingLinkCompletion(provider: string | null, code: string | null) {
  return useQuery<PendingLinkCompletionData, ProviderLinkError>({
    queryKey: authProviderKeys.completion(provider ?? '', code ?? ''),
    enabled: provider != null && code != null,
    retry: false,
    queryFn: async () => {
      const segment = encodeProviderOrThrow(provider as string);
      const response = await sendOrNetworkError(() =>
        apiClient.auth.providers[':name']['link-completions'][':code'].$get({ param: { name: segment, code: code as string } }),
      );
      if (response.status !== 200) throw await toProviderLinkError(response);
      return response.json();
    },
  });
}

export interface CompleteProviderLinkInput {
  provider: string;
  code: string;
}

/**
 * Stage 3b — `POST link-completions/{code}`, terminal. Never auto-retries
 * (the unified web retry rule lives in the confirmation dialog, which
 * resends explicitly via the SAME mutation — see design decision 20); a
 * 200 invalidates the linked-providers list so the settings screen
 * reflects the new identity without a manual refresh.
 */
export function useCompleteProviderLink() {
  const queryClient = useQueryClient();
  return useMutation<{ result: 'linked' }, ProviderLinkError, CompleteProviderLinkInput>({
    mutationFn: async ({ provider, code }) => {
      const segment = encodeProviderOrThrow(provider);
      const response = await sendOrNetworkError(() => apiClient.auth.providers[':name']['link-completions'][':code'].$post({ param: { name: segment, code } }));
      if (response.status !== 200) throw await toProviderLinkError(response);
      return response.json();
    },
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: authProviderKeys.linked() });
    },
  });
}
