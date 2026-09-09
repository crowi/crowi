import type { PageWithRevision } from '@crowi/api-contract';
import { PageGrantEnum, PageStatusEnum } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `PageView` composes a large tree of hooks and child components. This test
 * is only about the layout ORDER of two independently-conditioned banners
 * (`RestrictedShareBanner` vs. `PortalizeBanner`, AC6) — not their internals
 * (covered by `restricted-share-banner.test.tsx` / `portalize-dialog`'s own
 * usage). Every leaf hook and content component is stubbed so this stays a
 * pure jsdom layout test — no network, no WS, no radix dialog internals for
 * the parts we don't care about.
 */
const { usePage } = vi.hoisted(() => ({ usePage: vi.fn() }));
const { usePageChildren } = vi.hoisted(() => ({ usePageChildren: vi.fn() }));
const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
const { usePresence } = vi.hoisted(() => ({ usePresence: vi.fn() }));
const { useMarkSeenOnView } = vi.hoisted(() => ({ useMarkSeenOnView: vi.fn() }));
const { useRevertDeletedPage } = vi.hoisted(() => ({ useRevertDeletedPage: vi.fn() }));
const { usePageGrantAccent } = vi.hoisted(() => ({ usePageGrantAccent: vi.fn() }));
const { routerReplace } = vi.hoisted(() => ({ routerReplace: vi.fn() }));

vi.mock('@/lib/use-page', () => ({ usePage }));
vi.mock('@/lib/use-page-children', () => ({ usePageChildren }));
vi.mock('@/lib/use-auth', () => ({ useAuth }));
vi.mock('@/lib/use-presence', () => ({ usePresence }));
vi.mock('@/lib/use-seen', () => ({ useMarkSeenOnView }));
vi.mock('@/lib/use-page-mutations', () => ({ useRevertDeletedPage }));
vi.mock('@/lib/use-page-grant-accent', () => ({ usePageGrantAccent }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: routerReplace, back: vi.fn() }) }));

// Content leaves are irrelevant to render ORDER of the two banners — stub
// each with an identifiable marker (their own behaviour has its own tests).
vi.mock('./page-header', () => ({ PageHeader: () => createElement('div', { 'data-testid': 'page-header-stub' }) }));
vi.mock('./page-content', () => ({ PageContent: () => createElement('div', { 'data-testid': 'page-content-stub' }) }));
vi.mock('./backlink-list', () => ({ BacklinkList: () => createElement('div', { 'data-testid': 'backlink-list-stub' }) }));
vi.mock('./attachment-list', () => ({ AttachmentList: () => createElement('div', { 'data-testid': 'attachment-list-stub' }) }));
vi.mock('@/components/page-comments', () => ({ PageComments: () => createElement('div', { 'data-testid': 'page-comments-stub' }) }));

import { PageView } from './page-view';

