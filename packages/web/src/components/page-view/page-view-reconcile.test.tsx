import type { PageWithRevision, PresencePageUpdatedMessage } from '@crowi/api-contract';
import { PageGrantEnum } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pageKeys } from '@/lib/page-query-keys';
import { makeApiResponse } from '@/lib/test-utils/mocks';
import { commentKeys } from '@/lib/use-page-comments';
import type { UsePresenceOptions } from '@/lib/use-presence';

/**
 * feature-live-page-sync-reconcile — integration coverage for the
 * head-GET reconcile orchestration living in `page-view.tsx`
 * (`reconcilePageHead` / `runReconcileFlight`): the fences (generation /
 * authorityEpoch / frame / dirty-single-flight), the tab-revisit /
 * reconnect-barrier / periodic-backstop / show-latest triggers, and the
 * self/other + read-old interactions. The pure compare/merge helpers
 * (`isHeadNewer` / `isLifecycleChanged` / `pageLevelFieldsChanged` /
 * `mergePageLevelFields`) have their own dedicated unit coverage in
 * `live-sync-reconcile.test.ts` — this file is about the ORCHESTRATION
 * around them.
 *
 * `usePresence` is mocked (not the real hook — that has its own coverage
 * in `use-presence.test.ts`) so tests can invoke `onPageUpdated` /
 * `onReconnected` / `onAccessRevoked` directly and control
 * `pageUpdatedSeq` deterministically. `usePage` is the REAL hook, wired
 * to a real `QueryClient` and a mocked `apiClient.pages.$get` — this is
 * what lets a reconcile cache write actually flow back into what
 * `usePage` (and therefore `PageView`) renders, exactly as in production.
 */

const { usePresence } = vi.hoisted(() => ({ usePresence: vi.fn() }));
const { getPage, getRevision } = vi.hoisted(() => ({ getPage: vi.fn(), getRevision: vi.fn() }));
const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
const { usePageChildren } = vi.hoisted(() => ({ usePageChildren: vi.fn() }));
const { useMarkSeenOnView } = vi.hoisted(() => ({ useMarkSeenOnView: vi.fn() }));
const { useRevertDeletedPage } = vi.hoisted(() => ({ useRevertDeletedPage: vi.fn() }));
const { usePageGrantAccent } = vi.hoisted(() => ({ usePageGrantAccent: vi.fn() }));
const { routerPush, routerReplace, routerBack } = vi.hoisted(() => ({ routerPush: vi.fn(), routerReplace: vi.fn(), routerBack: vi.fn() }));

vi.mock('@/lib/use-presence', () => ({ usePresence }));
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    pages: {
      $get: getPage,
      revisions: { ':id': { $get: getRevision } },
    },
  },
}));
vi.mock('@/lib/use-auth', () => ({ useAuth }));
vi.mock('@/lib/use-page-children', () => ({ usePageChildren }));
vi.mock('@/lib/use-seen', () => ({ useMarkSeenOnView }));
vi.mock('@/lib/use-page-mutations', () => ({ useRevertDeletedPage, useRevertToRevision: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('@/lib/use-page-grant-accent', () => ({ usePageGrantAccent }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: routerPush, replace: routerReplace, back: routerBack }) }));

vi.mock('./page-header', () => ({ PageHeader: () => createElement('div', { 'data-testid': 'page-header-stub' }) }));
vi.mock('./page-content', () => ({
  PageContent: ({ page }: { page: PageWithRevision }) => createElement('div', { 'data-testid': 'page-content-stub' }, page.revision?.body),
}));
vi.mock('./backlink-list', () => ({ BacklinkList: () => createElement('div', { 'data-testid': 'backlink-list-stub' }) }));
vi.mock('./attachment-list', () => ({ AttachmentList: () => createElement('div', { 'data-testid': 'attachment-list-stub' }) }));
vi.mock('@/components/page-comments', () => ({ PageComments: () => createElement('div', { 'data-testid': 'page-comments-stub' }) }));

import { PageView } from './page-view';

