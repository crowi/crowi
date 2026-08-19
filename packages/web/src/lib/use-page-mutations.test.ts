import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';

// Mock `apiClient` so every mutation call hits our fake instead of the
// network. Each mutation owns its own dedicated fn so a test only needs to
// configure the endpoint(s) it exercises.
const { putPage, putGrant, deletePage, revertPage, renamePage, renameSubtree } = vi.hoisted(() => ({
  putPage: vi.fn(),
  putGrant: vi.fn(),
  deletePage: vi.fn(),
  revertPage: vi.fn(),
  renamePage: vi.fn(),
  renameSubtree: vi.fn(),
}));
vi.mock('./api-client', () => ({
  apiClient: {
    pages: {
      $put: putPage,
      $delete: deletePage,
      grant: { $put: putGrant },
      revert: { $post: revertPage },
      rename: { $post: renamePage },
      'rename-subtree': { $post: renameSubtree },
    },
  },
}));

import {
  invalidatePageContentQueries,
  PageRevisionConflictError,
  useDeletePage,
  useRenamePage,
  useRenameSubtree,
  useRevertDeletedPage,
  useSetPageGrant,
  useUpdatePage,
} from './use-page-mutations';
import { PAGE_LIST_FAMILY_ROOT, pageKeys, revisionsKeys, userPageKeys } from './page-query-keys';
import { draftsKeys } from './use-drafts';

beforeEach(() => {
  putPage.mockReset();
  putGrant.mockReset();
  deletePage.mockReset();
  revertPage.mockReset();
  renamePage.mockReset();
  renameSubtree.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Fresh QueryClient + `invalidateQueries` spy + wrapper, shared by every mutation test below. */
function makeMutationContext() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return { client, invalidateSpy, wrapper };
}

/** True if any `invalidateQueries({ predicate })` call would match a subpages query key — the
 * shape `use-page-mutations.ts`/`use-drafts.ts` use for `userPageKeys.isSubpagesQuery`. */
function wasSubpagesInvalidated(invalidateSpy: { mock: { calls: unknown[][] } }): boolean {
  return invalidateSpy.mock.calls
    .map((call) => (call[0] as { predicate?: (q: { queryKey: readonly unknown[] }) => boolean })?.predicate)
    .filter((predicate): predicate is (q: { queryKey: readonly unknown[] }) => boolean => typeof predicate === 'function')
    .some((predicate) => predicate({ queryKey: userPageKeys.subpagesAll('alice') }));
}

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

  // feature-user-page-subpages-tab — `useUpdatePage` doubles as the `grant`
  // change path (body save + `PUT /pages` also accepts an optional `grant`).
  // Only THAT case should touch the subpages cache; an ordinary body-only
  // save must not pay for a refetch that can't possibly change membership.
  it('invalidates the subpages cache when the mutation variables include `grant`', async () => {
    putPage.mockResolvedValue({ ok: true, json: async () => ({ page: { _id: 'p1', path: '/some-page' } }) });
    const { invalidateSpy, wrapper } = makeMutationContext();

    const { result } = renderHook(() => useUpdatePage(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ page_id: 'p1', body: '# updated', grant: 2 });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(wasSubpagesInvalidated(invalidateSpy)).toBe(true);
  });

  it('does NOT invalidate the subpages cache for a body-only save (no `grant` in variables)', async () => {
    putPage.mockResolvedValue({ ok: true, json: async () => ({ page: { _id: 'p1', path: '/some-page' } }) });
    const { invalidateSpy, wrapper } = makeMutationContext();

    const { result } = renderHook(() => useUpdatePage(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ page_id: 'p1', body: '# updated' });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(wasSubpagesInvalidated(invalidateSpy)).toBe(false);
  });
});

describe('useSetPageGrant — subpages invalidation (feature-user-page-subpages-tab)', () => {
  it('invalidates the subpages cache on success (visibility is exactly what grant controls)', async () => {
    putGrant.mockResolvedValue({ ok: true, json: async () => ({ page: { _id: 'p1', path: '/some-page' } }) });
    const { invalidateSpy, wrapper } = makeMutationContext();

    const { result } = renderHook(() => useSetPageGrant(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ page_id: 'p1', grant: 2 });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(wasSubpagesInvalidated(invalidateSpy)).toBe(true);
  });
});

describe('useDeletePage — subpages invalidation (feature-user-page-subpages-tab)', () => {
  it('invalidates the subpages cache on success (a deleted page must drop out of the listing)', async () => {
    deletePage.mockResolvedValue({ ok: true, json: async () => ({ page: { _id: 'p1', path: '/trash/some-page', status: 'deleted' } }) });
    const { invalidateSpy, wrapper } = makeMutationContext();

    const { result } = renderHook(() => useDeletePage(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ page_id: 'p1' });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(wasSubpagesInvalidated(invalidateSpy)).toBe(true);
  });
});

