import { createClient } from '@crowi/api-contract';
import { encodeProviderRouteSegment } from './provider-route-codec';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { act, createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Hook tests for the 3-stage link
 * flow's React Query wrappers. `apiClient` is mocked at the shape
 * `useStartProviderLink`/`usePendingLinkCompletion`/`useCompleteProviderLink`
 * actually call through — the SERVER-side "does this wire form survive a
 * real HTTP round trip and decode back to the original provider" property
 * is exercised end-to-end (real Hono route matching, real supertest
 * request) in `federated-auth.test.ts`'s `foo:bar` case; this file pins
 * the CLIENT's own encode-before-send contract via the exact `param.name`
 * value it hands the (mocked) typed client, plus a pure round-trip check
 * of `encodeProviderRouteSegment` itself.
 */
const { startPost, getCompletion, postCompletion } = vi.hoisted(() => ({
  startPost: vi.fn(),
  getCompletion: vi.fn(),
  postCompletion: vi.fn(),
}));

vi.mock('./api-client', () => ({
  apiClient: {
    auth: {
      providers: {
        ':name': {
          'link-start': { $post: startPost },
          'link-completions': {
            ':code': { $get: getCompletion, $post: postCompletion },
          },
        },
      },
    },
  },
}));

import { errorMessage } from './error-message';
import { makeApiResponse } from './test-utils/mocks';
import { authProviderKeys, useCompleteProviderLink, usePendingLinkCompletion, useStartProviderLink } from './use-auth-providers';

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 }, mutations: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client }, children);
  }
  return Wrapper;
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

beforeEach(() => {
  startPost.mockReset();
  getCompletion.mockReset();
  postCompletion.mockReset();
});

afterEach(cleanup);

describe('useStartProviderLink', () => {
  it('POSTs with credentials: include, and resolves the authorizationUrl on 200', async () => {
    startPost.mockResolvedValue(makeApiResponse(200, { authorizationUrl: 'https://api.example.com/x' }));
    const { result } = renderHook(() => useStartProviderLink(), { wrapper: wrapperFor(makeClient()) });

    let resolved: { authorizationUrl: string } | undefined;
    await act(async () => {
      resolved = await result.current.mutateAsync('google');
    });

    expect(startPost).toHaveBeenCalledWith({ param: { name: 'google' } }, { init: { credentials: 'include' } });
    expect(resolved).toEqual({ authorizationUrl: 'https://api.example.com/x' });
  });

  it('does not auto-retry on failure', async () => {
    startPost.mockResolvedValue(makeApiResponse(500, errorBody('INTERNAL_ERROR', 'boom')));
    const { result } = renderHook(() => useStartProviderLink(), { wrapper: wrapperFor(makeClient()) });

    await act(async () => {
      await expect(result.current.mutateAsync('google')).rejects.toMatchObject({ status: 500 });
    });
    expect(startPost).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['401', 401, 'AUTHENTICATION_REQUIRED'],
    ['403', 403, 'FORBIDDEN'],
    ['404', 404, 'NOT_FOUND'],
  ])('maps a %s response to ProviderLinkError{status,code}', async (_label, status, code) => {
    startPost.mockResolvedValue(makeApiResponse(status, errorBody(code, 'server message')));
    const { result } = renderHook(() => useStartProviderLink(), { wrapper: wrapperFor(makeClient()) });

    await act(async () => {
      await expect(result.current.mutateAsync('google')).rejects.toMatchObject({ status, code });
    });
  });

  it('401/403 reuse the EXISTING error-message.ts AUTHENTICATION_REQUIRED / user-status mapping — no new wording', async () => {
    startPost.mockResolvedValue(makeApiResponse(401, errorBody('AUTHENTICATION_REQUIRED', 'server text')));
    const { result } = renderHook(() => useStartProviderLink(), { wrapper: wrapperFor(makeClient()) });

    await act(async () => {
      await expect(result.current.mutateAsync('google')).rejects.toMatchObject({ message: errorMessage('AUTHENTICATION_REQUIRED') });
    });
  });

  it('maps a network failure (fetch rejects) to ProviderLinkError{status: 0}', async () => {
    startPost.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useStartProviderLink(), { wrapper: wrapperFor(makeClient()) });

    await act(async () => {
      await expect(result.current.mutateAsync('google')).rejects.toMatchObject({ status: 0 });
    });
  });

  it.each([
    ['a/b', 'a%2Fb'],
    ['a?b', 'a%3Fb'],
    ['a#b', 'a%23b'],
    ['%2F', '%252F'],
    ['foo:bar', 'foo%3Abar'],
  ])('encodes provider %s to the single-encoded wire segment %s before handing it to the typed client', async (provider, expected) => {
    startPost.mockResolvedValue(makeApiResponse(200, { authorizationUrl: 'https://x' }));
    const { result } = renderHook(() => useStartProviderLink(), { wrapper: wrapperFor(makeClient()) });

    await act(async () => {
      await result.current.mutateAsync(provider);
    });
    expect(startPost).toHaveBeenCalledWith({ param: { name: expected } }, { init: { credentials: 'include' } });
  });

  it.each(['.', '..', ''])('rejects an invalid provider (%j) without ever calling the typed client', async (provider) => {
    const { result } = renderHook(() => useStartProviderLink(), { wrapper: wrapperFor(makeClient()) });

    await act(async () => {
      await expect(result.current.mutateAsync(provider)).rejects.toMatchObject({ status: 404 });
    });
    expect(startPost).not.toHaveBeenCalled();
  });
});