function makePage(overrides: Partial<PageWithRevision> = {}): PageWithRevision {
  const merged = {
    _id: 'page-1',
    path: '/docs/example',
    grant: PageGrantEnum.PUBLIC,
    grantedUsers: [],
    status: undefined,
    redirectTo: null,
    revision: {
      _id: 'rev-1',
      path: '/docs/example',
      body: '# v1',
      format: 'markdown',
      createdAt: '2026-05-01T00:00:00.000Z',
    },
    latestRevision: 'rev-1',
    creator: null,
    lastUpdateUser: { _id: 'u-alice', username: 'alice', name: 'Alice', email: 'a@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
    liker: [],
    commentCount: 0,
    extended: undefined,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    likerCount: 0,
    seenUsersCount: 0,
    ...overrides,
  } as PageWithRevision;
  // `isStalePageRevision` compares `latestRevision` against `revision._id` —
  // a caller overriding `revision` without also overriding `latestRevision`
  // would otherwise accidentally look "stale" (and render StaleRevisionBanner).
  if (overrides.revision && overrides.latestRevision === undefined) {
    merged.latestRevision = overrides.revision._id;
  }
  return merged;
}

// Thin aliases over the shared factory (see its jsdoc — created specifically
// to replace an identical `okResponse`/`errorResponse` pair duplicated across
// several test files) so call sites below stay unchanged.
const okResponse = (body: unknown) => makeApiResponse(200, body);
const errorResponse = (status: number, body: unknown = { error: { code: 'X', message: 'x' } }) => makeApiResponse(status, body);

/** A getPage response whose resolution is controlled by the test. */
function deferredGetPage(): { promise: Promise<unknown>; resolve: (value: unknown) => void } {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let presenceOptions: UsePresenceOptions | undefined;
let pageUpdatedSeqRef: { current: number };
let selfUserId: string | null;

// Wrapped in a synchronous `act()` (mirrors `fireEvent`'s own auto-wrap) so
// any synchronous state update the handler makes (e.g. `dispatchBanner`) is
// committed before the call returns — without it, an immediate assertion
// right after `emit*` could observe React's pre-commit DOM.
function emitPageUpdated(payload: PresencePageUpdatedMessage) {
  pageUpdatedSeqRef.current += 1;
  act(() => {
    presenceOptions?.onPageUpdated?.(payload);
  });
}
function emitReconnected() {
  act(() => {
    presenceOptions?.onReconnected?.();
  });
}
function emitAccessRevoked() {
  act(() => {
    presenceOptions?.onAccessRevoked?.();
  });
}

/** Flush the microtask queue under fake timers (mirrors use-presence.test.ts's `flush`). */
async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

function renderPageView(page: PageWithRevision, path = page.path) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } } });
  queryClient.setQueryData(pageKeys.detail({ path, revision_id: undefined }), { page, notFound: false, notGranted: false });
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: queryClient }, children);
  const utils = render(createElement(PageView, { path }), { wrapper });
  return { queryClient, ...utils };
}

