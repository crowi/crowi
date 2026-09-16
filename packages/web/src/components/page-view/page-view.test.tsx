import type { PageWithRevision, TocEntryResponse } from '@crowi/api-contract';
import { PageGrantEnum, PageStatusEnum } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { PropsWithChildren, ReactNode } from 'react';
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
const { skipRouteFocusFor } = vi.hoisted(() => ({ skipRouteFocusFor: vi.fn() }));

vi.mock('@/lib/use-page', () => ({ usePage }));
vi.mock('@/lib/use-page-children', () => ({ usePageChildren }));
vi.mock('@/lib/use-auth', () => ({ useAuth }));
vi.mock('@/lib/use-presence', () => ({ usePresence }));
vi.mock('@/lib/use-seen', () => ({ useMarkSeenOnView }));
vi.mock('@/lib/use-page-mutations', () => ({ useRevertDeletedPage }));
vi.mock('@/lib/use-page-grant-accent', () => ({ usePageGrantAccent }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: routerReplace, back: vi.fn() }) }));
vi.mock('@/lib/use-route-focus', () => ({ skipRouteFocusFor }));

// Content leaves are irrelevant to render ORDER of the two banners — stub
// each with an identifiable marker (their own behaviour has its own tests).
vi.mock('./page-header', () => ({ PageHeader: () => createElement('div', { 'data-testid': 'page-header-stub' }) }));
vi.mock('./page-content', () => ({ PageContent: () => createElement('div', { 'data-testid': 'page-content-stub' }) }));
vi.mock('./artifact-view', () => ({ ArtifactView: () => createElement('div', { 'data-testid': 'artifact-view-stub' }) }));
vi.mock('./backlink-list', () => ({ BacklinkList: () => createElement('div', { 'data-testid': 'backlink-list-stub' }) }));
vi.mock('./attachment-list', () => ({ AttachmentList: () => createElement('div', { 'data-testid': 'attachment-list-stub' }) }));
vi.mock('@/components/page-comments', () => ({ PageComments: () => createElement('div', { 'data-testid': 'page-comments-stub' }) }));

// RFC-0020 (AC-CH-1/AC-CH-2) — `PageTocColumns` itself is unchanged by this
// feature (its own geometry stays correct precisely because nothing here
// edits it); it is stubbed JUST so `toc` / `railActions` become inspectable
// via data attributes AND `railActions` actually renders — a boolean flag
// alone can't prove the rail-mounted copy-markdown button is (or isn't) in
// the DOM (AC-CH-2). `children` renders through unchanged, so every other
// test in this file (banner order, over-encoded-path recovery) is unaffected.
vi.mock('./page-toc-columns', () => ({
  PageTocColumns: ({ toc, railActions, children }: { toc: TocEntryResponse[]; activeTocId: string | null; railActions?: ReactNode; children: ReactNode }) =>
    createElement(
      'div',
      { 'data-testid': 'page-toc-columns-stub', 'data-toc-length': String(toc.length), 'data-has-rail-actions': String(railActions != null) },
      createElement('div', { 'data-testid': 'rail-actions-slot' }, railActions ?? null),
      children,
    ),
}));

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
      contentType: 'markdown',
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

