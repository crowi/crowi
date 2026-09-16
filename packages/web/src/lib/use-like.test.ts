import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';

// Mock `apiClient` so the like/unlike calls hit our fake (Batch 4
// switched the hook from ts-rest's `apiClient.page.{like,unlike}Page`
// to `apiClient.pages.{like,unlike}.$post`).
const { likePage, unlikePage } = vi.hoisted(() => ({
  likePage: vi.fn(),
  unlikePage: vi.fn(),
}));
vi.mock('./api-client', () => ({
  apiClient: { pages: { like: { $post: likePage }, unlike: { $post: unlikePage } } },
}));

// Mock `notify` so we can assert the error toast on revert.
const { notifyError } = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock('./notify', () => ({ notify: { error: notifyError } }));

import { useToggleLike } from './use-like';

/**
 * feature-page-relations-collections AC-11 — `useToggleLike`'s D-2
 * reconciler. `isLiked` is never derived from a `liker` id array; every
 * fixture below is a bare `{ _id, isLiked, likerCount }` slice — the shape
 * every family's patcher reads/writes (see `use-like.ts`'s registry).
 */
interface PageSlice {
  _id: string;
  isLiked: boolean;
  likerCount: number;
}

const PAGE_ID = 'page-1';

function makeClient() {
  // Non-zero gcTime so a cache entry without an active observer (every
  // fixture below is seeded directly, never rendered via a real query
  // hook) survives long enough for assertions.
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
}

function wrapperFor(client: QueryClient) {
  const Wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return Wrapper;
}

function pendingResponse() {
  return new Promise(() => {}); // never resolves — freezes the mutation mid-flight so onMutate's patch is observable
}

function okResponse(page: PageSlice) {
  return { ok: true, status: 200, json: async () => ({ page }) };
}

function failResponse() {
  return { ok: false, status: 400, json: async () => ({ error: { code: 'X', message: 'nope' } }) };
}

