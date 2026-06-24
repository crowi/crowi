import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';

// Mock `apiClientV2` so the hook reads our fake `pages[':id']['yjs-token']
// .$get`. Vitest hoists `vi.mock` above imports; `vi.hoisted` makes the
// shared stub accessible from both the factory and the test bodies
// without a TDZ violation. RFC-0006 Batch 5 switched the hook from
// ts-rest's `apiClient.pageCollab.getYjsToken` to hc<AppType>'s
// Response-shaped fetch call.
const { getYjsToken, tokenRefreshListeners, emitTokenRefreshed } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    getYjsToken: vi.fn(),
    tokenRefreshListeners: listeners,
    emitTokenRefreshed: () => {
      for (const l of [...listeners]) l();
    },
  };
});
vi.mock('./api-client', () => ({
  apiClientV2: {
    pages: {
      ':id': {
        'yjs-token': { $get: getYjsToken },
      },
    },
  },
}));
// H7 — capture the silent-refresh subscriber so the test can fire it and
// assert the hook only refetches the wsToken when the cached one is near
// expiry (not on every healthy access-token refresh).
vi.mock('./token-refresh-notifier', () => ({
  subscribeTokenRefreshed: (listener: () => void) => {
    tokenRefreshListeners.add(listener);
    return () => tokenRefreshListeners.delete(listener);
  },
  notifyTokenRefreshed: () => undefined,
}));

import { useYjsToken } from './use-yjs-token';
import { act } from '@testing-library/react';

beforeEach(() => {
  getYjsToken.mockReset();
  tokenRefreshListeners.clear();
});

/** Build a `Response`-shaped mock the hook can consume via `response.ok` + `response.json()`. */
function okResponse<T>(body: T): { ok: true; status: number; json: () => Promise<T> } {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}
function errorResponse(status: number, body: unknown): { ok: false; status: number; json: () => Promise<unknown> } {
  return { ok: false, status, json: () => Promise.resolve(body) };
}