function renderPageView(page: PageWithRevision, usePageOverrides: { isDeleted?: boolean } = {}) {
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
    ...usePageOverrides,
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

  it('tells the route focus to sit out the recovery, so the page it lands on is not ringed', () => {
    const real = makePage({ path: REAL_PATH, grant: PageGrantEnum.PUBLIC });
    usePage.mockImplementation((params: { path?: string }) => (params.path === REAL_PATH ? { ...missing, page: real, notFound: false } : missing));

    renderAt(ASKED_PATH);

    expect(skipRouteFocusFor).toHaveBeenCalledWith(REAL_PATH);
    expect(skipRouteFocusFor.mock.invocationCallOrder[0]).toBeLessThan(routerReplace.mock.invocationCallOrder[0]);
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

describe('PageView — a path a rename left a redirect behind on', () => {
  const ASKED_PATH = '/notes/old name';
  const MOVED_TO = '/notes/2026/09/11/report';

  it('sends the viewer on, without the arrival ringing the page', () => {
    usePage.mockReturnValue({
      page: null,
      isLoading: false,
      isError: false,
      error: null,
      notFound: false,
      notGranted: false,
      redirectTo: MOVED_TO,
      isDeleted: false,
      refetch: vi.fn(),
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
    render(createElement(PageView, { path: ASKED_PATH }), { wrapper });

    expect(routerReplace).toHaveBeenCalledWith(`${MOVED_TO}?redirectFrom=${encodeURIComponent(ASKED_PATH)}`);
    expect(skipRouteFocusFor).toHaveBeenCalledWith(MOVED_TO);
    expect(skipRouteFocusFor.mock.invocationCallOrder[0]).toBeLessThan(routerReplace.mock.invocationCallOrder[0]);
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

function makeArtifactRevision(overrides: Partial<PageWithRevision['revision']> = {}): PageWithRevision['revision'] {
  return {
    _id: 'rev-artifact-1',
    path: '/docs/guide/example',
    body: '<!doctype html><html><body>hi</body></html>',
    format: 'artifact',
    createdAt: '2026-05-01T00:00:00.000Z',
    contentType: 'artifact',
    ...overrides,
  };
}

describe('PageView — artifact vs Markdown body rendering (feature-html-artifact-shell AC-SH-1, AC-SH-9)', () => {
  it('renders ArtifactView (not PageContent) for a page whose displayed Revision is an artifact (AC-SH-1)', () => {
    renderPageView(makePage({ revision: makeArtifactRevision(), latestRevision: 'rev-artifact-1' }));

    expect(screen.getByTestId('artifact-view-stub')).toBeTruthy();
    expect(screen.queryByTestId('page-content-stub')).toBeNull();
  });

  it('renders PageContent (not ArtifactView) for a Markdown page (AC-SH-1)', () => {
    renderPageView(makePage());

    expect(screen.getByTestId('page-content-stub')).toBeTruthy();
    expect(screen.queryByTestId('artifact-view-stub')).toBeNull();
  });

  it('never renders ArtifactView on the deleted-page card, even for an artifact-kind Revision (AC-SH-9)', () => {
    renderPageView(makePage({ revision: makeArtifactRevision(), latestRevision: 'rev-artifact-1' }), { isDeleted: true });

    expect(screen.queryByTestId('artifact-view-stub')).toBeNull();
    expect(screen.getByTestId('page-content-stub')).toBeTruthy();
  });
});

describe('PageView — artifact chrome: layout + menu + portalize banner (RFC-0020)', () => {
  const TWO_HEADINGS = [
    { level: 1, text: 'A', anchorId: 'a' },
    { level: 1, text: 'B', anchorId: 'b' },
  ];

  // AC-CH-1 — the exact wording of `EMPTY_TOC` here proves this is NOT
  // simply "the artifact revision happens to have no toc": the artifact
  // Revision below carries a 2-entry `meta.toc`, and it is still dropped.
  it('passes an empty toc and no railActions to PageTocColumns for an artifact page, wrapping ONLY ArtifactView in the negative-margin rail-reclaim div', () => {
    renderPageView(
      makePage({
        revision: makeArtifactRevision({ meta: { toc: TWO_HEADINGS } }),
        latestRevision: 'rev-artifact-1',
      }),
    );

    const columns = screen.getByTestId('page-toc-columns-stub');
    expect(columns.getAttribute('data-toc-length')).toBe('0');
    expect(columns.getAttribute('data-has-rail-actions')).toBe('false');

    // AC-CH-2 — no rail-mounted copy-markdown button node in the DOM (not
    // merely a falsy prop): the rail slot the stub renders `railActions`
    // into is empty for an artifact page.
    const railSlot = screen.getByTestId('rail-actions-slot');
    expect(railSlot.textContent).toBe('');
    expect(screen.queryByRole('button', { name: m['page.action_copy_markdown']() })).toBeNull();

    const artifactView = screen.getByTestId('artifact-view-stub');
    expect(artifactView.parentElement?.className).toContain('min-[1280px]:-mr-[calc(var(--shell-rail)+var(--shell-gap))]');
    // W-1 — the wrapper holds ONLY ArtifactView: sibling sections (backlink /
    // attachment / comments) stay at the normal prose width, not widened
    // along with it.
    expect(artifactView.parentElement?.children).toHaveLength(1);
    expect(artifactView.parentElement?.contains(screen.getByTestId('backlink-list-stub'))).toBe(false);
    expect(artifactView.parentElement?.contains(screen.getByTestId('page-comments-stub'))).toBe(false);
  });

  // AC-CH-1 (Markdown side of the same contract) / AC-CH-2 — a Markdown
  // page's toc and rail actions are unaffected by this leaf.
  it('passes the real toc and a railActions node to PageTocColumns for a Markdown page, rendering the rail copy-markdown button and no negative-margin wrapper', () => {
    renderPageView(makePage({ revision: { ...makePage().revision, meta: { toc: TWO_HEADINGS } } }));

    const columns = screen.getByTestId('page-toc-columns-stub');
    expect(columns.getAttribute('data-toc-length')).toBe('2');
    expect(columns.getAttribute('data-has-rail-actions')).toBe('true');

    // AC-CH-2 — the actual rail-mounted copy-markdown button is present for
    // a Markdown page (this leaf must not have broken it while adding the
    // artifact branch).
    expect(screen.getByRole('button', { name: m['page.action_copy_markdown']() })).toBeTruthy();

    // AC-CH-1 — the W-1 wrapper is exclusive to artifact pages: a Markdown
    // page's `PageContent` never gets the negative-margin treatment.
    const pageContent = screen.getByTestId('page-content-stub');
    expect(pageContent.parentElement?.className ?? '').not.toContain('min-[1280px]:-mr-[calc(var(--shell-rail)+var(--shell-gap))]');
  });

  // AC-CH-5 — the portalize banner is suppressed for an artifact page even
  // when every other condition that would show it holds (public,
  // published, has descendants).
  it('suppresses the portalize banner for an artifact page with descendants, but shows it for an equivalent Markdown page', () => {
    usePageChildren.mockReturnValue({ data: { children: [{ path: '/docs/guide/example/child', hasChildren: false }] } });

    renderPageView(
      makePage({
        revision: makeArtifactRevision(),
        latestRevision: 'rev-artifact-1',
        grant: PageGrantEnum.PUBLIC,
        status: PageStatusEnum.PUBLISHED,
      }),
    );
    expect(screen.queryByRole('button', { name: m['page_list.portalize_banner_action']() })).toBeNull();

    cleanup();
    usePageChildren.mockReturnValue({ data: { children: [{ path: '/docs/guide/example/child', hasChildren: false }] } });
    renderPageView(makePage({ grant: PageGrantEnum.PUBLIC, status: PageStatusEnum.PUBLISHED }));
    expect(screen.getByRole('button', { name: m['page_list.portalize_banner_action']() })).toBeTruthy();
  });
});
