import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';

// Mock `apiClient` so the claim call hits our fake instead of the network.
const { claimLinkAccess } = vi.hoisted(() => ({ claimLinkAccess: vi.fn() }));
vi.mock('./api-client', () => ({
  apiClient: { pages: { 'link-access': { $post: claimLinkAccess } } },
}));

import { useClaimPageLinkAccess } from './use-claim-page-link-access';

// GRANT_RESTRICTED === 2 (PageGrantEnum), GRANT_PUBLIC === 1 — see
// `@crowi/api-contract`'s schemas/page.ts.
const RESTRICTED_PAGE = { _id: 'p1', path: '/shared/example', grant: 2, status: null };
const PUBLIC_PAGE = { _id: 'p2', path: '/public/example', grant: 1, status: null };

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return wrapper;
}

beforeEach(() => {
  claimLinkAccess.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useClaimPageLinkAccess', () => {
  it('resolves a granted GRANT_RESTRICTED claim and invalidates the affected query families', async () => {
    claimLinkAccess.mockResolvedValue({
      status: 200,
      json: async () => ({ page: RESTRICTED_PAGE, granted: true }),
    });

    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useClaimPageLinkAccess('p1'), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.page).toEqual(RESTRICTED_PAGE));

    expect(claimLinkAccess).toHaveBeenCalledWith({ json: { page_id: 'p1' } });
    const keys = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(['page', { path: '/shared/example' }]);
    expect(keys).toContainEqual(['pages', 'list']);
    expect(keys).toContainEqual(['search']);
    expect(keys).toContainEqual(['pages', 'children']);
  });

  it('does not invalidate any query family on a public pass-through resolution', async () => {
    claimLinkAccess.mockResolvedValue({
      status: 200,
      json: async () => ({ page: PUBLIC_PAGE, granted: false }),
    });

    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useClaimPageLinkAccess('p2'), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.page).toEqual(PUBLIC_PAGE));

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('surfaces a 404 as notFound', async () => {
    claimLinkAccess.mockResolvedValue({ status: 404, json: async () => ({}) });

    const client = makeClient();
    const { result } = renderHook(() => useClaimPageLinkAccess('missing'), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.notFound).toBe(true));
    expect(result.current.page).toBeNull();
    expect(result.current.notGranted).toBe(false);
  });

  it('surfaces a 403 as notGranted', async () => {
    claimLinkAccess.mockResolvedValue({ status: 403, json: async () => ({}) });

    const client = makeClient();
    const { result } = renderHook(() => useClaimPageLinkAccess('denied'), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.notGranted).toBe(true));
    expect(result.current.page).toBeNull();
    expect(result.current.notFound).toBe(false);
  });

  it('surfaces a 429 (rate limited) as a generic error, not a dedicated branch', async () => {
    claimLinkAccess.mockResolvedValue({
      status: 429,
      json: async () => ({ error: 'rate_limited', message: 'slow down', retryAfterSeconds: 30 }),
    });

    const client = makeClient();
    const { result } = renderHook(() => useClaimPageLinkAccess('rate-limited'), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.notFound).toBe(false);
    expect(result.current.notGranted).toBe(false);
  });

  it('re-issues POST /pages/link-access on every mount for the same pageId (no stale cache reuse)', async () => {
    claimLinkAccess.mockResolvedValue({
      status: 200,
      json: async () => ({ page: RESTRICTED_PAGE, granted: false }),
    });

    const client = makeClient();
    const wrapper = wrapperFor(client);

    const first = renderHook(() => useClaimPageLinkAccess('p1'), { wrapper });
    await waitFor(() => expect(first.result.current.page).toEqual(RESTRICTED_PAGE));
    expect(claimLinkAccess).toHaveBeenCalledTimes(1);

    first.unmount();

    const second = renderHook(() => useClaimPageLinkAccess('p1'), { wrapper });
    await waitFor(() => expect(second.result.current.page).toEqual(RESTRICTED_PAGE));
    expect(claimLinkAccess).toHaveBeenCalledTimes(2);
  });

  it('does not refetch on a window focus event (refetchOnWindowFocus disabled)', async () => {
    claimLinkAccess.mockResolvedValue({ status: 403, json: async () => ({}) });

    const client = makeClient();
    const { result } = renderHook(() => useClaimPageLinkAccess('denied'), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.notGranted).toBe(true));
    expect(claimLinkAccess).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    // No extra tick should trigger a second POST.
    await Promise.resolve();
    expect(claimLinkAccess).toHaveBeenCalledTimes(1);
  });
});