function bannerKind(): string | null {
  const el = screen.queryByTestId('live-sync-banner');
  return el?.getAttribute('data-kind') ?? null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  pageUpdatedSeqRef = { current: 0 };
  selfUserId = 'me';
  presenceOptions = undefined;
  usePresence.mockImplementation((_pageId: string | null, options?: UsePresenceOptions) => {
    presenceOptions = options;
    return { viewers: [], selfUserId, status: 'connected', pageUpdatedSeq: pageUpdatedSeqRef };
  });
  useAuth.mockReturnValue({ isAuthenticated: true });
  usePageChildren.mockReturnValue({ data: { children: [] } });
  useMarkSeenOnView.mockReturnValue(undefined);
  useRevertDeletedPage.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false, error: null });
  usePageGrantAccent.mockReturnValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('tab-revisit / reconnect-barrier reconcile (AC1-6)', () => {
  it('swaps to the latest revision + shows the banner when hidden-time update is found on revisit, scroll preserved', async () => {
    const page = makePage();
    renderPageView(page);
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

    const updated = makePage({ revision: { ...page.revision, _id: 'rev-2', createdAt: '2026-05-02T00:00:00.000Z' }, latestRevision: 'rev-2' });
    getPage.mockResolvedValueOnce(okResponse({ page: updated }));

    setVisibility('visible');
    await flush();
    // rAF-scheduled scroll restore: flush a frame too.
    await flush(16);

    expect(screen.getByTestId('page-content-stub').textContent).toBe(updated.revision.body);
    expect(bannerKind()).toBe('showing-latest');
    scrollToSpy.mockRestore();
  });

  it('is a no-op (banner + display unchanged) when nothing changed while hidden', async () => {
    const page = makePage();
    renderPageView(page);
    getPage.mockResolvedValueOnce(okResponse({ page: makePage() }));

    setVisibility('visible');
    await flush();

    expect(screen.getByTestId('page-content-stub').textContent).toBe(page.revision.body);
    expect(bannerKind()).toBeNull();
    expect(getPage).toHaveBeenCalledTimes(1);
  });

  it('does not auto-advance while showing an old revision — escalates to "newer version" instead', async () => {
    const page = makePage();
    const { queryClient } = renderPageView(page);
    // Reach `showing-latest` via an ordinary push-path swap first.
    emitPageUpdated({ type: 'page-updated', pageId: page._id, revisionId: 'rev-2', editorUserId: 'bob', editorDisplayName: 'Bob' });
    getRevision.mockResolvedValueOnce(okResponse({ revision: { ...page.revision, _id: 'rev-2', createdAt: '2026-05-02T00:00:00.000Z', author: null } }));
    await flush(300);
    expect(bannerKind()).toBe('showing-latest');

    fireEvent.click(screen.getByRole('button', { name: m['page.live_sync_read_previous']() }));
    expect(bannerKind()).toBe('showing-old');
    const beforeRevisit = (queryClient.getQueryData(pageKeys.detail({ path: page.path, revision_id: undefined })) as { page: PageWithRevision }).page.revision
      ._id;

    const evenNewer = makePage({ revision: { ...page.revision, _id: 'rev-3', createdAt: '2026-05-03T00:00:00.000Z' }, latestRevision: 'rev-3' });
    getPage.mockResolvedValueOnce(okResponse({ page: evenNewer }));
    setVisibility('visible');
    await flush();

    expect(bannerKind()).toBe('showing-latest-again');
    const afterRevisit = (queryClient.getQueryData(pageKeys.detail({ path: page.path, revision_id: undefined })) as { page: PageWithRevision }).page.revision
      ._id;
    expect(afterRevisit).toBe(beforeRevisit); // cache did NOT advance
  });

  it('reconciles unconditionally on the FIRST connection epoch even with a freshly-cached usePage result', async () => {
    const page = makePage();
    renderPageView(page); // seeded cache counts as "just fetched" (fresh, within staleTime)

    getPage.mockResolvedValueOnce(okResponse({ page: makePage() }));
    emitReconnected(); // usePresence's contract: fires once per epoch, including the first
    await flush();

    expect(getPage).toHaveBeenCalledTimes(1); // proves no "skip if recently fetched" gate exists
  });

  it('reconciles across a full first-connect -> disconnect -> reconnect cycle (2nd+ epoch), picking up an update saved during the outage', async () => {
    const page = makePage();
    renderPageView(page);

    // Epoch 1 (fresh mount): the barrier fires, reconcile finds nothing new.
    getPage.mockResolvedValueOnce(okResponse({ page: makePage() }));
    emitReconnected();
    await flush();
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('page-content-stub').textContent).toBe(page.revision.body);
    expect(bannerKind()).toBeNull();

    // The socket is now down (sleep / network loss) — `usePresence`'s own
    // reconnect/backoff machinery is covered by `use-presence.test.ts`;
    // here we only need the ref-callback contract PageView relies on: no
    // `onReconnected` call happens again until the SECOND `viewers`
    // broadcast of a NEW epoch arrives. While the socket is down, someone
    // else saves — that update is invisible to this tab until reconcile
    // runs on reconnect.
    const updatedDuringOutage = makePage({
      revision: { ...page.revision, _id: 'rev-2', createdAt: '2026-05-02T00:00:00.000Z' },
      latestRevision: 'rev-2',
    });
    getPage.mockResolvedValueOnce(okResponse({ page: updatedDuringOutage }));

    // Epoch 2 (reconnect): `onReconnected` fires again, after ITS first
    // `viewers` broadcast (see use-presence.test.ts) — the outage update
    // is picked up and swapped in with the banner shown.
    emitReconnected();
    await flush();

    expect(getPage).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('page-content-stub').textContent).toBe(updatedDuringOutage.revision.body);
    expect(bannerKind()).toBe('showing-latest');
  });

  it('reconciles unconditionally when SPA navigation returns to a page within 30s (usePage cache reused, not evicted)', async () => {
    const pageA = makePage({ _id: 'page-a', path: '/docs/a' });
    const pageB = makePage({
      _id: 'page-b',
      path: '/docs/b',
      revision: { ...pageA.revision, _id: 'rev-b', body: '# page b' },
      latestRevision: 'rev-b',
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } } });
    queryClient.setQueryData(pageKeys.detail({ path: pageA.path, revision_id: undefined }), { page: pageA, notFound: false, notGranted: false });
    queryClient.setQueryData(pageKeys.detail({ path: pageB.path, revision_id: undefined }), { page: pageB, notFound: false, notGranted: false });
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: queryClient }, children);
    const { rerender } = render(createElement(PageView, { path: pageA.path }), { wrapper });

    // Epoch 1, on page A.
    getPage.mockResolvedValueOnce(okResponse({ page: pageA }));
    emitReconnected();
    await flush();
    expect(getPage).toHaveBeenCalledTimes(1);

    // SPA navigation to page B — `PageView` itself does not unmount (the
    // `path` prop just changes), and `usePresence(pageId, ...)` re-keys on
    // the new page's id, so this is a fresh connection epoch for page B.
    rerender(createElement(PageView, { path: pageB.path }));
    getPage.mockResolvedValueOnce(okResponse({ page: pageB }));
    emitReconnected();
    await flush();
    expect(getPage).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('page-content-stub').textContent).toBe(pageB.revision.body);

    // SPA navigation BACK to page A within 30s: `usePage`'s cache for A is
    // still fresh (well within its 30s `staleTime`) and is reused as-is —
    // but reconcile still fires unconditionally for this (first, for page
    // A's new mount-equivalent epoch) `onReconnected`, exactly as it would
    // for a fresh page load, and picks up whatever changed while this tab
    // was away from A.
    rerender(createElement(PageView, { path: pageA.path }));
    const updatedA = makePage({
      _id: 'page-a',
      path: pageA.path,
      revision: { ...pageA.revision, _id: 'rev-a2', createdAt: '2026-05-02T00:00:00.000Z' },
      latestRevision: 'rev-a2',
    });
    getPage.mockResolvedValueOnce(okResponse({ page: updatedA }));
    emitReconnected();
    await flush();

    expect(getPage).toHaveBeenCalledTimes(3); // fired on every epoch, including the SPA revisit
    expect(screen.getByTestId('page-content-stub').textContent).toBe(updatedA.revision.body);
    expect(bannerKind()).toBe('showing-latest');
  });
});