describe('usePendingLinkCompletion', () => {
  it('is disabled until BOTH provider and code are present', () => {
    const { result: bothNull } = renderHook(() => usePendingLinkCompletion(null, null), { wrapper: wrapperFor(makeClient()) });
    expect(bothNull.current.fetchStatus).toBe('idle');

    const { result: onlyProvider } = renderHook(() => usePendingLinkCompletion('google', null), { wrapper: wrapperFor(makeClient()) });
    expect(onlyProvider.current.fetchStatus).toBe('idle');

    expect(getCompletion).not.toHaveBeenCalled();
  });

  it('queryKey is scoped to provider+code (authProviderKeys.completion)', () => {
    const client = makeClient();
    getCompletion.mockResolvedValue(makeApiResponse(200, { provider: 'google' }));
    renderHook(() => usePendingLinkCompletion('google', 'code123'), { wrapper: wrapperFor(client) });

    expect(client.getQueryState(authProviderKeys.completion('google', 'code123'))).toBeDefined();
  });

  it('fetches once enabled, returning the body (with optional accountLabel) on 200', async () => {
    getCompletion.mockResolvedValue(makeApiResponse(200, { provider: 'google', accountLabel: 'a@example.com' }));
    const { result } = renderHook(() => usePendingLinkCompletion('google', 'code123'), { wrapper: wrapperFor(makeClient()) });

    await waitFor(() => expect(result.current.data).toEqual({ provider: 'google', accountLabel: 'a@example.com' }));
    expect(getCompletion).toHaveBeenCalledWith({ param: { name: 'google', code: 'code123' } });
  });

  it('does not auto-retry on failure — a single failed fetch settles the query', async () => {
    getCompletion.mockResolvedValue(makeApiResponse(500, errorBody('INTERNAL_ERROR', 'boom')));
    const { result } = renderHook(() => usePendingLinkCompletion('google', 'code123'), { wrapper: wrapperFor(makeClient()) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(getCompletion).toHaveBeenCalledTimes(1);
  });

  it('manual refetch() re-issues the SAME GET explicitly', async () => {
    getCompletion.mockResolvedValue(makeApiResponse(500, errorBody('INTERNAL_ERROR', 'boom')));
    const { result } = renderHook(() => usePendingLinkCompletion('google', 'code123'), { wrapper: wrapperFor(makeClient()) });
    await waitFor(() => expect(result.current.isError).toBe(true));

    getCompletion.mockResolvedValue(makeApiResponse(200, { provider: 'google' }));
    await act(async () => {
      await result.current.refetch();
    });

    expect(getCompletion).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.data).toEqual({ provider: 'google' }));
  });

  it.each([
    ['400', 400, 'VALIDATION_ERROR'],
    ['401', 401, 'AUTHENTICATION_REQUIRED'],
    ['403', 403, 'FORBIDDEN'],
    ['404', 404, 'NOT_FOUND'],
    ['409', 409, 'LINK_COMPLETION_CONSUMED'],
    ['500', 500, 'INTERNAL_ERROR'],
  ])('maps a %s GET response to ProviderLinkError{status,code}', async (_label, status, code) => {
    getCompletion.mockResolvedValue(makeApiResponse(status, errorBody(code, 'server message')));
    const { result } = renderHook(() => usePendingLinkCompletion('google', 'code123'), { wrapper: wrapperFor(makeClient()) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ status, code });
  });

  it('maps a network failure to ProviderLinkError{status: 0}', async () => {
    getCompletion.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => usePendingLinkCompletion('google', 'code123'), { wrapper: wrapperFor(makeClient()) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ status: 0 });
  });

  it.each([
    ['a/b', 'a%2Fb'],
    ['a?b', 'a%3Fb'],
    ['a#b', 'a%23b'],
    ['%2F', '%252F'],
  ])('encodes provider %s to %s before calling the typed client', async (provider, expected) => {
    getCompletion.mockResolvedValue(makeApiResponse(200, { provider }));
    renderHook(() => usePendingLinkCompletion(provider, 'code123'), { wrapper: wrapperFor(makeClient()) });

    await waitFor(() => expect(getCompletion).toHaveBeenCalledWith({ param: { name: expected, code: 'code123' } }));
  });

  it.each(['.', '..', ''])('an invalid provider (%j) never reaches the typed client — the query errors locally', async (provider) => {
    const { result } = renderHook(() => usePendingLinkCompletion(provider, 'code123'), { wrapper: wrapperFor(makeClient()) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ status: 404 });
    expect(getCompletion).not.toHaveBeenCalled();
  });
});