describe('useRevertDeletedPage — subpages invalidation (feature-user-page-subpages-tab)', () => {
  it('invalidates the subpages cache on success (a restored page reappears in the listing)', async () => {
    revertPage.mockResolvedValue({ ok: true, json: async () => ({ page: { _id: 'p1', path: '/some-page' } }) });
    const { invalidateSpy, wrapper } = makeMutationContext();

    const { result } = renderHook(() => useRevertDeletedPage(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ page_id: 'p1' });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(wasSubpagesInvalidated(invalidateSpy)).toBe(true);
  });
});

describe('useRenamePage — 409 handling (RFC-0021 Phase 2c-2a)', () => {
  it('AC-16: a mid-move 409 is not reported as a revision conflict', async () => {
    // Both arrive as 409, and only one of them means "someone edited
    // underneath you". Reporting a page that is merely being moved with the
    // revision-conflict message would send the user off to reconcile an edit
    // conflict that does not exist.
    renamePage.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'PAGE_TRANSITION_IN_PROGRESS', message: 'server text' } }),
    });
    const { wrapper } = makeMutationContext();

    const { result } = renderHook(() => useRenamePage(), { wrapper });
    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({ page_id: 'p1', new_path: '/renamed', idempotencyKey: 'test-idem-key-0003' });
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(PageRevisionConflictError);
  });

  it('AC-16: a reused idempotency key is likewise distinguished', async () => {
    renamePage.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'IDEMPOTENCY_KEY_CONFLICT', message: 'server text' } }),
    });
    const { wrapper } = makeMutationContext();

    const { result } = renderHook(() => useRenamePage(), { wrapper });
    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({ page_id: 'p1', new_path: '/renamed', idempotencyKey: 'test-idem-key-0004' });
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).not.toBeInstanceOf(PageRevisionConflictError);
  });

  it('a stale revision_id still raises the revision conflict', async () => {
    renamePage.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'PAGE_REVISION_ERROR', message: 'server text' } }),
    });
    const { wrapper } = makeMutationContext();

    const { result } = renderHook(() => useRenamePage(), { wrapper });
    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({ page_id: 'p1', new_path: '/renamed', idempotencyKey: 'test-idem-key-0005' });
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(PageRevisionConflictError);
  });
});

describe('useRenamePage — subpages invalidation via onSettled (feature-user-page-subpages-tab)', () => {
  it('invalidates the subpages cache on a clean success', async () => {
    renamePage.mockResolvedValue({ ok: true, json: async () => ({ page: { _id: 'p1', path: '/renamed' } }) });
    const { invalidateSpy, wrapper } = makeMutationContext();

    const { result } = renderHook(() => useRenamePage(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ page_id: 'p1', new_path: '/renamed', idempotencyKey: 'test-idem-key-0001' });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(wasSubpagesInvalidated(invalidateSpy)).toBe(true);
  });

  it('still invalidates the subpages cache when the subtree rename fails PARTWAY (structured 400, partial: true)', async () => {
    // `renameTree` has no transaction — a mid-way failure can leave some
    // pages already moved while the mutation itself rejects. `onSettled`
    // (not `onSuccess`) is what makes the Subpages tab refetch and converge
    // on that partially-moved membership even on this failure path.
    renamePage.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: { message: 'Some pages could not be moved', conflicts: [{ path: '/renamed/child', reasons: ['path_taken'] }], partial: true },
      }),
    });
    const { invalidateSpy, wrapper } = makeMutationContext();

    const { result } = renderHook(() => useRenamePage(), { wrapper });
    await act(async () => {
      try {
        await result.current.mutateAsync({ page_id: 'p1', new_path: '/renamed', include_descendants: true, idempotencyKey: 'test-idem-key-0002' });
      } catch {
        // expected — the mutation rejects with RenameTreeConflictError
      }
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(wasSubpagesInvalidated(invalidateSpy)).toBe(true);
  });
});

describe('useRenameSubtree — subpages invalidation via onSettled (feature-user-page-subpages-tab)', () => {
  it('invalidates the subpages cache on a clean success', async () => {
    renameSubtree.mockResolvedValue({ ok: true, json: async () => ({ renamed_count: 3 }) });
    const { invalidateSpy, wrapper } = makeMutationContext();

    const { result } = renderHook(() => useRenameSubtree(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ old_path: '/old', new_path: '/new' });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(wasSubpagesInvalidated(invalidateSpy)).toBe(true);
  });

  it('still invalidates the subpages cache when the subtree rename fails PARTWAY (structured 400, partial: true)', async () => {
    renameSubtree.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Some pages could not be moved', conflicts: [{ path: '/new/child', reasons: ['path_taken'] }], partial: true } }),
    });
    const { invalidateSpy, wrapper } = makeMutationContext();

    const { result } = renderHook(() => useRenameSubtree(), { wrapper });
    await act(async () => {
      try {
        await result.current.mutateAsync({ old_path: '/old', new_path: '/new' });
      } catch {
        // expected — the mutation rejects with RenameTreeConflictError
      }
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(wasSubpagesInvalidated(invalidateSpy)).toBe(true);
  });
});