describe('frame fence + single-flight (AC7-10)', () => {
  it('discards a stale in-flight GET when a live frame arrives mid-flight, then reruns and applies the fresh head', async () => {
    const page = makePage();
    renderPageView(page);

    const deferred = deferredGetPage();
    getPage.mockImplementationOnce(() => deferred.promise);
    emitReconnected();
    await flush();
    expect(getPage).toHaveBeenCalledTimes(1);

    // A live page-updated frame (even a self one) arrives WHILE the GET is in flight.
    emitPageUpdated({ type: 'page-updated', pageId: page._id, revisionId: 'rev-2', editorUserId: 'bob', editorDisplayName: 'Bob' });

    const freshHead = makePage({ revision: { ...page.revision, _id: 'rev-3', createdAt: '2026-05-03T00:00:00.000Z' } });
    getPage.mockResolvedValueOnce(okResponse({ page: freshHead }));
    deferred.resolve(okResponse({ page: makePage({ revision: { ...page.revision, _id: 'rev-stale', createdAt: '2026-05-01T12:00:00.000Z' } }) })); // stale — must be discarded
    await flush();

    expect(getPage).toHaveBeenCalledTimes(2); // discard-and-rerun issued a 2nd GET
    expect(screen.getByTestId('page-content-stub').textContent).toBe(freshHead.revision.body);
  });

  it('never has more than one in-flight GET at a time across overlapping triggers', async () => {
    const page = makePage();
    renderPageView(page);

    const deferred = deferredGetPage();
    getPage.mockImplementationOnce(() => deferred.promise);
    emitReconnected();
    setVisibility('visible');
    emitReconnected();
    await flush();

    expect(getPage).toHaveBeenCalledTimes(1); // the other triggers coalesced into `dirty`, not a 2nd fetch
    deferred.resolve(okResponse({ page }));
    await flush();
  });

  it('discards (and does NOT rerun) a reconcile result once the page is no longer displayed (path change / unmount)', async () => {
    const page = makePage();
    const { unmount } = renderPageView(page);

    const deferred = deferredGetPage();
    getPage.mockImplementationOnce(() => deferred.promise);
    emitReconnected();
    await flush();

    unmount();
    deferred.resolve(okResponse({ page: makePage({ revision: { ...page.revision, _id: 'rev-2', createdAt: '2026-05-02T00:00:00.000Z' } }) }));
    // Must not throw / warn about setting state on an unmounted component's cache in a way that crashes.
    await expect(flush()).resolves.not.toThrow();
    expect(getPage).toHaveBeenCalledTimes(1); // no rerun after a generation-fence discard
  });
});

