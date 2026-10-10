import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';
import { m } from '@paraglide/messages.js';
import { overwriteGetLocale } from '@paraglide/runtime.js';

// Mock `apiClient` so every mutation call hits our fake instead of the
// network. Each mutation owns its own dedicated fn so a test only needs to
// configure the endpoint(s) it exercises.
const { putPage, putGrant, deletePage, revertPage, revertToRevision, renamePage, renameSubtree } = vi.hoisted(() => ({
  putPage: vi.fn(),
  putGrant: vi.fn(),
  deletePage: vi.fn(),
  revertPage: vi.fn(),
  revertToRevision: vi.fn(),
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
      'revert-to-revision': { $post: revertToRevision },
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
  useRevertToRevision,
  useSetPageGrant,
  useUpdatePage,
} from './use-page-mutations';
import { PAGE_LIST_FAMILY_ROOT, pageHistoryKeys, pageKeys, userPageKeys } from './page-query-keys';
import { draftsKeys } from './use-drafts';

beforeEach(() => {
  putPage.mockReset();
  putGrant.mockReset();
  deletePage.mockReset();
  revertPage.mockReset();
  revertToRevision.mockReset();
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

function wasQueryKeyInvalidated(invalidateSpy: { mock: { calls: unknown[][] } }, queryKey: readonly unknown[]): boolean {
  return invalidateSpy.mock.calls.some((call) => {
    const invalidated = (call[0] as { queryKey?: readonly unknown[] } | undefined)?.queryKey;
    return invalidated != null && JSON.stringify(invalidated) === JSON.stringify(queryKey);
  });
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
    expect(keys).toContainEqual(pageHistoryKeys.all);
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
    expect(wasQueryKeyInvalidated(invalidateSpy, pageHistoryKeys.all)).toBe(true);
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
    expect(wasQueryKeyInvalidated(invalidateSpy, pageHistoryKeys.all)).toBe(true);
  });
});

describe('useSetPageGrant — cache sync and invalidation', () => {
  const detail = (params: Record<string, unknown>) => pageKeys.detail(params as never);
  const seedPage = (extra: Record<string, unknown> = {}) => ({
    page: { _id: 'p1', path: '/a', grant: 1, grantedUsers: ['x'], status: 'published', revision: { _id: 'r1', body: 'BODY' }, ...extra },
    notFound: false,
    notGranted: false,
  });
  const okGrant = (grant: number, grantedUsers: string[]) => ({
    ok: true,
    status: 200,
    json: async () => ({ page: { _id: 'p1', path: '/a', grant, grantedUsers, revision: { _id: 'r-other', body: 'DIFFERENT' }, status: 'wip' } }),
  });

  it('writes only grant / grantedUsers from the response into current detail entries of the same page', async () => {
    putGrant.mockResolvedValue(okGrant(4, ['u1']));
    const { client, wrapper } = makeMutationContext();
    const byPath = detail({ path: '/a' });
    const byId = detail({ page_id: 'p1' });
    const pinned = detail({ page_id: 'p1', revision_id: 'r0' });
    const otherPage = detail({ path: '/b' });
    const nullPage = detail({ path: '/missing' });
    client.setQueryData(byPath, seedPage());
    client.setQueryData(byId, seedPage());
    client.setQueryData(pinned, seedPage({ revision: { _id: 'r0', body: 'OLD' } }));
    client.setQueryData(otherPage, seedPage({ _id: 'p2' }));
    client.setQueryData(nullPage, { page: null, notFound: true, notGranted: false });
    const history = pageHistoryKeys.timeline('p1');
    client.setQueryData(history, { events: [] });

    const { result } = renderHook(() => useSetPageGrant(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ page_id: 'p1', grant: 4 });
    });

    for (const key of [byPath, byId]) {
      const data = client.getQueryData<ReturnType<typeof seedPage>>(key)!;
      expect(data.page.grant).toBe(4);
      expect(data.page.grantedUsers).toEqual(['u1']);
      expect(data.page.revision).toEqual({ _id: 'r1', body: 'BODY' });
      expect(data.page.status).toBe('published');
    }
    expect(client.getQueryData<ReturnType<typeof seedPage>>(pinned)!.page.grant).toBe(1);
    expect(client.getQueryData<ReturnType<typeof seedPage>>(otherPage)!.page.grant).toBe(1);
    expect(client.getQueryData<{ page: null }>(nullPage)!.page).toBeNull();
    expect(client.getQueryData(history)).toEqual({ events: [] });
  });

  it('invalidates page / list / history / subpages and every user pages & bookmarks family, but not the whole user root', async () => {
    putGrant.mockResolvedValue(okGrant(2, ['u1']));
    const { invalidateSpy, wrapper } = makeMutationContext();
    const { result } = renderHook(() => useSetPageGrant(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ page_id: 'p1', grant: 2 });
    });

    expect(wasQueryKeyInvalidated(invalidateSpy, pageKeys.all)).toBe(true);
    expect(wasQueryKeyInvalidated(invalidateSpy, PAGE_LIST_FAMILY_ROOT)).toBe(true);
    expect(wasQueryKeyInvalidated(invalidateSpy, pageHistoryKeys.all)).toBe(true);
    expect(wasSubpagesInvalidated(invalidateSpy)).toBe(true);

    const predicates = invalidateSpy.mock.calls
      .map((call) => (call[0] as { predicate?: (q: { queryKey: readonly unknown[] }) => boolean })?.predicate)
      .filter((p): p is (q: { queryKey: readonly unknown[] }) => boolean => typeof p === 'function');
    const matches = (queryKey: readonly unknown[]) => predicates.some((p) => p({ queryKey }));
    expect(matches(userPageKeys.pagesAll('alice'))).toBe(true);
    expect(matches(userPageKeys.pagesDetail('bob', { page: 1, limit: 5 } as never))).toBe(true);
    expect(matches(userPageKeys.pagesInfinite('bob', 20))).toBe(true);
    expect(matches(userPageKeys.bookmarksAll('alice'))).toBe(true);
    expect(matches(userPageKeys.bookmarksInfinite('bob', 20))).toBe(true);
    expect(matches(userPageKeys.profile('alice'))).toBe(false);
    expect(wasQueryKeyInvalidated(invalidateSpy, ['user'])).toBe(false);
  });

  it('keeps the saved value in the cache when the follow-up GET fails (the failure is not the PUT failing)', async () => {
    putGrant.mockResolvedValue(okGrant(4, ['u1']));
    const { client, wrapper } = makeMutationContext();
    const key = detail({ path: '/a' });
    client.setQueryData(key, seedPage());
    const refetch = vi.fn().mockRejectedValue(new Error('GET failed'));
    client.setQueryDefaults(pageKeys.all, { queryFn: refetch });

    const { result } = renderHook(() => useSetPageGrant(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ page_id: 'p1', grant: 4 });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData<ReturnType<typeof seedPage>>(key)!.page.grant).toBe(4);
  });

  it.each([400, 401, 403, 404, 500])('%i fails with a fixed message and touches no cache (no invalidate, no retry)', async (status) => {
    putGrant.mockResolvedValue({ ok: false, status, json: async () => ({ error: { message: 'raw body' } }) });
    const { client, invalidateSpy, wrapper } = makeMutationContext();
    const key = detail({ path: '/a' });
    client.setQueryData(key, seedPage());
    const { result } = renderHook(() => useSetPageGrant(), { wrapper });

    let caught: Error | undefined;
    await act(async () => {
      try {
        await result.current.mutateAsync({ page_id: 'p1', grant: 4 });
      } catch (err) {
        caught = err as Error;
      }
    });

    expect(caught?.message).toBe(status === 404 ? m['errors.page_not_found']() : m['edit.grant_update_failed']());
    expect(putGrant).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(client.getQueryData<ReturnType<typeof seedPage>>(key)!.page.grant).toBe(1);
  });

  it('maps a network exception to the fixed message', async () => {
    putGrant.mockRejectedValue(new TypeError('ECONNRESET 10.1.2.3'));
    const { wrapper } = makeMutationContext();
    const { result } = renderHook(() => useSetPageGrant(), { wrapper });
    let caught: Error | undefined;
    await act(async () => {
      try {
        await result.current.mutateAsync({ page_id: 'p1', grant: 4 });
      } catch (err) {
        caught = err as Error;
      }
    });
    expect(caught?.message).toBe(m['edit.grant_update_failed']());
    expect(putGrant).toHaveBeenCalledTimes(1);
  });

  it('still syncs the cache after the sending component unmounted', async () => {
    let finish: () => void = () => {};
    putGrant.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(okGrant(4, ['u1']));
        }),
    );
    const { client, invalidateSpy, wrapper } = makeMutationContext();
    const key = detail({ path: '/a' });
    client.setQueryData(key, seedPage());
    const { result, unmount } = renderHook(() => useSetPageGrant(), { wrapper });
    await act(async () => {
      void result.current.mutateAsync({ page_id: 'p1', grant: 4 }).catch(() => {});
    });
    await waitFor(() => expect(putGrant).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => finish());

    await waitFor(() => expect(client.getQueryData<ReturnType<typeof seedPage>>(key)!.page.grant).toBe(4));
    expect(wasQueryKeyInvalidated(invalidateSpy, pageHistoryKeys.all)).toBe(true);
  });
});

