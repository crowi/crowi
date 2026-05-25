import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock `apiClientV2` (hc<AppType>) at the module level so the hooks
// read our fake `pages.drafts.*` operations. Vitest hoists `vi.mock`
// above imports; `vi.hoisted` makes the shared stubs reachable from
// both the factory and the test bodies without a TDZ violation.
//
// hc<AppType> returns a `Response`-shaped object, so each fake resolves
// to `{ ok, status, json }` rather than ts-rest's `{ status, body }`.
const { listGet, createPost, cancelDelete } = vi.hoisted(() => ({
  listGet: vi.fn(),
  createPost: vi.fn(),
  cancelDelete: vi.fn(),
}));
vi.mock('./api-client', () => ({
  apiClientV2: {
    pages: {
      drafts: {
        $get: listGet,
        $post: createPost,
        ':id': { $delete: cancelDelete },
      },
    },
  },
}));

import { DraftPathConflictError, draftsKeys, useCancelDraft, useCreateDraft, useDrafts } from './use-drafts';

/** Build a `Response`-shaped object matching what `hc` returns. */
const makeResponse = <T>(status: number, body: T): { ok: boolean; status: number; json: () => Promise<T> } => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  listGet.mockReset();
  createPost.mockReset();
  cancelDelete.mockReset();
});

function makeContext() {
  // Fresh QueryClient per test so caches don't leak across cases.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

const SAMPLE_DRAFTS = [
  { pageId: 'p1', path: '/docs/api', createdAt: '2026-05-16T00:00:00Z', updatedAt: '2026-05-16T00:00:00Z', bodyPreview: '', bodyLength: 0 },
  {
    pageId: 'p2',
    path: '/journal/today',
    createdAt: '2026-05-15T00:00:00Z',
    updatedAt: '2026-05-15T00:00:00Z',
    bodyPreview: 'Today I learned',
    bodyLength: 15,
  },
];

describe('useDrafts', () => {
  it('returns the draft list when the server responds with 200', async () => {
    listGet.mockResolvedValue(makeResponse(200, { drafts: SAMPLE_DRAFTS }));
    const { wrapper } = makeContext();
    const { result } = renderHook(() => useDrafts(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.drafts).toHaveLength(2);
    expect(result.current.data?.drafts[0].path).toBe('/docs/api');
  });

  it('falls back to an empty list on a non-200 (e.g. 401 during refresh)', async () => {
    listGet.mockResolvedValue(makeResponse(401, { error: { message: 'unauthorized' } }));
    const { wrapper } = makeContext();
    const { result } = renderHook(() => useDrafts(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.drafts).toEqual([]);
  });
});

describe('useCreateDraft', () => {
  it('resolves with the new pageId on 201 and invalidates the list', async () => {
    createPost.mockResolvedValue(makeResponse(201, { pageId: 'new-page' }));
    const { client, wrapper } = makeContext();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCreateDraft(), { wrapper });

    let created: { pageId: string } | undefined;
    await act(async () => {
      created = await result.current.mutateAsync({ path: '/docs/new' });
    });

    expect(created).toEqual({ pageId: 'new-page' });
    expect(createPost).toHaveBeenCalledWith({ json: { path: '/docs/new' } });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: draftsKeys.all });
  });

  it('throws DraftPathConflictError carrying the owner on 409', async () => {
    const conflictBody = {
      error: 'path_taken_by_draft' as const,
      owner: { id: 'u9', username: 'yamada', displayName: '山田太郎' },
      message: 'This page is being created by @yamada.',
    };
    createPost.mockResolvedValue(makeResponse(409, conflictBody));
    const { wrapper } = makeContext();
    const { result } = renderHook(() => useCreateDraft(), { wrapper });

    await expect(
      act(async () => {
        await result.current.mutateAsync({ path: '/docs/api' });
      }),
    ).rejects.toBeInstanceOf(DraftPathConflictError);

    // Re-run to inspect the thrown instance's owner payload.
    let caught: unknown;
    try {
      await result.current.mutateAsync({ path: '/docs/api' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DraftPathConflictError);
    expect((caught as DraftPathConflictError).owner).toMatchObject({ username: 'yamada', displayName: '山田太郎' });
  });

  it('throws a plain Error with the server message on 400', async () => {
    createPost.mockResolvedValue(makeResponse(400, { error: 'path_taken', message: 'A page already exists at this path.' }));
    const { wrapper } = makeContext();
    const { result } = renderHook(() => useCreateDraft(), { wrapper });

    let caught: unknown;
    try {
      await result.current.mutateAsync({ path: '/docs/existing' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(DraftPathConflictError);
    expect((caught as Error).message).toBe('A page already exists at this path.');
  });
});

describe('useCancelDraft', () => {
  it('optimistically trims the cancelled row and invalidates on success', async () => {
    cancelDelete.mockResolvedValue(makeResponse(200, { pageId: 'p1' }));
    const { client, wrapper } = makeContext();
    // Seed the drafts cache so the optimistic update has something to trim.
    client.setQueryData(draftsKeys.all, { drafts: SAMPLE_DRAFTS });
    // The optimistic `onMutate` writes the trimmed list via setQueryData;
    // the trailing `onSettled` invalidate would otherwise GC the query.
    const setData = vi.spyOn(client, 'setQueryData');
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCancelDraft(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('p1');
    });

    expect(cancelDelete).toHaveBeenCalledWith({ param: { id: 'p1' }, json: undefined });
    // The optimistic write dropped p1, leaving only p2.
    const optimistic = setData.mock.calls.at(-1)?.[1] as { drafts: typeof SAMPLE_DRAFTS };
    expect(optimistic.drafts.map((d) => d.pageId)).toEqual(['p2']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: draftsKeys.all });
  });

  it('rolls the optimistic removal back when the server rejects', async () => {
    cancelDelete.mockResolvedValue(makeResponse(404, { error: 'draft_not_found', message: 'No such draft' }));
    const { client, wrapper } = makeContext();
    client.setQueryData(draftsKeys.all, { drafts: SAMPLE_DRAFTS });
    // Capture the value `onError` rolls the cache back to, since the
    // trailing `onSettled` invalidate would otherwise GC the query.
    const setData = vi.spyOn(client, 'setQueryData');
    const { result } = renderHook(() => useCancelDraft(), { wrapper });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync('p1');
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    // The hook surfaces a generic "Failed to cancel draft" — the server's
    // `draft_not_found` body is no longer parsed (matches Batch 6 hook).
    expect((caught as Error).message).toBe('Failed to cancel draft');
    // The last setQueryData call is the onError rollback — it restores
    // the pre-mutation snapshot with both rows intact.
    const rollback = setData.mock.calls.at(-1)?.[1] as { drafts: typeof SAMPLE_DRAFTS };
    expect(rollback.drafts.map((d) => d.pageId)).toEqual(['p1', 'p2']);
  });
});
