import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';
import type { AttachmentMeta } from '@crowi/api-contract';

// Mock `apiClientV2` (`createClient`) so `getAttachmentMeta` hits our fake.
// The hook calls `apiClientV2.attachments[':id'].meta.$get(...)` and
// expects a Response-shaped object (`ok` / `status` / `json`).
const { metaGet } = vi.hoisted(() => ({ metaGet: vi.fn() }));
vi.mock('./api-client', () => ({
  apiClientV2: {
    attachments: {
      ':id': {
        meta: { $get: metaGet },
      },
    },
  },
}));

import { useAttachment, attachmentsKeys } from './use-attachments';

/** Build a `Response`-shaped object matching what `hc` returns. */
const makeResponse = <T>(status: number, body: T) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function makeMeta(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    _id: 'att-1',
    page: 'page-1',
    creator: { _id: 'u1', username: 'alice', name: 'Alice', email: 'a@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
    filePath: 'attachment/page-1/att-1.png',
    fileName: 'att-1.png',
    originalName: 'diagram.png',
    fileFormat: 'image/png',
    fileSize: 2048,
    createdAt: '2026-05-01T09:30:00.000Z',
    url: '/api/v2/attachments/att-1',
    ...overrides,
  };
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
}

beforeEach(() => {
  metaGet.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useAttachment', () => {
  it('fetches and returns attachment metadata for an id', async () => {
    metaGet.mockResolvedValue(makeResponse(200, makeMeta()));
    const client = makeClient();
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);

    const { result } = renderHook(() => useAttachment('att-1'), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?._id).toBe('att-1');
    expect(metaGet).toHaveBeenCalledWith({ param: { id: 'att-1' } });
  });

  it('is disabled (no fetch) when id is undefined', () => {
    const client = makeClient();
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);

    const { result } = renderHook(() => useAttachment(undefined), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(metaGet).not.toHaveBeenCalled();
  });

  it('caches by attachmentsKeys.detail(id) so repeated refs fetch once', async () => {
    metaGet.mockResolvedValue(makeResponse(200, makeMeta()));
    const client = makeClient();
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);

    const first = renderHook(() => useAttachment('att-1'), { wrapper });
    await waitFor(() => expect(first.result.current.data).toBeDefined());

    // A second consumer of the same id reads the warm cache, no extra fetch.
    const second = renderHook(() => useAttachment('att-1'), { wrapper });
    await waitFor(() => expect(second.result.current.data).toBeDefined());

    expect(metaGet).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(attachmentsKeys.detail('att-1'))).toBeDefined();
  });

  it('surfaces an error when the endpoint returns a non-200 status', async () => {
    metaGet.mockResolvedValue(makeResponse(404, { error: { code: 'ATTACHMENT_NOT_FOUND', message: 'nope' } }));
    const client = makeClient();
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);

    const { result } = renderHook(() => useAttachment('missing'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
  });
});