beforeEach(() => {
  likePage.mockReset();
  unlikePage.mockReset();
  notifyError.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// -- pageKeys — { page: {...} | null, notFound, notGranted } ---------------
describe('useToggleLike — pageKeys family (D-2 registry)', () => {
  interface CachedPageData {
    page: PageSlice | null;
    notFound: boolean;
    notGranted: boolean;
  }
  const KEY = ['page', { path: '/docs/example' }] as const;

  function seed(client: QueryClient, isLiked: boolean, likerCount: number) {
    client.setQueryData<CachedPageData>(KEY, { page: { _id: PAGE_ID, isLiked, likerCount }, notFound: false, notGranted: false });
  }

  it('optimistically flips isLiked and increments likerCount on a like', async () => {
    const client = makeClient();
    seed(client, false, 2);
    likePage.mockReturnValue(pendingResponse());

    const { result } = renderHook(() => useToggleLike(PAGE_ID, false), { wrapper: wrapperFor(client) });
    act(() => result.current.toggle());

    await waitFor(() => {
      const cached = client.getQueryData<CachedPageData>(KEY);
      expect(cached?.page?.isLiked).toBe(true);
      expect(cached?.page?.likerCount).toBe(3);
    });
  });

  it('optimistically flips isLiked and decrements likerCount on an unlike', async () => {
    const client = makeClient();
    seed(client, true, 5);
    unlikePage.mockReturnValue(pendingResponse());

    const { result } = renderHook(() => useToggleLike(PAGE_ID, true), { wrapper: wrapperFor(client) });
    act(() => result.current.toggle());

    await waitFor(() => {
      const cached = client.getQueryData<CachedPageData>(KEY);
      expect(cached?.page?.isLiked).toBe(false);
      expect(cached?.page?.likerCount).toBe(4);
    });
  });

  it('reflects the server response (may differ from the optimistic guess under concurrent toggles) once the mutation resolves', async () => {
    const client = makeClient();
    seed(client, false, 2);
    // Server settles on a DIFFERENT likerCount than the optimistic +1 guess
    // (e.g. another request toggled concurrently) — the response must win.
    likePage.mockResolvedValue(okResponse({ _id: PAGE_ID, isLiked: true, likerCount: 5 }));

    const { result } = renderHook(() => useToggleLike(PAGE_ID, false), { wrapper: wrapperFor(client) });
    await act(async () => result.current.toggleAsync());

    const cached = client.getQueryData<CachedPageData>(KEY);
    expect(cached?.page?.isLiked).toBe(true);
    expect(cached?.page?.likerCount).toBe(5);
  });

  it('rolls the state back and shows an error toast when the request fails', async () => {
    const client = makeClient();
    seed(client, false, 7);
    likePage.mockResolvedValue(failResponse());

    const { result } = renderHook(() => useToggleLike(PAGE_ID, false), { wrapper: wrapperFor(client) });
    act(() => result.current.toggle());

    await waitFor(() => expect(result.current.isError).toBe(true));

    const cached = client.getQueryData<CachedPageData>(KEY);
    expect(cached?.page?.isLiked).toBe(false);
    expect(cached?.page?.likerCount).toBe(7);
    expect(notifyError).toHaveBeenCalledTimes(1);
  });
});

// -- pageListKeys — ListPagesResponse: pages[], portalPage, contentPage ----
describe('useToggleLike — pageListKeys family (D-2 registry)', () => {
  interface ListPagesData {
    pages: PageSlice[];
    pager: { prev: number | null; next: number | null; offset: number };
    portalPage: PageSlice | null;
    contentPage: PageSlice | null;
    total: number;
  }
  const KEY = ['pages', 'list', { path: '/docs/' }] as const;

  function seed(client: QueryClient): void {
    client.setQueryData<ListPagesData>(KEY, {
      pages: [
        { _id: PAGE_ID, isLiked: false, likerCount: 1 },
        { _id: 'page-2', isLiked: false, likerCount: 0 },
      ],
      pager: { prev: null, next: null, offset: 0 },
      portalPage: { _id: 'portal-1', isLiked: false, likerCount: 0 },
      contentPage: { _id: 'content-1', isLiked: false, likerCount: 0 },
      total: 2,
    });
  }

  it('patches ONLY the matching row across pages[]/portalPage/contentPage, optimistically then via the server response', async () => {
    const client = makeClient();
    seed(client);
    likePage.mockResolvedValue(okResponse({ _id: PAGE_ID, isLiked: true, likerCount: 2 }));

    const { result } = renderHook(() => useToggleLike(PAGE_ID, false), { wrapper: wrapperFor(client) });
    await act(async () => result.current.toggleAsync());

    const cached = client.getQueryData<ListPagesData>(KEY);
    expect(cached?.pages[0]).toMatchObject({ _id: PAGE_ID, isLiked: true, likerCount: 2 });
    // Unrelated rows / portal / content are untouched.
    expect(cached?.pages[1]).toMatchObject({ isLiked: false, likerCount: 0 });
    expect(cached?.portalPage).toMatchObject({ isLiked: false, likerCount: 0 });
    expect(cached?.contentPage).toMatchObject({ isLiked: false, likerCount: 0 });
  });

  it('rolls pages[]/portalPage/contentPage back together on failure', async () => {
    const client = makeClient();
    seed(client);
    likePage.mockResolvedValue(failResponse());

    const { result } = renderHook(() => useToggleLike(PAGE_ID, false), { wrapper: wrapperFor(client) });
    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.isError).toBe(true));

    const cached = client.getQueryData<ListPagesData>(KEY);
    expect(cached?.pages[0]).toMatchObject({ isLiked: false, likerCount: 1 });
  });

  it('patches the portal/content singleton slots too, when the toggled page is the portal itself', async () => {
    const client = makeClient();
    seed(client);
    likePage.mockReturnValue(pendingResponse());

    const { result } = renderHook(() => useToggleLike('portal-1', false), { wrapper: wrapperFor(client) });
    act(() => result.current.toggle());

    await waitFor(() => {
      const cached = client.getQueryData<ListPagesData>(KEY);
      expect(cached?.portalPage).toMatchObject({ isLiked: true, likerCount: 1 });
    });
  });
});

// -- userPageKeys.profile — recentPages[], recentBookmarks[].page ----------
describe('useToggleLike — userPageKeys.profile family (D-2 registry)', () => {
  interface UserPageData {
    recentPages?: PageSlice[];
    recentBookmarks?: Array<{ _id: string; page: PageSlice }>;
  }
  const KEY = ['user', 'alice'] as const;

  it('patches the SAME page id appearing as two DISTINCT objects in recentPages and recentBookmarks[].page', async () => {
    const client = makeClient();
    const data: UserPageData = {
      recentPages: [{ _id: PAGE_ID, isLiked: false, likerCount: 3 }],
      recentBookmarks: [{ _id: 'bm-1', page: { _id: PAGE_ID, isLiked: false, likerCount: 3 } }],
    };
    client.setQueryData(KEY, data);
    likePage.mockReturnValue(pendingResponse());

    const { result } = renderHook(() => useToggleLike(PAGE_ID, false), { wrapper: wrapperFor(client) });
    act(() => result.current.toggle());

    await waitFor(() => {
      const cached = client.getQueryData<UserPageData>(KEY);
      expect(cached?.recentPages?.[0]).toMatchObject({ isLiked: true, likerCount: 4 });
      expect(cached?.recentBookmarks?.[0].page).toMatchObject({ isLiked: true, likerCount: 4 });
    });
  });
});