describe('useCompleteProviderLink', () => {
  it('POSTs and, on 200, invalidates the linked-providers list', async () => {
    postCompletion.mockResolvedValue(makeApiResponse(200, { result: 'linked' }));
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCompleteProviderLink(), { wrapper: wrapperFor(client) });

    let resolved: { result: 'linked' } | undefined;
    await act(async () => {
      resolved = await result.current.mutateAsync({ provider: 'google', code: 'code123' });
    });

    expect(postCompletion).toHaveBeenCalledWith({ param: { name: 'google', code: 'code123' } });
    expect(resolved).toEqual({ result: 'linked' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: authProviderKeys.linked() });
  });

  it('does not auto-retry on failure', async () => {
    postCompletion.mockResolvedValue(makeApiResponse(500, errorBody('INTERNAL_ERROR', 'boom')));
    const { result } = renderHook(() => useCompleteProviderLink(), { wrapper: wrapperFor(makeClient()) });

    await act(async () => {
      await expect(result.current.mutateAsync({ provider: 'google', code: 'code123' })).rejects.toMatchObject({ status: 500 });
    });
    expect(postCompletion).toHaveBeenCalledTimes(1);
  });

  it('does NOT invalidate the linked list on failure', async () => {
    postCompletion.mockResolvedValue(makeApiResponse(409, errorBody('FEDERATED_IDENTITY_IN_USE', 'taken')));
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCompleteProviderLink(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await expect(result.current.mutateAsync({ provider: 'google', code: 'code123' })).rejects.toMatchObject({ status: 409 });
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['400', 400, 'VALIDATION_ERROR'],
    ['401', 401, 'AUTHENTICATION_REQUIRED'],
    ['403', 403, 'FORBIDDEN'],
    ['404', 404, 'NOT_FOUND'],
    ['409 identity in use', 409, 'FEDERATED_IDENTITY_IN_USE'],
    ['409 auth state changed', 409, 'FEDERATED_LINK_AUTH_STATE_CHANGED'],
    ['409 not linked', 409, 'FEDERATED_LINK_NOT_LINKED'],
    ['500', 500, 'INTERNAL_ERROR'],
  ])('maps a %s POST response to ProviderLinkError{status,code}', async (_label, status, code) => {
    postCompletion.mockResolvedValue(makeApiResponse(status, errorBody(code, 'server message')));
    const { result } = renderHook(() => useCompleteProviderLink(), { wrapper: wrapperFor(makeClient()) });

    await act(async () => {
      await expect(result.current.mutateAsync({ provider: 'google', code: 'code123' })).rejects.toMatchObject({ status, code });
    });
  });

  it('maps a network failure to ProviderLinkError{status: 0}', async () => {
    postCompletion.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useCompleteProviderLink(), { wrapper: wrapperFor(makeClient()) });

    await act(async () => {
      await expect(result.current.mutateAsync({ provider: 'google', code: 'code123' })).rejects.toMatchObject({ status: 0 });
    });
  });

  it.each([
    ['a/b', 'a%2Fb'],
    ['a?b', 'a%3Fb'],
    ['a#b', 'a%23b'],
    ['%2F', '%252F'],
  ])('encodes provider %s to %s before calling the typed client', async (provider, expected) => {
    postCompletion.mockResolvedValue(makeApiResponse(200, { result: 'linked' }));
    const { result } = renderHook(() => useCompleteProviderLink(), { wrapper: wrapperFor(makeClient()) });

    await act(async () => {
      await result.current.mutateAsync({ provider, code: 'code123' });
    });
    expect(postCompletion).toHaveBeenCalledWith({ param: { name: expected, code: 'code123' } });
  });

  it.each(['.', '..', ''])('rejects an invalid provider (%j) without ever calling the typed client', async (provider) => {
    const { result } = renderHook(() => useCompleteProviderLink(), { wrapper: wrapperFor(makeClient()) });

    await act(async () => {
      await expect(result.current.mutateAsync({ provider, code: 'code123' })).rejects.toMatchObject({ status: 404 });
    });
    expect(postCompletion).not.toHaveBeenCalled();
  });
});