describe('useDeletePage — subpages invalidation (feature-user-page-subpages-tab)', () => {
  it('invalidates the subpages cache on success (a deleted page must drop out of the listing)', async () => {
    deletePage.mockResolvedValue({ ok: true, json: async () => ({ page: { _id: 'p1', path: '/trash/some-page', status: 'deleted' } }) });
    const { invalidateSpy, wrapper } = makeMutationContext();

    const { result } = renderHook(() => useDeletePage(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ page_id: 'p1', idempotencyKey: 'test-idem-key-0006' });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(wasSubpagesInvalidated(invalidateSpy)).toBe(true);
    expect(wasQueryKeyInvalidated(invalidateSpy, pageHistoryKeys.all)).toBe(true);
  });
});

describe('useRevertDeletedPage — subpages invalidation (feature-user-page-subpages-tab)', () => {
  it('invalidates the subpages cache on success (a restored page reappears in the listing)', async () => {
    revertPage.mockResolvedValue({ ok: true, json: async () => ({ page: { _id: 'p1', path: '/some-page' } }) });
    const { invalidateSpy, wrapper } = makeMutationContext();

    const { result } = renderHook(() => useRevertDeletedPage(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ page_id: 'p1', idempotencyKey: 'test-idem-key-0007' });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(wasSubpagesInvalidated(invalidateSpy)).toBe(true);
    expect(wasQueryKeyInvalidated(invalidateSpy, pageHistoryKeys.all)).toBe(true);
  });
});