// -- userPageKeys.bookmarksDetail / bookmarksInfinite -----------------------
describe('useToggleLike — userPageKeys.bookmarksDetail/Infinite families (D-2 registry)', () => {
  interface BookmarksData {
    bookmarks: Array<{ _id: string; page: PageSlice }>;
    pager: { prev: number | null; next: number | null; offset: number };
    total: number;
  }
  const DETAIL_KEY = ['user', 'alice', 'bookmarks', { limit: 10, offset: 0 }] as const;
  const INFINITE_KEY = ['user', 'alice', 'bookmarks', 'infinite', 10] as const;

  it("patches bookmarksDetail's bookmarks[].page", async () => {
    const client = makeClient();
    client.setQueryData<BookmarksData>(DETAIL_KEY, {
      bookmarks: [{ _id: 'bm-1', page: { _id: PAGE_ID, isLiked: false, likerCount: 0 } }],
      pager: { prev: null, next: null, offset: 0 },
      total: 1,
    });
    likePage.mockReturnValue(pendingResponse());

    const { result } = renderHook(() => useToggleLike(PAGE_ID, false), { wrapper: wrapperFor(client) });
    act(() => result.current.toggle());

    await waitFor(() => {
      const cached = client.getQueryData<BookmarksData>(DETAIL_KEY);
      expect(cached?.bookmarks[0].page).toMatchObject({ isLiked: true, likerCount: 1 });
    });
  });

  it("patches bookmarksInfinite's InfiniteData.pages[].bookmarks[].page", async () => {
    const client = makeClient();
    client.setQueryData(INFINITE_KEY, {
      pages: [{ bookmarks: [{ _id: 'bm-1', page: { _id: PAGE_ID, isLiked: false, likerCount: 0 } }], pager: { prev: null, next: null, offset: 0 }, total: 1 }],
      pageParams: [0],
    });
    likePage.mockReturnValue(pendingResponse());

    const { result } = renderHook(() => useToggleLike(PAGE_ID, false), { wrapper: wrapperFor(client) });
    act(() => result.current.toggle());

    await waitFor(() => {
      const cached = client.getQueryData<{ pages: BookmarksData[] }>(INFINITE_KEY);
      expect(cached?.pages[0].bookmarks[0].page).toMatchObject({ isLiked: true, likerCount: 1 });
    });
  });
});

// -- userPageKeys.pagesDetail/Infinite & subpagesDetail/Infinite -----------
describe('useToggleLike — userPageKeys.pagesDetail/subpagesDetail families (D-2 registry)', () => {
  interface UserPagesData {
    pages: PageSlice[];
    pager: { prev: number | null; next: number | null; offset: number };
    total: number;
  }

  it.each([
    ['pagesDetail', ['user', 'alice', 'pages', { limit: 10, offset: 0 }] as const],
    ['subpagesDetail', ['user', 'alice', 'subpages', { limit: 10, offset: 0 }] as const],
  ])("patches %s's pages[]", async (_name, key) => {
    const client = makeClient();
    client.setQueryData<UserPagesData>(key, {
      pages: [{ _id: PAGE_ID, isLiked: false, likerCount: 0 }],
      pager: { prev: null, next: null, offset: 0 },
      total: 1,
    });
    likePage.mockReturnValue(pendingResponse());

    const { result } = renderHook(() => useToggleLike(PAGE_ID, false), { wrapper: wrapperFor(client) });
    act(() => result.current.toggle());

    await waitFor(() => {
      const cached = client.getQueryData<UserPagesData>(key);
      expect(cached?.pages[0]).toMatchObject({ isLiked: true, likerCount: 1 });
    });
  });

  it.each([
    ['pagesInfinite', ['user', 'alice', 'pages', 'infinite', 10] as const],
    ['subpagesInfinite', ['user', 'alice', 'subpages', 'infinite', 10] as const],
  ])("patches %s's InfiniteData.pages[].pages[]", async (_name, key) => {
    const client = makeClient();
    client.setQueryData(key, {
      pages: [{ pages: [{ _id: PAGE_ID, isLiked: false, likerCount: 0 }], pager: { prev: null, next: null, offset: 0 }, total: 1 }],
      pageParams: [0],
    });
    likePage.mockReturnValue(pendingResponse());

    const { result } = renderHook(() => useToggleLike(PAGE_ID, false), { wrapper: wrapperFor(client) });
    act(() => result.current.toggle());

    await waitFor(() => {
      const cached = client.getQueryData<{ pages: UserPagesData[] }>(key);
      expect(cached?.pages[0].pages[0]).toMatchObject({ isLiked: true, likerCount: 1 });
    });
  });
});