describe('encodeProviderRouteSegment — round trip (server decodes exactly once)', () => {
  it.each(['a/b', 'a?b', 'a#b', '%2F', 'foo:bar', 'a b', 'ぷろばいだ'])('single-encodes %s and a single decodeURIComponent recovers it exactly', (provider) => {
    const encoded = encodeProviderRouteSegment(provider);
    // Never re-encoded twice (would corrupt a literal `%` in the input) — a second decode must NOT be needed.
    expect(decodeURIComponent(encoded)).toBe(provider);
  });

  it.each(['.', '..', ''])('throws for %j (no safe wire form exists)', (provider) => {
    expect(() => encodeProviderRouteSegment(provider)).toThrow();
  });
});

/**
 * Real transport seam: a REAL `createClient` (not the `./api-client` module
 * mock every other `describe` block above uses) wired to a recording
 * `fetch` stub. The hook-level tests above only ever assert on the
 * `param.name` STRING value the hooks hand to a hand-rolled mock — they
 * never exercise the typed client's OWN path-templating (verbatim
 * substitution, no `encodeURIComponent` of its own — see
 * `use-auth-providers.ts`'s `encodeProviderOrThrow` doc comment), so a bug
 * there could pass every test above while still sending a broken URL. This
 * closes that gap: it builds the actual outgoing `Request`, inspects its
 * REAL `pathname` (via `new URL(...)`, not string matching), and confirms
 * one `decodeURIComponent` recovers the raw provider — the same property
 * `federated-auth.test.ts`'s server-side round trip proves for the
 * request's OTHER end.
 */
describe('real typed-client transport — the actual outgoing URL never collapses (AC-20)', () => {
  function recordingClient(): { client: ReturnType<typeof createClient>; requestedUrls: string[] } {
    const requestedUrls: string[] = [];
    const recordingFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      requestedUrls.push(url);
      return new Response(JSON.stringify({ authorizationUrl: 'https://idp.example.com/x', provider: 'x', result: 'linked' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    return { client: createClient('https://api.test.example/api', { fetch: recordingFetch }), requestedUrls };
  }

  it.each([
    'a/b',
    'a?b',
    'a#b',
    '%2F',
    'a%2Fb',
  ])('link-start for provider %j builds a REAL request whose pathname has exactly one encoded segment, decoding back to the raw provider', async (rawProvider) => {
    const { client, requestedUrls } = recordingClient();
    const segment = encodeProviderRouteSegment(rawProvider);

    await client.auth.providers[':name']['link-start'].$post({ param: { name: segment } }, { init: { credentials: 'include' } });

    expect(requestedUrls).toHaveLength(1);
    const requestedUrl = new URL(requestedUrls[0]);
    // The path never gained an EXTRA segment (a raw `/`/`?`/`#` would
    // have split the path, added a query string, or truncated it at a
    // fragment) — exactly the `.../providers/<one segment>/link-start` shape.
    const segments = requestedUrl.pathname.split('/').filter(Boolean);
    expect(segments.at(-1)).toBe('link-start');
    expect(segments.at(-2)).toBe(segment);
    // One decode — never two — recovers the exact original provider.
    expect(decodeURIComponent(segments.at(-2) as string)).toBe(rawProvider);
  });

  it('GET/POST link-completions/{code} also send exactly one encoded provider segment that decodes back to the raw provider', async () => {
    const rawProvider = 'a/b?c#d';
    const segment = encodeProviderRouteSegment(rawProvider);

    const { client: getClient, requestedUrls: getUrls } = recordingClient();
    await getClient.auth.providers[':name']['link-completions'][':code'].$get({ param: { name: segment, code: 'a'.repeat(43) } });
    const getSegments = new URL(getUrls[0]).pathname.split('/').filter(Boolean);
    expect(decodeURIComponent(getSegments.at(-3) as string)).toBe(rawProvider);

    const { client: postClient, requestedUrls: postUrls } = recordingClient();
    await postClient.auth.providers[':name']['link-completions'][':code'].$post({ param: { name: segment, code: 'a'.repeat(43) } });
    const postSegments = new URL(postUrls[0]).pathname.split('/').filter(Boolean);
    expect(decodeURIComponent(postSegments.at(-3) as string)).toBe(rawProvider);
  });
});
