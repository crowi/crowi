import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';
import type { AttachmentMeta } from '@crowi/api-contract';

// Mock `apiClient` so `getAttachmentMeta` hits our fake.
const { getAttachmentMeta } = vi.hoisted(() => ({ getAttachmentMeta: vi.fn() }));
vi.mock('./api-client', () => ({
  apiClient: { attachment: { getAttachmentMeta } },
}));

import { useAttachment, attachmentsKeys } from './use-attachments';

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
  getAttachmentMeta.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useAttachment', () => {
  it('fetches and returns attachment metadata for an id', async () => {
    getAttachmentMeta.mockResolvedValue({ status: 200, body: makeMeta() });
    const client = makeClient();
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);

    const { result } = renderHook(() => useAttachment('att-1'), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?._id).toBe('att-1');
    expect(getAttachmentMeta).toHaveBeenCalledWith({ params: { id: 'att-1' } });
  });

  it('is disabled (no fetch) when id is undefined', () => {
    const client = makeClient();
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);

    const { result } = renderHook(() => useAttachment(undefined), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getAttachmentMeta).not.toHaveBeenCalled();
  });

  it('caches by attachmentsKeys.detail(id) so repeated refs fetch once', async () => {
    getAttachmentMeta.mockResolvedValue({ status: 200, body: makeMeta() });
    const client = makeClient();
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);

    const first = renderHook(() => useAttachment('att-1'), { wrapper });
    await waitFor(() => expect(first.result.current.data).toBeDefined());

    // A second consumer of the same id reads the warm cache, no extra fetch.
    const second = renderHook(() => useAttachment('att-1'), { wrapper });
    await waitFor(() => expect(second.result.current.data).toBeDefined());

    expect(getAttachmentMeta).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(attachmentsKeys.detail('att-1'))).toBeDefined();
  });

  it('surfaces an error when the endpoint returns a non-200 status', async () => {
    getAttachmentMeta.mockResolvedValue({ status: 404, body: { error: { code: 'ATTACHMENT_NOT_FOUND', message: 'nope' } } });
    const client = makeClient();
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);

    const { result } = renderHook(() => useAttachment('missing'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
  });
});
