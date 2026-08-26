import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getHistory } = vi.hoisted(() => ({ getHistory: vi.fn() }));

vi.mock('./api-client', () => ({
  apiClient: { pages: { ':pageId': { history: { $get: getHistory } } } },
}));

import { usePageHistory } from './use-page-history';

afterEach(() => {
  getHistory.mockReset();
});

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe('usePageHistory', () => {
  it('passes the continuation cursor and flattens entries from every fetched page', async () => {
    getHistory
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          entries: [
            {
              id: 'event-1',
              type: 'page_event',
              kind: 'page_renamed',
              payload: {},
              operationId: null,
              sequence: 2,
              occurredAt: '2026-08-20T00:00:00.000Z',
              actor: null,
            },
          ],
          nextCursor: 'cursor-2',
          tracking: { state: 'ready', trackingStartedAt: '2026-08-20T00:00:00.000Z' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          entries: [{ id: 'content-1', type: 'content_revision', revisionId: 'revision-1', sequence: 1, occurredAt: '2026-08-19T00:00:00.000Z', actor: null }],
          nextCursor: null,
          tracking: { state: 'ready', trackingStartedAt: '2026-08-20T00:00:00.000Z' },
        }),
      });

    const { result } = renderHook(() => usePageHistory('page-1'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.entries.map((entry) => entry.id)).toEqual(['event-1']));

    act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.entries.map((entry) => entry.id)).toEqual(['event-1', 'content-1']));

    expect(getHistory).toHaveBeenNthCalledWith(1, { param: { pageId: 'page-1' }, query: {} });
    expect(getHistory).toHaveBeenNthCalledWith(2, { param: { pageId: 'page-1' }, query: { cursor: 'cursor-2' } });
  });
});
