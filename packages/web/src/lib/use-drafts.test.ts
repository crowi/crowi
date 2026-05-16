import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';

// Mock `apiClient` at the module level so the hooks read our fake
// `draft.*` operations. Vitest hoists `vi.mock` above imports;
// `vi.hoisted` makes the shared stubs reachable from both the factory
// and the test bodies without a TDZ violation.
const { listDrafts, createDraft, cancelDraft } = vi.hoisted(() => ({
  listDrafts: vi.fn(),
  createDraft: vi.fn(),
  cancelDraft: vi.fn(),
}));
vi.mock('./api-client', () => ({
  apiClient: {
    draft: { listDrafts, createDraft, cancelDraft },
  },
}));

import { DraftPathConflictError, draftsKeys, useCancelDraft, useCreateDraft, useDrafts } from './use-drafts';

beforeEach(() => {
  listDrafts.mockReset();
  createDraft.mockReset();
  cancelDraft.mockReset();
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
  { pageId: 'p1', path: '/docs/api', createdAt: '2026-05-16T00:00:00Z', updatedAt: '2026-05-16T00:00:00Z' },
  { pageId: 'p2', path: '/journal/today', createdAt: '2026-05-15T00:00:00Z', updatedAt: '2026-05-15T00:00:00Z' },
];

describe('useDrafts', () => {
  it('returns the draft list when the server responds with 200', async () => {
    listDrafts.mockResolvedValue({ status: 200, body: { drafts: SAMPLE_DRAFTS } });
    const { wrapper } = makeContext();
    const { result } = renderHook(() => useDrafts(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.drafts).toHaveLength(2);
    expect(result.current.data?.drafts[0].path).toBe('/docs/api');
  });

  it('falls back to an empty list on a non-200 (e.g. 401 during refresh)', async () => {
    listDrafts.mockResolvedValue({ status: 401, body: { error: { message: 'unauthorized' } } });
    const { wrapper } = makeContext();
    const { result } = renderHook(() => useDrafts(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.drafts).toEqual([]);
  });
});

describe('useCreateDraft', () => {
  it('resolves with the new pageId on 201 and invalidates the list', async () => {
    createDraft.mockResolvedValue({ status: 201, body: { pageId: 'new-page' } });
    const { client, wrapper } = makeContext();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCreateDraft(), { wrapper });

    let created: { pageId: string } | undefined;
    await act(async () => {
      created = await result.current.mutateAsync({ path: '/docs/new' });
    });

    expect(created).toEqual({ pageId: 'new-page' });
    expect(createDraft).toHaveBeenCalledWith({ body: { path: '/docs/new' } });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: draftsKeys.all });
  });

  it('throws DraftPathConflictError carrying the owner on 409', async () => {
    createDraft.mockResolvedValue({
      status: 409,
      body: {
        error: 'path_taken_by_draft',
        owner: { id: 'u9', username: 'yamada', displayName: '山田太郎' },
        message: 'This page is being created by @yamada.',
      },
    });
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
    createDraft.mockResolvedValue({ status: 400, body: { error: 'path_taken', message: 'A page already exists at this path.' } });
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
    cancelDraft.mockResolvedValue({ status: 200, body: { pageId: 'p1' } });
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

    expect(cancelDraft).toHaveBeenCalledWith({ params: { id: 'p1' }, body: undefined });
    // The optimistic write dropped p1, leaving only p2.
    const optimistic = setData.mock.calls.at(-1)?.[1] as { drafts: typeof SAMPLE_DRAFTS };
    expect(optimistic.drafts.map((d) => d.pageId)).toEqual(['p2']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: draftsKeys.all });
  });

  it('rolls the optimistic removal back when the server rejects', async () => {
    cancelDraft.mockResolvedValue({ status: 404, body: { error: 'draft_not_found', message: 'No such draft' } });
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
    expect((caught as Error).message).toBe('No such draft');
    // The last setQueryData call is the onError rollback — it restores
    // the pre-mutation snapshot with both rows intact.
    const rollback = setData.mock.calls.at(-1)?.[1] as { drafts: typeof SAMPLE_DRAFTS };
    expect(rollback.drafts.map((d) => d.pageId)).toEqual(['p1', 'p2']);
  });
});