// -- searchKeys — SearchPagesResponse: data[].page --------------------------
describe('useToggleLike — searchKeys family (D-2 registry)', () => {
  interface SearchData {
    meta: { total: number; results: number };
    data: Array<{ pageId: string; path: string; page: PageSlice }>;
  }
  const KEY = ['search', 'pages', 'hello', null, null, 1] as const;

  it('patches data[].page', async () => {
    const client = makeClient();
    client.setQueryData<SearchData>(KEY, {
      meta: { total: 1, results: 1 },
      data: [{ pageId: PAGE_ID, path: '/hello', page: { _id: PAGE_ID, isLiked: false, likerCount: 0 } }],
    });
    likePage.mockReturnValue(pendingResponse());

    const { result } = renderHook(() => useToggleLike(PAGE_ID, false), { wrapper: wrapperFor(client) });
    act(() => result.current.toggle());

    await waitFor(() => {
      const cached = client.getQueryData<SearchData>(KEY);
      expect(cached?.data[0].page).toMatchObject({ isLiked: true, likerCount: 1 });
    });
  });
});

// -- recentlyViewedKeys — RecentlyViewedPagesResponse: pages[] -------------
describe('useToggleLike — recentlyViewedKeys family (D-2 registry)', () => {
  const KEY = ['me', 'recently-viewed'] as const;

  it('patches pages[]', async () => {
    const client = makeClient();
    client.setQueryData(KEY, { pages: [{ _id: PAGE_ID, isLiked: false, likerCount: 0 }] });
    likePage.mockReturnValue(pendingResponse());

    const { result } = renderHook(() => useToggleLike(PAGE_ID, false), { wrapper: wrapperFor(client) });
    act(() => result.current.toggle());

    await waitFor(() => {
      const cached = client.getQueryData<{ pages: PageSlice[] }>(KEY);
      expect(cached?.pages[0]).toMatchObject({ isLiked: true, likerCount: 1 });
    });
  });
});

// -- invalidation reaches every family that embeds this page ---------------
describe("useToggleLike — post-toggle invalidation spans every D-2 registry family (current parity gap: only ['page'] was invalidated before)", () => {
  it('marks every family entry embedding the toggled page as invalidated, and leaves an unrelated entry untouched', async () => {
    const client = makeClient();
    client.setQueryData(['page', { path: '/docs/example' }], { page: { _id: PAGE_ID, isLiked: false, likerCount: 1 }, notFound: false, notGranted: false });
    client.setQueryData(['pages', 'list', { path: '/docs/' }], {
      pages: [{ _id: PAGE_ID, isLiked: false, likerCount: 1 }],
      pager: { prev: null, next: null, offset: 0 },
      portalPage: null,
      contentPage: null,
      total: 1,
    });
    client.setQueryData(['user', 'alice'], { recentPages: [{ _id: PAGE_ID, isLiked: false, likerCount: 1 }] });
    client.setQueryData(['search', 'pages', 'hello', null, null, 1], {
      meta: { total: 1, results: 1 },
      data: [{ pageId: PAGE_ID, path: '/hello', page: { _id: PAGE_ID, isLiked: false, likerCount: 1 } }],
    });
    client.setQueryData(['me', 'recently-viewed'], { pages: [{ _id: PAGE_ID, isLiked: false, likerCount: 1 }] });
    // An unrelated list (different page) must NOT be invalidated.
    client.setQueryData(['pages', 'list', { path: '/other/' }], {
      pages: [{ _id: 'page-unrelated', isLiked: false, likerCount: 0 }],
      pager: { prev: null, next: null, offset: 0 },
      portalPage: null,
      contentPage: null,
      total: 1,
    });

    likePage.mockResolvedValue(okResponse({ _id: PAGE_ID, isLiked: true, likerCount: 2 }));

    const { result } = renderHook(() => useToggleLike(PAGE_ID, false), { wrapper: wrapperFor(client) });
    await act(async () => result.current.toggleAsync());
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(client.getQueryState(['page', { path: '/docs/example' }])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['pages', 'list', { path: '/docs/' }])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['user', 'alice'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['search', 'pages', 'hello', null, null, 1])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['me', 'recently-viewed'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['pages', 'list', { path: '/other/' }])?.isInvalidated ?? false).toBe(false);
  });
});