function makeWrapper() {
  // Fresh QueryClient per test so query caches don't leak across cases.
  // The hook hard-codes `retry: 3` (network-blip resilience), so we
  // collapse the exponential backoff to 0 ms here — that lets the
  // "error state after exhausted retries" assertion settle within
  // milliseconds without waiting on real timers.
  const client = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe('useYjsToken', () => {
  it('does not fire the request when pageId is null (query disabled)', async () => {
    const { result } = renderHook(() => useYjsToken(null), { wrapper: makeWrapper() });
    // `enabled: false` → react-query never invokes the queryFn.
    expect(getYjsToken).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it('returns the wsToken response when the server responds with 200', async () => {
    const body = {
      wsToken: 'jwt.abc.def',
      pageId: 'page-1',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      readonly: false,
    };
    getYjsToken.mockResolvedValueOnce(okResponse(body));

    const { result } = renderHook(() => useYjsToken('page-1'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getYjsToken).toHaveBeenCalledWith({ param: { id: 'page-1' } });
    expect(result.current.data).toEqual(body);
  });

  it('surfaces an error when the server responds with a non-200 status', async () => {
    // The hook configures `retry: 3` for transient network blips, so
    // we have to satisfy all retry attempts before react-query reaches
    // its terminal error state. `mockResolvedValue` (vs `…Once`)
    // returns the same 500 for every call.
    getYjsToken.mockResolvedValue(errorResponse(500, { error: { message: 'upstream blew up' } }));

    const { result } = renderHook(() => useYjsToken('page-1'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5000 });
    expect(result.current.error).toBeInstanceOf(Error);
    // The hook lifts `error.message` from the response body; on a 500
    // with a `{ error: { message } }` envelope it uses that verbatim.
    expect((result.current.error as Error).message).toBe('upstream blew up');
  });

  it('H7: a silent access-token refresh does NOT refetch the wsToken while the cached one is still valid', async () => {
    const body = {
      wsToken: 'jwt.valid',
      pageId: 'page-h7',
      // Comfortably valid: 5 min out, well past the 30s window.
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      readonly: false,
    };
    getYjsToken.mockResolvedValue(okResponse(body));

    const { result } = renderHook(() => useYjsToken('page-h7'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getYjsToken).toHaveBeenCalledTimes(1);

    // A silent access-token refresh fires. The wsToken is still valid, so
    // the hook must NOT invalidate/refetch (which would rebuild the live
    // provider mid-edit).
    await act(async () => {
      emitTokenRefreshed();
      await Promise.resolve();
    });
    expect(getYjsToken).toHaveBeenCalledTimes(1);
  });

  it('H7: a silent access-token refresh DOES refetch the wsToken when the cached one is (near) expired', async () => {
    const expired = {
      wsToken: 'jwt.expired',
      pageId: 'page-h7b',
      // Already past expiry → recovery is warranted.
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      readonly: false,
    };
    const fresh = { ...expired, wsToken: 'jwt.fresh', expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() };
    getYjsToken.mockResolvedValueOnce(okResponse(expired)).mockResolvedValue(okResponse(fresh));

    const { result } = renderHook(() => useYjsToken('page-h7b'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data?.wsToken).toBe('jwt.expired'));
    expect(getYjsToken).toHaveBeenCalledTimes(1);

    await act(async () => {
      emitTokenRefreshed();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.data?.wsToken).toBe('jwt.fresh'));
    expect(getYjsToken).toHaveBeenCalledTimes(2);
  });

  it('D1a: a connected session past the wsToken TTL does NOT refetch on a coincident access-token refresh', async () => {
    // The token is already (well) expired — under the old logic the
    // notifier-driven refetch would fire on a silent access-token refresh,
    // rebuilding the live provider mid-edit. D1a gates that refetch on "not
    // currently connected": an established WebSocket stays authenticated for
    // its whole life regardless of the wsToken's `exp`, so while `connected`
    // we must NOT refetch even past the TTL.
    const expired = {
      wsToken: 'jwt.expired-but-connected',
      pageId: 'page-d1a',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      readonly: false,
    };
    getYjsToken.mockResolvedValue(okResponse(expired));

    const { result } = renderHook(() => useYjsToken('page-d1a', { getConnectionStatus: () => 'connected' }), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getYjsToken).toHaveBeenCalledTimes(1);

    // A silent access-token refresh fires while the connection is healthy.
    // Even though the cached wsToken is expired, no refetch happens.
    await act(async () => {
      emitTokenRefreshed();
      await Promise.resolve();
    });
    expect(getYjsToken).toHaveBeenCalledTimes(1);
  });

  it('D1a: a NON-connected session past the wsToken TTL DOES refetch on an access-token refresh (recovery path)', async () => {
    // The complement: when the connection is not established (auth-failed /
    // disconnected), an expired wsToken SHOULD be refetched so recovery can
    // (re)connect with a fresh token.
    const expired = {
      wsToken: 'jwt.expired',
      pageId: 'page-d1a2',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      readonly: false,
    };
    const fresh = { ...expired, wsToken: 'jwt.fresh', expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() };
    getYjsToken.mockResolvedValueOnce(okResponse(expired)).mockResolvedValue(okResponse(fresh));

    const { result } = renderHook(() => useYjsToken('page-d1a2', { getConnectionStatus: () => 'auth-failed' }), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data?.wsToken).toBe('jwt.expired'));
    expect(getYjsToken).toHaveBeenCalledTimes(1);

    await act(async () => {
      emitTokenRefreshed();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.data?.wsToken).toBe('jwt.fresh'));
    expect(getYjsToken).toHaveBeenCalledTimes(2);
  });

  it('propagates the readonly bit from the response', async () => {
    const body = {
      wsToken: 'jwt.readonly',
      pageId: 'page-2',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      readonly: true,
    };
    getYjsToken.mockResolvedValueOnce(okResponse(body));

    const { result } = renderHook(() => useYjsToken('page-2'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.readonly).toBe(true);
  });
});
