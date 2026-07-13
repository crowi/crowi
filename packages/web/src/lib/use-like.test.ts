import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';

// Mock `apiClientV2` so the like/unlike calls hit our fake (Batch 4
// switched the hook from ts-rest's `apiClient.page.{like,unlike}Page`
// to `apiClientV2.pages.{like,unlike}.$post`).
const { likePage, unlikePage } = vi.hoisted(() => ({
  likePage: vi.fn(),
  unlikePage: vi.fn(),
}));
vi.mock('./api-client', () => ({
  apiClientV2: { pages: { like: { $post: likePage }, unlike: { $post: unlikePage } } },
}));

// Mock `notify` so we can assert the error toast on revert.
const { notifyError } = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock('./notify', () => ({ notify: { error: notifyError } }));

import { useToggleLike } from './use-like';

interface CachedPageData {
  page: { _id: string; liker?: string[]; likerCount?: number } | null;
  notFound: boolean;
  notGranted: boolean;
}

function makeClient() {
  // Non-zero gcTime so a cache entry without an active observer (the
  // seeded `['page', ...]` data) survives long enough for assertions.
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
}

function seedPage(client: QueryClient, likerCount: number) {
  const data: CachedPageData = {
    page: { _id: 'page-1', liker: [], likerCount },
    notFound: false,
    notGranted: false,
  };
  client.setQueryData(['page', { path: '/docs/example' }], data);
}

beforeEach(() => {
  likePage.mockReset();
  unlikePage.mockReset();
  notifyError.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useToggleLike — optimistic chip count', () => {
  it('optimistically increments likerCount on a like', async () => {
    const client = makeClient();
    seedPage(client, 2);
    // Never-resolving request keeps the mutation pending so we can
    // observe the optimistic patch before `onSettled` reconciles.
    likePage.mockReturnValue(new Promise(() => {}));

    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useToggleLike('page-1', false), { wrapper });

    act(() => result.current.toggle());

    await waitFor(() => {
      const cached = client.getQueryData<CachedPageData>(['page', { path: '/docs/example' }]);
      expect(cached?.page?.likerCount).toBe(3);
    });
  });

  it('optimistically decrements likerCount on an unlike', async () => {
    const client = makeClient();
    seedPage(client, 5);
    unlikePage.mockReturnValue(new Promise(() => {}));

    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useToggleLike('page-1', true), { wrapper });

    act(() => result.current.toggle());

    await waitFor(() => {
      const cached = client.getQueryData<CachedPageData>(['page', { path: '/docs/example' }]);
      expect(cached?.page?.likerCount).toBe(4);
    });
  });

  it('rolls the count back and shows an error toast when the request fails', async () => {
    const client = makeClient();
    seedPage(client, 7);
    likePage.mockResolvedValue({ status: 400, body: { error: { code: 'X', message: 'nope' } } });

    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useToggleLike('page-1', false), { wrapper });

    act(() => result.current.toggle());

    await waitFor(() => expect(result.current.isError).toBe(true));

    // Count is restored to its pre-toggle value.
    const cached = client.getQueryData<CachedPageData>(['page', { path: '/docs/example' }]);
    expect(cached?.page?.likerCount).toBe(7);
    expect(notifyError).toHaveBeenCalledTimes(1);
  });
});
