import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';

// Mock `apiClient` at the module level so the hook reads our fake
// `pageCollab.getYjsToken`. Vitest hoists `vi.mock` calls above
// imports; `vi.hoisted` makes the shared stub accessible from both
// the factory and the test bodies without a TDZ violation.
const { getYjsToken } = vi.hoisted(() => ({ getYjsToken: vi.fn() }));
vi.mock('./api-client', () => ({
  apiClient: {
    pageCollab: {
      getYjsToken,
    },
  },
}));

import { useYjsToken } from './use-yjs-token';

beforeEach(() => {
  getYjsToken.mockReset();
});

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
    getYjsToken.mockResolvedValueOnce({ status: 200, body });

    const { result } = renderHook(() => useYjsToken('page-1'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getYjsToken).toHaveBeenCalledWith({ params: { id: 'page-1' } });
    expect(result.current.data).toEqual(body);
  });

  it('surfaces an error when the server responds with a non-200 status', async () => {
    // The hook configures `retry: 3` for transient network blips, so
    // we have to satisfy all retry attempts before react-query reaches
    // its terminal error state. `mockResolvedValue` (vs `…Once`)
    // returns the same 500 for every call.
    getYjsToken.mockResolvedValue({ status: 500, body: { error: { message: 'upstream blew up' } } });

    const { result } = renderHook(() => useYjsToken('page-1'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5000 });
    expect(result.current.error).toBeInstanceOf(Error);
    // `unwrapResult` falls back to the supplied default message when no
    // per-status spec matches the response code.
    expect((result.current.error as Error).message).toBe('Failed to issue wsToken');
  });

  it('propagates the readonly bit from the response', async () => {
    const body = {
      wsToken: 'jwt.readonly',
      pageId: 'page-2',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      readonly: true,
    };
    getYjsToken.mockResolvedValueOnce({ status: 200, body });

    const { result } = renderHook(() => useYjsToken('page-2'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.readonly).toBe(true);
  });
});
