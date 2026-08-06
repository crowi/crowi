import type { AttachmentMeta } from '@crowi/api-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock `apiClient` (`createClient`) so `getAttachmentMeta` hits our fake.
// The hook calls `apiClient.attachments[':id'].meta.$get(...)` and
// expects a Response-shaped object (`ok` / `status` / `json`).
//
// `acquireRefreshedToken` / `apiBaseUrl` are also re-exported from
// `./api-client` (feature-auth-cookie-fallback-scope) — `useAddAttachment`'s
// hand-rolled multipart `fetch` uses them for the same token-missing
// send-avoidance `apiFetch` uses, so the "useAddAttachment — token-missing
// send-avoidance" suite below controls them directly.
const { metaGet, acquireRefreshedToken, apiBaseUrl } = vi.hoisted(() => ({
  metaGet: vi.fn(),
  acquireRefreshedToken: vi.fn(),
  apiBaseUrl: vi.fn(() => '/api'),
}));
vi.mock('./api-client', () => ({
  apiClient: {
    attachments: {
      ':id': {
        meta: { $get: metaGet },
      },
    },
  },
  acquireRefreshedToken,
  apiBaseUrl,
}));

const { getAccessToken } = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock('./auth-token', () => ({ getAccessToken }));

import { attachmentsKeys, useAddAttachment, useAttachment } from './use-attachments';

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
    url: '/api/attachments/att-1',
    originalUrl: '/api/attachments/att-1/original',
    ...overrides,
  };
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
}

beforeEach(() => {
  metaGet.mockReset();
  acquireRefreshedToken.mockReset();
  getAccessToken.mockReset();
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

/**
 * feature-auth-cookie-fallback-scope AC-3 — `useAddAttachment`'s hand-rolled
 * multipart `fetch` must never go out headerless when no access token is
 * loaded: `POST /pages/:pageId/attachments` is not one of the three
 * headerless attachment delivery routes (`createAttachmentAuth` only accepts
 * the cookie for GET/HEAD by-id / original / by-key), so it recovers a token
 * through the same single-flight refresh `apiFetch` uses, and never calls
 * `fetch` at all when that can't resolve one.
 */
describe('useAddAttachment — token-missing send-avoidance', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const file = new File(['a'.repeat(8)], 'note.png', { type: 'image/png' });

  it('recovers the token through the existing refresh path before uploading, never headerless', async () => {
    getAccessToken.mockReturnValue(null);
    acquireRefreshedToken.mockResolvedValue('fresh-access');
    fetchMock.mockResolvedValue(makeResponse(200, { attachment: makeMeta() }));

    const client = makeClient();
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useAddAttachment('page-1'), { wrapper });

    await act(async () => {
      await result.current.mutateAsync(file);
    });

    expect(acquireRefreshedToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer fresh-access');
  });

  it('fails closed — fetch is never called — when no access token and refresh cannot recover one', async () => {
    getAccessToken.mockReturnValue(null);
    acquireRefreshedToken.mockResolvedValue(null);

    const client = makeClient();
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useAddAttachment('page-1'), { wrapper });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync(file);
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('Authentication is required.');
    expect(acquireRefreshedToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the request with the existing token directly when one is already loaded (unchanged behaviour)', async () => {
    getAccessToken.mockReturnValue('existing-access');
    fetchMock.mockResolvedValue(makeResponse(200, { attachment: makeMeta() }));

    const client = makeClient();
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useAddAttachment('page-1'), { wrapper });

    await act(async () => {
      await result.current.mutateAsync(file);
    });

    expect(acquireRefreshedToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer existing-access');
  });
});
