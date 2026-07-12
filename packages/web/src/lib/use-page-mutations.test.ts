import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';

// Mock `apiClientV2` so the update call hits our fake instead of the network.
const { putPage } = vi.hoisted(() => ({ putPage: vi.fn() }));
vi.mock('./api-client', () => ({
  apiClientV2: { pages: { $put: putPage } },
}));

import { invalidatePageContentQueries, useUpdatePage } from './use-page-mutations';
import { PAGE_LIST_FAMILY_ROOT, pageKeys, revisionsKeys } from './page-query-keys';
import { draftsKeys } from './use-drafts';

beforeEach(() => {
  putPage.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('invalidatePageContentQueries', () => {
  // The portal-staleness bug: a body save invalidated the single-page
  // detail family (`pageKeys.all`) but forgot the list/portal family
  // (`PAGE_LIST_FAMILY_ROOT`), so a portal view (driven by `usePageList` →
  // `pageListKeys`) kept serving the pre-edit revision. This helper is the
  // single source of truth shared by BOTH save paths (realtime
  // `crowi:save` + HTTP `useUpdatePage`) so the set can never drift again.
  // Asserting against the `page-query-keys.ts` registry exports (rather
  // than bare literals) means a future root-string rename fails to
  // compile here instead of silently drifting.
  it('invalidates every query family that reflects a page body change', () => {
    const invalidateQueries = vi.fn();
    invalidatePageContentQueries({ invalidateQueries } as never);

    const keys = invalidateQueries.mock.calls.map((c) => c[0].queryKey);
    expect(keys).toContainEqual(pageKeys.all);
    expect(keys).toContainEqual(PAGE_LIST_FAMILY_ROOT);
    expect(keys).toContainEqual(revisionsKeys.all);
    expect(keys).toContainEqual(draftsKeys.all);
  });
});

describe('useUpdatePage', () => {
  it('invalidates the page-list / portal family on success (regression: portal stayed stale)', async () => {
    putPage.mockResolvedValue({ ok: true, json: async () => ({ page: { _id: 'p1', path: '/some-page/' } }) });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);

    const { result } = renderHook(() => useUpdatePage(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ page_id: 'p1', body: '# updated' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const keys = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(pageKeys.all);
    expect(keys).toContainEqual(PAGE_LIST_FAMILY_ROOT);
  });
});