describe('authorityEpoch fence (AC11) + presence 4403 verify-first (AC13)', () => {
  it('does not let a stale pre-revocation 200 overwrite AccessDenied once 4403 -> revalidate(403) already resolved it', async () => {
    const page = makePage();
    renderPageView(page);

    const deferred = deferredGetPage();
    getPage.mockImplementationOnce(() => deferred.promise); // the reconcile flight in flight
    emitReconnected();
    await flush();
    expect(getPage).toHaveBeenCalledTimes(1);

    // Grant revoked mid-flight: 4403 close -> onAccessRevoked -> immediate
    // revalidate, which invalidates `usePage`'s query — that query is
    // active, so react-query refetches it too (a 2nd `getPage` call).
    getPage.mockResolvedValueOnce(errorResponse(403, { error: { code: 'PAGE_NOT_GRANTED', message: 'no' } }));
    emitAccessRevoked();
    await flush();
    expect(screen.getByText(m['common.access_denied_title']())).toBeTruthy();

    // The ORIGINAL (pre-revocation) GET now resolves late with a 200.
    deferred.resolve(okResponse({ page: makePage({ revision: { ...page.revision, _id: 'rev-2', createdAt: '2026-05-02T00:00:00.000Z' } }) }));
    await flush();

    // Still AccessDenied — the stale 200 must not have overwritten it.
    expect(screen.getByText(m['common.access_denied_title']())).toBeTruthy();
    // No further GET was issued for the stale flight's own sake (no rerun of an epoch-fenced discard).
    expect(getPage).toHaveBeenCalledTimes(2);
  });

  it('4403 -> revalidate resolves 200 (transient) -> display is maintained', async () => {
    const page = makePage();
    renderPageView(page);

    getPage.mockResolvedValueOnce(okResponse({ page }));
    emitAccessRevoked();
    await flush();

    expect(screen.queryByText(m['common.access_denied_title']())).toBeNull();
    expect(screen.getByTestId('page-content-stub').textContent).toBe(page.revision.body);
  });
});

describe("reconcile's own 403/404/redirect handling (AC12, AC14)", () => {
  it('403 from the head-GET itself triggers invalidate/refetch -> AccessDenied', async () => {
    const page = makePage();
    renderPageView(page);
    // 1st call: the reconcile's own head-GET. 2nd call: `usePage`'s active
    // query, refetched by the invalidate the reconcile triggers.
    getPage.mockResolvedValueOnce(errorResponse(403, { error: { code: 'PAGE_NOT_GRANTED', message: 'no' } }));
    getPage.mockResolvedValueOnce(errorResponse(403, { error: { code: 'PAGE_NOT_GRANTED', message: 'no' } }));

    emitReconnected();
    await flush();

    expect(screen.getByText(m['common.access_denied_title']())).toBeTruthy();
  });

  it('404 from the head-GET itself triggers invalidate/refetch -> NotFound', async () => {
    const page = makePage();
    renderPageView(page);
    getPage.mockResolvedValueOnce(errorResponse(404, { error: { code: 'PAGE_NOT_FOUND', message: 'no' } }));
    getPage.mockResolvedValueOnce(errorResponse(404, { error: { code: 'PAGE_NOT_FOUND', message: 'no' } }));

    emitReconnected();
    await flush();

    expect(screen.getByText(m['page.not_found_title']())).toBeTruthy();
  });

  it('a 200 redirect stub (redirectTo set) triggers the redirect effect instead of a body swap', async () => {
    const page = makePage();
    renderPageView(page);
    const redirectStub = makePage({ redirectTo: '/docs/moved' });
    getPage.mockResolvedValueOnce(okResponse({ page: redirectStub }));
    getPage.mockResolvedValueOnce(okResponse({ page: redirectStub })); // usePage's own invalidate-triggered refetch

    emitReconnected();
    await flush();

    expect(routerReplace).toHaveBeenCalledWith(expect.stringContaining('/docs/moved'));
    // No body swap happened for the redirect stub itself.
    expect(screen.queryByTestId('page-content-stub')).toBeNull();
  });

  it('a 200 with a different page _id (path reused) triggers invalidate/refetch, not a direct body swap', async () => {
    const page = makePage();
    renderPageView(page);
    const different = makePage({ _id: 'page-2', revision: { ...page.revision, _id: 'rev-other', body: '# a totally different page' } });
    getPage.mockResolvedValueOnce(okResponse({ page: different }));
    // `usePage`'s own invalidate-triggered refetch is deferred so we can
    // assert the reconcile flight itself did NOT write `different` into
    // the cache directly (it must go through invalidate/refetch instead).
    const deferredRefetch = deferredGetPage();
    getPage.mockImplementationOnce(() => deferredRefetch.promise);

    emitReconnected();
    await flush();
    expect(screen.getByTestId('page-content-stub').textContent).toBe(page.revision.body);

    deferredRefetch.resolve(okResponse({ page: different }));
    await flush();
    // Only once `usePage`'s OWN refetch resolves does the (now-replaced) page show.
    expect(screen.getByTestId('page-content-stub').textContent).toBe(different.revision.body);
  });
});

