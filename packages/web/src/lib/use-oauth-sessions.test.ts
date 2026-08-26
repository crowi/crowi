import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { act, createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Hook tests for `/me/oauth-sessions`'s React Query wrappers. `apiClient` is mocked at the shape `useOAuthSessions`/`useDeleteOAuthSession` actually call through — the real HTTP wire behavior (route matching, real supertest request) is covered server-side by `packages/api/src/hono/handlers/oauth-session.test.ts`; this file pins the CLIENT's own response-handling contract: GET success/error, DELETE 200/404/500/network-loss, and the `onSettled` invalidation that governs every one of those outcomes.
 */
const { get, del } = vi.hoisted(() => ({
  get: vi.fn(),
  del: vi.fn(),
}));

vi.mock('./api-client', () => ({
  apiClient: {
    me: {
      'oauth-sessions': {
        $get: get,
        ':id': { $delete: del },
      },
    },
  },
}));

import { makeApiResponse } from './test-utils/mocks';
import { oauthSessionKeys, useDeleteOAuthSession, useOAuthSessions } from './use-oauth-sessions';

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 }, mutations: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client }, children);
  }
  return Wrapper;
}

const SESSION = {
  id: 's1',
  clientId: 'crowi-cli',
  clientName: 'Crowi CLI',
  scopes: ['pages:read'],
  authorizedAt: '2026-01-01T00:00:00.000Z',
  lastRefreshedAt: '2026-01-02T00:00:00.000Z',
  expiresAt: '2026-02-01T00:00:00.000Z',
};

beforeEach(() => {
  get.mockReset();
  del.mockReset();
});

afterEach(cleanup);

describe('useOAuthSessions', () => {
  it('fetches and returns the oauthSessions list on 200', async () => {
    get.mockResolvedValue(makeApiResponse(200, { oauthSessions: [SESSION] }));
    const { result } = renderHook(() => useOAuthSessions(), { wrapper: wrapperFor(makeClient()) });

    await waitFor(() => expect(result.current.data).toEqual({ oauthSessions: [SESSION] }));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('surfaces a GET error (non-ok response) as isError', async () => {
    get.mockResolvedValue(makeApiResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'boom' } }));
    const { result } = renderHook(() => useOAuthSessions(), { wrapper: wrapperFor(makeClient()) });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useDeleteOAuthSession', () => {
  it('DELETE 200 resolves with the revoked session body and invalidates oauthSessionKeys.all', async () => {
    del.mockResolvedValue(makeApiResponse(200, SESSION));
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteOAuthSession(), { wrapper: wrapperFor(client) });

    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.mutateAsync('s1');
    });

    expect(del).toHaveBeenCalledWith({ param: { id: 's1' } });
    expect(resolved).toEqual(SESSION);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: oauthSessionKeys.all });
  });

  it('DELETE 404 resolves to null (already gone) and still invalidates oauthSessionKeys.all (AC-13)', async () => {
    del.mockResolvedValue(makeApiResponse(404, { error: { code: 'NOT_FOUND', message: 'No such OAuth session' } }));
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteOAuthSession(), { wrapper: wrapperFor(client) });

    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.mutateAsync('s1');
    });

    expect(resolved).toBeNull();
    expect(result.current.isError).toBe(false);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: oauthSessionKeys.all });
  });

  it('DELETE 500 rejects the mutation but still invalidates oauthSessionKeys.all (AC-16)', async () => {
    del.mockResolvedValue(makeApiResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'boom' } }));
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteOAuthSession(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await expect(result.current.mutateAsync('s1')).rejects.toThrow();
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: oauthSessionKeys.all });
  });

  it('a lost response (fetch AbortError / timeout) rejects the mutation but still invalidates oauthSessionKeys.all (AC-16)', async () => {
    const abortError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    del.mockRejectedValue(abortError);
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteOAuthSession(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await expect(result.current.mutateAsync('s1')).rejects.toThrow();
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: oauthSessionKeys.all });
  });
});