function makePage(overrides: Partial<PageWithRevision> = {}): PageWithRevision {
  return {
    _id: 'page-1',
    path: '/docs/guide/example',
    grant: PageGrantEnum.RESTRICTED,
    status: undefined,
    revision: {
      _id: 'rev-1',
      path: '/docs/guide/example',
      body: '# hi',
      format: 'markdown',
      createdAt: '2026-05-01T00:00:00.000Z',
      author: { _id: 'u1', username: 'alice', name: 'Alice', email: 'a@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
    },
    latestRevision: 'rev-1',
    creator: null,
    lastUpdateUser: { _id: 'u1', username: 'alice', name: 'Alice', email: 'a@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
    commentCount: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
    likerCount: 0,
    seenUsersCount: 0,
    ...overrides,
  } as PageWithRevision;
}

function renderPageView(page: PageWithRevision) {
  usePage.mockReturnValue({
    page,
    isLoading: false,
    isError: false,
    error: null,
    notFound: false,
    notGranted: false,
    redirectTo: null,
    isDeleted: false,
    refetch: vi.fn(),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return render(createElement(PageView, { path: page.path }), { wrapper });
}

beforeEach(() => {
  useAuth.mockReturnValue({ isAuthenticated: true });
  usePresence.mockReturnValue({ viewers: [], selfUserId: 'u1', status: 'connected' });
  useMarkSeenOnView.mockReturnValue(undefined);
  useRevertDeletedPage.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false, error: null });
  usePageGrantAccent.mockReturnValue(undefined);
  usePageChildren.mockReturnValue({ data: { children: [] } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PageView — a link that arrived percent-encoded twice', () => {
  const REAL_PATH = '/notes/2026/09/11/report draft(v2)';
  // What one decode of `.../report%2520draft(v2)` leaves behind: the escape
  // survives as the literal characters `%20`, so the lookup misses.
  const ASKED_PATH = '/notes/2026/09/11/report%20draft(v2)';

  const missing = {
    page: null,
    isLoading: false,
    isError: false,
    error: null,
    notFound: true,
    notGranted: false,
    redirectTo: null,
    isDeleted: false,
    refetch: vi.fn(),
  };

  const renderAt = (path: string) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
    return render(createElement(PageView, { path }), { wrapper });
  };

  it('sends the viewer to the page that does exist, instead of offering to create an empty one', () => {
    const real = makePage({ path: REAL_PATH, grant: PageGrantEnum.PUBLIC });
    usePage.mockImplementation((params: { path?: string }) => (params.path === REAL_PATH ? { ...missing, page: real, notFound: false } : missing));

    renderAt(ASKED_PATH);

    // `+` is the canonical URL form of a space, and the banner names where
    // the viewer came from — the same shape a renamed page redirects with.
    expect(routerReplace).toHaveBeenCalledWith(`/notes/2026/09/11/report+draft(v2)?redirectFrom=${encodeURIComponent(ASKED_PATH)}`);
    expect(screen.queryByText(m['page.not_found_title']())).toBeNull();
  });

  it('carries an explicitly requested revision through the recovery', () => {
    const real = makePage({ path: REAL_PATH, grant: PageGrantEnum.PUBLIC });
    usePage.mockImplementation((params: { path?: string }) => (params.path === REAL_PATH ? { ...missing, page: real, notFound: false } : missing));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
    render(createElement(PageView, { path: ASKED_PATH, revisionId: 'rev-old' }), { wrapper });

    expect(routerReplace).toHaveBeenCalledWith(`/notes/2026/09/11/report+draft(v2)?redirectFrom=${encodeURIComponent(ASKED_PATH)}&revision_id=rev-old`);
  });

  it('keeps the not-found card for the path the viewer asked for when the decoded candidate is missing too', () => {
    usePage.mockImplementation(() => missing);

    renderAt(ASKED_PATH);

    expect(routerReplace).not.toHaveBeenCalled();
    expect(screen.getByText(m['page.not_found_title']())).toBeTruthy();
  });

  it('never second-guesses a page that really is named with a percent escape', () => {
    const literal = makePage({ path: ASKED_PATH, grant: PageGrantEnum.PUBLIC });
    usePage.mockImplementation((params: { path?: string }) => (params.path === ASKED_PATH ? { ...missing, page: literal, notFound: false } : missing));

    renderAt(ASKED_PATH);

    expect(routerReplace).not.toHaveBeenCalled();
    expect(screen.queryByText(m['page.not_found_title']())).toBeNull();
  });
});

describe('PageView — RestrictedShareBanner / PortalizeBanner render order (AC6)', () => {
  it('renders RestrictedShareBanner BEFORE PortalizeBanner when both are eligible at once', () => {
    // Descendants under `/docs/guide/example/...` → showPortalizeBanner true,
    // combined with a published GRANT_RESTRICTED page → showRestrictedShareBanner true.
    usePageChildren.mockReturnValue({ data: { children: [{ path: '/docs/guide/example/child', hasChildren: false }] } });
    renderPageView(makePage({ grant: PageGrantEnum.RESTRICTED, status: PageStatusEnum.PUBLISHED }));

    const shareBanner = screen.getByText(m['page.share.restricted_banner_title']());
    const portalizeButton = screen.getByRole('button', { name: m['page_list.portalize_banner_action']() });

    // `Node.DOCUMENT_POSITION_FOLLOWING` set means `portalizeButton` comes
    // AFTER `shareBanner` in document order — i.e. the share banner is above.
    const position = shareBanner.compareDocumentPosition(portalizeButton);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders RestrictedShareBanner alone when the page has no descendants (no PortalizeBanner)', () => {
    usePageChildren.mockReturnValue({ data: { children: [] } });
    renderPageView(makePage({ grant: PageGrantEnum.RESTRICTED, status: undefined }));

    expect(screen.getByText(m['page.share.restricted_banner_title']())).toBeTruthy();
    expect(screen.queryByRole('button', { name: m['page_list.portalize_banner_action']() })).toBeNull();
  });

  it('renders PortalizeBanner alone when the page is not GRANT_RESTRICTED (no RestrictedShareBanner)', () => {
    usePageChildren.mockReturnValue({ data: { children: [{ path: '/docs/guide/example/child', hasChildren: false }] } });
    renderPageView(makePage({ grant: PageGrantEnum.PUBLIC, status: PageStatusEnum.PUBLISHED }));

    expect(screen.queryByText(m['page.share.restricted_banner_title']())).toBeNull();
    expect(screen.getByRole('button', { name: m['page_list.portalize_banner_action']() })).toBeTruthy();
  });
});