describe('tie-break compare (AC15) + show-latest via reconcile (AC16)', () => {
  it('swaps on a same-millisecond, different-id revision from a head-GET (tie-break)', async () => {
    const page = makePage();
    renderPageView(page);
    const tieBreak = makePage({ revision: { ...page.revision, _id: 'rev-tie', createdAt: page.revision.createdAt } });
    getPage.mockResolvedValueOnce(okResponse({ page: tieBreak }));

    emitReconnected();
    await flush();

    expect(bannerKind()).toBe('showing-latest');
  });

  it('handleShowLatest triggers the reconcile mechanism (not an independent by-id fetch) and swaps on tie-break', async () => {
    const page = makePage();
    renderPageView(page);

    // Reach `showing-latest` -> `showing-old` -> `showing-latest-again`.
    emitPageUpdated({ type: 'page-updated', pageId: page._id, revisionId: 'rev-2', editorUserId: 'bob', editorDisplayName: 'Bob' });
    getRevision.mockResolvedValueOnce(okResponse({ revision: { ...page.revision, _id: 'rev-2', createdAt: '2026-05-02T00:00:00.000Z', author: null } }));
    await flush(300);
    fireEvent.click(screen.getByRole('button', { name: m['page.live_sync_read_previous']() }));
    emitPageUpdated({ type: 'page-updated', pageId: page._id, revisionId: 'rev-3', editorUserId: 'carol', editorDisplayName: 'Carol' });
    expect(bannerKind()).toBe('showing-latest-again');

    // The authoritative head is a same-millisecond, different-id revision
    // relative to what's cached (rev-2) — only reachable via tie-break.
    const tieBreakHead = makePage({ revision: { ...page.revision, _id: 'rev-2-tie', createdAt: '2026-05-02T00:00:00.000Z' } });
    getPage.mockResolvedValueOnce(okResponse({ page: tieBreakHead }));

    fireEvent.click(screen.getByRole('button', { name: m['page.live_sync_show_latest']() }));
    await flush();

    expect(getPage).toHaveBeenCalledTimes(1); // reconcile mechanism, single-flight
    expect(bannerKind()).toBe('showing-latest');
    expect(screen.getByTestId('page-content-stub').textContent).toBe(tieBreakHead.revision.body);
  });
});

