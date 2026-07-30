import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock `apiClient` (`createClient`) at the module level, same pattern as
// `use-drafts.test.ts` — the hooks read our fake `user[':username'].subpages`
// operation. `vi.hoisted` makes the shared stub reachable from both the
// factory and the test bodies without a TDZ violation.
const { subpagesGet } = vi.hoisted(() => ({ subpagesGet: vi.fn() }));
vi.mock('./api-client', () => ({
  apiClient: {
    user: {
      ':username': {
        subpages: { $get: subpagesGet },
      },
    },
  },
}));

import { userPageKeys } from './page-query-keys';
import { makeApiResponse } from './test-utils/mocks';
import { useUserSubpages, useUserSubpagesInfinite } from './use-user-page';

beforeEach(() => {
  subpagesGet.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

/** A fresh QueryClient with the SAME 60s default `staleTime` the real app
 * uses (`providers.tsx`) — so a passing "always refetches on remount" test
 * actually demonstrates the `refetchOnMount: 'always'` override, not an
 * accidental cache-miss from a short/zero staleTime. */
function makeContext() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60 * 1000 } } });
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

const PAGE_A = {
  pages: [{ _id: 'a1', path: '/user/alice/a', commentCount: 0, createdAt: '2026-01-01T00:00:00Z' }],
  pager: { prev: null, next: null, offset: 0 },
  total: 1,
};
const PAGE_B = {
  pages: [{ _id: 'b1', path: '/user/alice/b', commentCount: 0, createdAt: '2026-01-01T00:00:00Z' }],
  pager: { prev: null, next: null, offset: 0 },
  total: 1,
};

describe('useUserSubpages', () => {
  it('sends limit/offset as string query params and resolves the pages/pager/total payload', async () => {
    subpagesGet.mockResolvedValue(makeApiResponse(200, PAGE_A));
    const { wrapper } = makeContext();

    const { result } = renderHook(() => useUserSubpages('alice', { limit: 10, offset: 0 }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(PAGE_A);
    expect(subpagesGet).toHaveBeenCalledWith(
      { param: { username: 'alice' }, query: { limit: '10', offset: '0' } },
      expect.objectContaining({ init: expect.anything() }),
    );
  });

  it('converts a 404 into a "User not found" error, and 401 into "Authentication required"', async () => {
    subpagesGet.mockResolvedValueOnce(makeApiResponse(404, { error: { code: 'USER_NOT_FOUND', message: 'User not found' } }));
    const { wrapper: wrapper404 } = makeContext();
    const { result: notFound } = renderHook(() => useUserSubpages('ghost'), { wrapper: wrapper404 });
    await waitFor(() => expect(notFound.current.isError).toBe(true));
    expect(notFound.current.error).toBeInstanceOf(Error);
    expect((notFound.current.error as Error).message).toBe('User not found');

    subpagesGet.mockResolvedValueOnce(makeApiResponse(401, { error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' } }));
    const { wrapper: wrapper401 } = makeContext();
    const { result: unauth } = renderHook(() => useUserSubpages('alice'), { wrapper: wrapper401 });
    await waitFor(() => expect(unauth.current.isError).toBe(true));
    expect((unauth.current.error as Error).message).toBe('Authentication required');
  });

  it("forwards the queryFn AbortSignal through to $get's init.signal", async () => {
    subpagesGet.mockResolvedValue(makeApiResponse(200, PAGE_A));
    const { wrapper } = makeContext();

    const { result } = renderHook(() => useUserSubpages('alice'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [, options] = subpagesGet.mock.calls[0];
    expect(options.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refetchOnMount: 'always' re-fetches on remount even though the 60s default staleTime hasn't elapsed — the tab-reopen-is-authoritative contract", async () => {
    const { client, wrapper } = makeContext();
    const params = { limit: 10, offset: 0 };

    subpagesGet.mockResolvedValueOnce(makeApiResponse(200, PAGE_A));
    const first = renderHook(() => useUserSubpages('alice', params), { wrapper });
    await waitFor(() => expect(first.result.current.data).toEqual(PAGE_A));

    // Unmount (simulates the Subpages `TabsContent` unmounting when the tab
    // closes) — the cached entry is still well within its 60s staleTime.
    first.unmount();

    // Another client renamed/deleted/granted a subpage in the meantime;
    // remounting must pick that up immediately rather than serving the
    // still-fresh cached `PAGE_A`.
    subpagesGet.mockResolvedValueOnce(makeApiResponse(200, PAGE_B));
    const second = renderHook(() => useUserSubpages('alice', params), { wrapper });
    await waitFor(() => expect(second.result.current.data).toEqual(PAGE_B));

    expect(subpagesGet).toHaveBeenCalledTimes(2);
    // Sanity: the query was actually cached (same key), so a mount-time
    // refetch is the only way the second render could see fresh data.
    expect(client.getQueryData(userPageKeys.subpagesDetail('alice', params))).toEqual(PAGE_B);
  });
});

describe('useUserSubpagesInfinite', () => {
  it('paginates via pager.next and forwards the AbortSignal on every page fetch', async () => {
    subpagesGet.mockResolvedValueOnce(makeApiResponse(200, { pages: [PAGE_A.pages[0]], pager: { prev: null, next: 10, offset: 0 }, total: 2 }));
    subpagesGet.mockResolvedValueOnce(makeApiResponse(200, { pages: [PAGE_B.pages[0]], pager: { prev: 0, next: null, offset: 10 }, total: 2 }));
    const { wrapper } = makeContext();

    const { result } = renderHook(() => useUserSubpagesInfinite('alice', 10), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));

    expect(result.current.data?.pages).toHaveLength(2);
    expect(subpagesGet).toHaveBeenCalledTimes(2);
    for (const call of subpagesGet.mock.calls) {
      const [, options] = call;
      expect(options.init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("refetchOnMount: 'always' re-fetches the first page on remount", async () => {
    const { wrapper } = makeContext();

    subpagesGet.mockResolvedValueOnce(makeApiResponse(200, PAGE_A));
    const first = renderHook(() => useUserSubpagesInfinite('alice', 10), { wrapper });
    await waitFor(() => expect(first.result.current.data?.pages[0]).toEqual(PAGE_A));
    first.unmount();

    subpagesGet.mockResolvedValueOnce(makeApiResponse(200, PAGE_B));
    const second = renderHook(() => useUserSubpagesInfinite('alice', 10), { wrapper });
    await waitFor(() => expect(second.result.current.data?.pages[0]).toEqual(PAGE_B));

    expect(subpagesGet).toHaveBeenCalledTimes(2);
  });
});