describe('useRevertToRevision — artifact rejection (AC-AAG-7, C-6)', () => {
  const rejection = {
    error: {
      code: 'ARTIFACT_WRITE_REJECTED',
      reason: 'EXTERNAL_REFERENCE',
      ruleId: 'AI-R11',
      diagnosticCode: 'PAGE_LINK_RESERVED_ROUTE',
      message: 'fixed reserved-route guidance',
      target: 'a[href]',
    },
  };

  async function revertError(response: unknown): Promise<unknown> {
    revertToRevision.mockResolvedValue(response);
    const { wrapper } = makeMutationContext();
    const { result } = renderHook(() => useRevertToRevision(), { wrapper });
    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({ page_id: 'p1', revision_id: 'r1' });
      } catch (err) {
        caught = err;
      }
    });
    return caught;
  }

  it.each([
    ['en', 'Use MCP or CLI to retrieve the revision body'],
    ['ja', 'MCP または CLI でその版の本文を取得'],
  ] as const)('keeps the fixed reason and the MCP / CLI recovery guidance (%s)', async (locale, recovery) => {
    overwriteGetLocale(() => locale);
    const caught = await revertError({ ok: false, status: 400, json: async () => rejection });
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain(recovery);
    expect(message).toContain('fixed reserved-route guidance');
    expect(message).not.toBe('Failed to restore the page.');
  });

  it('keeps the page-not-found message for a 404', async () => {
    overwriteGetLocale(() => 'en');
    const caught = await revertError({ ok: false, status: 404, json: async () => ({ error: { code: 'PAGE_NOT_FOUND', message: 'x' } }) });
    expect((caught as Error).message).not.toContain('fixed');
    expect((caught as Error).message).not.toContain('MCP');
  });

  it.each([
    ['another 400 code', { ok: false, status: 400, json: async () => ({ error: { code: 'VALIDATION_ERROR', message: 'bad' } }) }],
    ['an unreadable 400 body', { ok: false, status: 400, json: async () => Promise.reject(new Error('not json')) }],
    ['a 500', { ok: false, status: 500, json: async () => rejection }],
  ])('falls back to the generic revert failure for %s', async (_label, response) => {
    overwriteGetLocale(() => 'en');
    const caught = await revertError(response);
    expect((caught as Error).message).toBe('Failed to restore the page.');
  });

  it('invalidates page, list and history caches on success', async () => {
    revertToRevision.mockResolvedValue({ ok: true, json: async () => ({ page: { _id: 'p1', path: '/x' } }) });
    const { invalidateSpy, wrapper } = makeMutationContext();
    const { result } = renderHook(() => useRevertToRevision(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ page_id: 'p1', revision_id: 'r1' });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(wasQueryKeyInvalidated(invalidateSpy, pageHistoryKeys.all)).toBe(true);
    expect(wasQueryKeyInvalidated(invalidateSpy, pageKeys.all)).toBe(true);
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
    expect(wasQueryKeyInvalidated(invalidateSpy, pageHistoryKeys.all)).toBe(true);
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
    expect(wasQueryKeyInvalidated(invalidateSpy, pageHistoryKeys.all)).toBe(true);
  });
});

describe('useRenameSubtree — subpages invalidation via onSettled (feature-user-page-subpages-tab)', () => {
  it('invalidates the subpages cache on a clean success', async () => {
    renameSubtree.mockResolvedValue({ ok: true, json: async () => ({ renamed_count: 3 }) });
    const { invalidateSpy, wrapper } = makeMutationContext();

    const { result } = renderHook(() => useRenameSubtree(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ old_path: '/old', new_path: '/new', idempotencyKey: 'test-idem-key-0008' });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(renameSubtree).toHaveBeenCalledWith({
      json: { old_path: '/old', new_path: '/new' },
      header: { 'idempotency-key': 'test-idem-key-0008' },
    });
    expect(wasSubpagesInvalidated(invalidateSpy)).toBe(true);
    expect(wasQueryKeyInvalidated(invalidateSpy, pageHistoryKeys.all)).toBe(true);
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
        await result.current.mutateAsync({ old_path: '/old', new_path: '/new', idempotencyKey: 'test-idem-key-0009' });
      } catch {
        // expected — the mutation rejects with RenameTreeConflictError
      }
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(wasSubpagesInvalidated(invalidateSpy)).toBe(true);
    expect(wasQueryKeyInvalidated(invalidateSpy, pageHistoryKeys.all)).toBe(true);
  });
});