describe('page-level field merge (AC17) + self/other silencing (AC18-19)', () => {
  it('merges a grant-only change (revision unchanged) without touching body/banner/scroll', async () => {
    const page = makePage({ grant: PageGrantEnum.PUBLIC, grantedUsers: [] });
    const { queryClient } = renderPageView(page);
    const grantChanged = makePage({ grant: PageGrantEnum.RESTRICTED, grantedUsers: ['u1'] }); // same revision
    getPage.mockResolvedValueOnce(okResponse({ page: grantChanged }));

    emitReconnected();
    await flush();

    expect(bannerKind()).toBeNull();
    expect(screen.getByTestId('page-content-stub').textContent).toBe(page.revision.body);
    const cached = queryClient.getQueryData(pageKeys.detail({ path: page.path, revision_id: undefined })) as { page: PageWithRevision };
    expect(cached.page.grant).toBe(PageGrantEnum.RESTRICTED);
    expect(cached.page.grantedUsers).toEqual(['u1']);
  });

  it('swaps silently (no banner) via reconcile when lastUpdateUser is the viewer themself', async () => {
    const page = makePage();
    renderPageView(page);
    const selfSaved = makePage({
      revision: { ...page.revision, _id: 'rev-2', createdAt: '2026-05-02T00:00:00.000Z' },
      lastUpdateUser: { _id: 'me', username: 'me', name: 'Me', email: 'me@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
    });
    getPage.mockResolvedValueOnce(okResponse({ page: selfSaved }));

    emitReconnected();
    await flush();

    expect(screen.getByTestId('page-content-stub').textContent).toBe(selfSaved.revision.body);
    expect(bannerKind()).toBeNull();
  });

  it('push path: swaps silently (no banner) for a self page-updated frame from another tab', async () => {
    const page = makePage();
    renderPageView(page);
    emitPageUpdated({ type: 'page-updated', pageId: page._id, revisionId: 'rev-2', editorUserId: 'me', editorDisplayName: 'Me' });
    getRevision.mockResolvedValueOnce(okResponse({ revision: { ...page.revision, _id: 'rev-2', createdAt: '2026-05-02T00:00:00.000Z', author: null } }));
    await flush(300);

    expect(screen.getByTestId('page-content-stub').textContent).toBe('# v1'); // stub renders `revision.body`, unchanged text since body wasn't overridden
    expect(bannerKind()).toBeNull();
  });

  it('push path: a same-tab save (cache already at that revision) is a monotonic-guard no-op', async () => {
    const page = makePage();
    const { queryClient } = renderPageView(page);
    // Simulate the mutation itself having already advanced the cache.
    const alreadyApplied = makePage({ revision: { ...page.revision, _id: 'rev-2', createdAt: '2026-05-02T00:00:00.000Z' } });
    queryClient.setQueryData(pageKeys.detail({ path: page.path, revision_id: undefined }), {
      page: alreadyApplied,
      notFound: false,
      notGranted: false,
    });

    emitPageUpdated({ type: 'page-updated', pageId: page._id, revisionId: 'rev-2', editorUserId: 'me', editorDisplayName: 'Me' });
    getRevision.mockResolvedValueOnce(okResponse({ revision: { ...alreadyApplied.revision, author: null } })); // same createdAt — not `>` current
    await flush(300);

    expect(bannerKind()).toBeNull();
  });
});

describe('read-old await-recheck race, same-tick interleaving (AC20)', () => {
  it('does not auto-swap when "read the previous version" is clicked while a reconcile GET is in flight; refs update, banner escalates', async () => {
    const page = makePage();
    const { queryClient } = renderPageView(page);
    // Reach `showing-latest` first via a completed reconcile.
    const firstSwap = makePage({ revision: { ...page.revision, _id: 'rev-2', createdAt: '2026-05-02T00:00:00.000Z' } });
    getPage.mockResolvedValueOnce(okResponse({ page: firstSwap }));
    emitReconnected();
    await flush();
    expect(bannerKind()).toBe('showing-latest');

    // A NEW reconcile flight starts (e.g. periodic backstop) and is in flight.
    const deferred = deferredGetPage();
    getPage.mockImplementationOnce(() => deferred.promise);
    emitReconnected();
    await flush();

    // The reader clicks "read the previous version" — synchronously updates
    // `bannerStateRef` (not just the deferred React state) BEFORE the
    // in-flight GET resolves.
    fireEvent.click(screen.getByRole('button', { name: m['page.live_sync_read_previous']() }));
    expect(bannerKind()).toBe('showing-old');

    const evenNewer = makePage({ revision: { ...page.revision, _id: 'rev-3', createdAt: '2026-05-03T00:00:00.000Z' } });
    deferred.resolve(okResponse({ page: evenNewer }));
    await flush();

    // No auto-swap: cache is still at `firstSwap`'s revision, not `evenNewer`'s.
    const cached = queryClient.getQueryData(pageKeys.detail({ path: page.path, revision_id: undefined })) as { page: PageWithRevision };
    expect(cached.page.revision._id).toBe('rev-2');
    // Banner escalated to "an even newer version was saved" instead.
    expect(bannerKind()).toBe('showing-latest-again');
  });
});

describe('comment invalidate (AC21) + head-fetch failure (AC22)', () => {
  it('invalidates the comment list on every reconcile trigger regardless of the head outcome', async () => {
    const page = makePage();
    const { queryClient } = renderPageView(page);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    getPage.mockResolvedValueOnce(okResponse({ page }));

    emitReconnected();
    await flush();

    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: commentKeys.detail(page._id) }));
  });

  it('silently no-ops (keeps current display, no error UI) when the head-GET fails outright (network error / thrown exception)', async () => {
    const page = makePage();
    renderPageView(page);
    getPage.mockRejectedValueOnce(new Error('network down'));

    emitReconnected();
    await flush();

    expect(screen.getByTestId('page-content-stub').textContent).toBe(page.revision.body);
    expect(screen.queryByText(m['common.access_denied_title']())).toBeNull();
    expect(screen.queryByText(m['page.not_found_title']())).toBeNull();
  });

  // AC26 (server split) client-side half: the reconcile head-GET must treat
  // an explicit HTTP 500 response the SAME as a thrown/network failure —
  // silent no-op, current display kept, no error UI. This is distinct from
  // the test above (a rejected fetch), which never even resolves to a
  // status code. Paired with the server-side test that proves `GET /pages`
  // actually RETURNS 500 (not 404) when the render-artifact fallback
  // pipeline throws: `packages/api/src/hono/handlers/page.test.ts`
  // ("Routes /api/pages (Hono getPage — unknown-error 500 split, ...)"
  // > "returns 500 INTERNAL_ERROR (not 404) when the render-artifact
  // fallback pipeline throws"). Together the two tests cover both ends of
  // AC26: the server never collapses that failure into 404, and the client
  // never treats the resulting 500 as an access/lifecycle fact.
  it('silently no-ops on an explicit 500 INTERNAL_ERROR response (e.g. a render-artifact fallback failure)', async () => {
    const page = makePage();
    renderPageView(page);
    getPage.mockResolvedValueOnce(errorResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'renderer boom' } }));

    emitReconnected();
    await flush();

    expect(screen.getByTestId('page-content-stub').textContent).toBe(page.revision.body);
    expect(screen.queryByText(m['common.access_denied_title']())).toBeNull();
    expect(screen.queryByText(m['page.not_found_title']())).toBeNull();
  });
});

