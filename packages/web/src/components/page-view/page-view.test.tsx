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

vi.mock('@/lib/use-page', () => ({ usePage }));
vi.mock('@/lib/use-page-children', () => ({ usePageChildren }));
vi.mock('@/lib/use-auth', () => ({ useAuth }));
vi.mock('@/lib/use-presence', () => ({ usePresence }));
vi.mock('@/lib/use-seen', () => ({ useMarkSeenOnView }));
vi.mock('@/lib/use-page-mutations', () => ({ useRevertDeletedPage }));
vi.mock('@/lib/use-page-grant-accent', () => ({ usePageGrantAccent }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));

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