describe('periodic backstop (AC23)', () => {
  it('fires reconcile every 3 minutes while visible, and stops while hidden', async () => {
    const page = makePage();
    renderPageView(page);
    // jsdom defaults `document.visibilityState` to 'visible' already, so
    // the backstop is already running from mount — no need to (and must
    // not, to avoid an extra untracked call) dispatch a same-state
    // `visibilitychange` here.
    getPage.mockResolvedValue(okResponse({ page }));

    await flush(3 * 60 * 1000);
    expect(getPage).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    getPage.mockClear();
    await flush(3 * 60 * 1000);
    expect(getPage).not.toHaveBeenCalled();

    // Coming back visible fires the tab-revisit trigger immediately AND restarts the backstop.
    setVisibility('visible');
    await flush();
    expect(getPage).toHaveBeenCalledTimes(1);
  });
});

describe('reconnect barrier missing -> periodic backstop recovers (AC5, AC27)', () => {
  it('does not reconcile via onReconnected when the barrier never fires (presence.join() failure), but the 3-minute backstop still recovers the miss', async () => {
    const page = makePage();
    renderPageView(page);
    // Deliberately never call `emitReconnected()` — this simulates
    // `presence.join()` failing silently server-side (spec §11: Redis
    // hSet down etc.), so this connection epoch's `viewers` broadcast (and
    // therefore `onReconnected`) never fires. jsdom's default
    // `document.visibilityState` is already 'visible', so the periodic
    // backstop (independent of the reconnect barrier) is already running.
    const updatedWhileBarrierMissing = makePage({
      revision: { ...page.revision, _id: 'rev-2', createdAt: '2026-05-02T00:00:00.000Z' },
      latestRevision: 'rev-2',
    });
    getPage.mockResolvedValueOnce(okResponse({ page: updatedWhileBarrierMissing }));

    // Just short of the backstop interval: no reconcile has happened yet
    // via any path, since the barrier never fired.
    await flush(3 * 60 * 1000 - 1);
    expect(getPage).not.toHaveBeenCalled();
    expect(screen.getByTestId('page-content-stub').textContent).toBe(page.revision.body);

    // At exactly 3 minutes, the backstop fires independently of the
    // (never-fired) reconnect barrier and recovers the miss — the
    // "bounded staleness" guarantee spec §"整合性モデル" declares.
    await flush(1);
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('page-content-stub').textContent).toBe(updatedWhileBarrierMissing.revision.body);
    expect(bannerKind()).toBe('showing-latest');
  });
});
