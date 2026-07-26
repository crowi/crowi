import type { PageWithRevision, TocEntryResponse } from '@crowi/api-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { PropsWithChildren, ReactElement } from 'react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchMediaImpl } from '@/lib/test-utils/mocks';
import { WIDE_VIEWPORT_QUERY } from '@/lib/use-wide-viewport';

// PageHeader composes a tree of data-driven children. Mock every leaf
// hook so the test is pure layout — no react-query, no API, no WS.
const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
const { useStickyHeader, useMeasuredHeight } = vi.hoisted(() => ({ useStickyHeader: vi.fn(), useMeasuredHeight: vi.fn() }));
const { useToggleLike } = vi.hoisted(() => ({ useToggleLike: vi.fn() }));
const { useWatchStatus, useToggleWatch } = vi.hoisted(() => ({ useWatchStatus: vi.fn(), useToggleWatch: vi.fn() }));
const { useToggleBookmark } = vi.hoisted(() => ({ useToggleBookmark: vi.fn() }));
const { useAppInfo } = vi.hoisted(() => ({ useAppInfo: vi.fn() }));
const { usePresence } = vi.hoisted(() => ({ usePresence: vi.fn() }));
const { useBacklinks } = vi.hoisted(() => ({ useBacklinks: vi.fn() }));
const { useLikers } = vi.hoisted(() => ({ useLikers: vi.fn() }));
const { useSeenUsers } = vi.hoisted(() => ({ useSeenUsers: vi.fn() }));

vi.mock('@/lib/use-auth', () => ({ useAuth }));
vi.mock('@/lib/use-sticky-header', () => ({ useStickyHeader, useMeasuredHeight }));
vi.mock('@/lib/use-like', () => ({ useToggleLike }));
vi.mock('@/lib/use-watch', () => ({ useWatchStatus, useToggleWatch }));
vi.mock('@/lib/use-bookmark', () => ({ useToggleBookmark }));
vi.mock('@/lib/use-app-info', () => ({ useAppInfo }));
vi.mock('@/lib/use-presence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/use-presence')>();
  return { ...actual, usePresence };
});
vi.mock('@/lib/use-backlinks', () => ({ useBacklinks }));
vi.mock('@/lib/use-likers', () => ({ useLikers, likersKeys: { pagePrefix: (id: string) => ['likers', id] } }));
vi.mock('@/lib/use-seen', () => ({ useSeenUsers }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));

import { PageHeader } from './page-header';

function makePage(overrides: Partial<PageWithRevision> = {}): PageWithRevision {
  return {
    _id: 'page-1',
    path: '/docs/guide/example',
    revision: {
      _id: 'rev-1',
      path: '/docs/guide/example',
      body: '# hi',
      format: 'markdown',
      createdAt: '2026-05-01T00:00:00.000Z',
      author: { _id: 'u1', username: 'alice', name: 'Alice', email: 'a@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
    },
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

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // Radix dropdown/menu primitives call these in jsdom, which lacks them.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};

  useAuth.mockReturnValue({ user: { id: 'u1' }, isAuthenticated: true });
  // Expanded by default. `H` is the measured expanded-header height that
  // both the placeholder spacer and the `scrollY >= H` trigger key off.
  useStickyHeader.mockReturnValue({ compact: false });
  useMeasuredHeight.mockReturnValue({ ref: { current: null }, height: 240 });
  useToggleLike.mockReturnValue({ toggle: vi.fn(), isPending: false, isError: false, error: null });
  useWatchStatus.mockReturnValue({ isLoading: false });
  useToggleWatch.mockReturnValue({ watching: false, toggle: vi.fn(), isPending: false, isError: false, error: null });
  useToggleBookmark.mockReturnValue({ isBookmarked: false, toggle: vi.fn(), isPending: false, isError: false, error: null });
  useAppInfo.mockReturnValue({ data: { title: 'Crowi' } });
  usePresence.mockReturnValue({ viewers: [], selfUserId: 'u1', status: 'connected', hasViewersForConnection: false });
  useBacklinks.mockReturnValue({ data: { backlinks: [], hasNext: false } });
  useLikers.mockReturnValue({ data: { users: [], totalCount: 0 }, isLoading: false });
  useSeenUsers.mockReturnValue({ data: { seenUsers: [], seenUsersCount: 0 }, isLoading: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/** Mark the sticky header as scrolled past `H` → compact layout. */
function mockCompact() {
  useStickyHeader.mockReturnValue({ compact: true });
}

/**
 * feature-mobile-presence-card — the header now renders DIFFERENT DOM per
 * viewport (`useWideViewport`, a `matchMedia('(min-width: 768px)')`
 * subscription) instead of styling one tree two ways, so a test has to say
 * which viewport it is on. The global jsdom stub reports "no match" for
 * every query, i.e. NARROW — the mobile layout — by default; call this to
 * get the `md`+ desktop layout instead.
 */
function mockWideViewport() {
  vi.spyOn(window, 'matchMedia').mockImplementation(matchMediaImpl((query) => query === WIDE_VIEWPORT_QUERY));
}

/**
 * PageHeader nests dialog components that call `useQueryClient`; render
 * inside a fresh QueryClient so those mounts succeed.
 */
function renderHeader(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return render(ui, { wrapper });
}

describe('PageHeader — expanded state', () => {
  it('renders the expanded header (no compact bar) when sticky is enabled but not scrolled', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    // <header> has implicit role "banner"; query it semantically, then check the data-attribute.
    expect(screen.getByRole('banner').getAttribute('data-compact')).toBe('false');
    // page-header-expanded / page-header-compact are layout-state containers with no
    // accessible role; getByTestId / queryByTestId are the only portable way to reach them.
    expect(screen.getByTestId('page-header-expanded')).toBeTruthy();
    // No fixed compact bar while expanded.
    expect(screen.queryByTestId('page-header-compact')).toBeNull();
  });

  it('keeps the expanded header in normal flow (the placeholder wrapper is visible, not invisible)', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    // While expanded the measurement/placeholder wrapper is the visible
    // header — it must not carry the `invisible` class.
    // sticky-header-placeholder is a layout-state wrapper with no accessible role;
    // getByTestId is the only portable way to reach it.
    const placeholder = screen.getByTestId('sticky-header-placeholder');
    expect(placeholder.className).not.toContain('invisible');
    expect(placeholder.getAttribute('aria-hidden')).toBe('false');
  });

  it('shows the breadcrumb in the expanded state', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    // The breadcrumb renders a Home link plus a link per parent segment.
    expect(screen.getByRole('link', { name: /Home/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'guide' })).toBeTruthy();
  });

  it('renders the like button with its text label in the expanded state', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    // The expanded like button is a text button (variant outline, size sm).
    const likeButton = screen.getByRole('button', { name: 'いいねを追加' });
    expect(likeButton.textContent).toContain('いいね');
  });

  it('renders no placeholder and no compact bar when sticky is disabled', () => {
    renderHeader(<PageHeader page={makePage()} showActions />);
    // sticky-header-placeholder / page-header-compact are layout-state containers with no
    // accessible role; queryByTestId is the only portable way to check absence.
    expect(screen.queryByTestId('sticky-header-placeholder')).toBeNull();
    expect(screen.queryByTestId('page-header-compact')).toBeNull();
    // <header> has implicit role "banner"; query it semantically, then check the data-attribute.
    expect(screen.getByRole('banner').getAttribute('data-compact')).toBe('false');
  });
});

describe('PageHeader — compact state', () => {
  beforeEach(() => {
    mockCompact();
  });

  /** The fixed compact bar. The compact-layout assertions scope here.
   * page-header-compact is a layout-state wrapper with no accessible role;
   * getByTestId is the only portable way to reach it. */
  function compactBar() {
    return within(screen.getByTestId('page-header-compact'));
  }

  it('marks the header as compact when scrolled past H', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    // <header> has implicit role "banner"; query it semantically, then check the data-attribute.
    expect(screen.getByRole('banner').getAttribute('data-compact')).toBe('true');
  });

  it('mounts a fixed compact bar with the compact-layout classes', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    // page-header-compact is a layout-state wrapper with no accessible role;
    // getByTestId is the only portable way to reach it for className inspection.
    const bar = screen.getByTestId('page-header-compact');
    expect(bar.className).toContain('fixed');
    expect(bar.className).toContain('top-0');
    // z-30 keeps the compact bar below the `(auth)` app header (z-40).
    expect(bar.className).toContain('z-30');
  });

  it('keeps the expanded header in flow as the placeholder (invisible) so content does not shift', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    // The expanded layout stays mounted and in flow — its measurement
    // wrapper is the placeholder spacer of height H. It is `invisible`
    // (still occupies space) so the article below never moves.
    // sticky-header-placeholder and page-header-expanded are layout-state wrappers
    // with no accessible role; getByTestId is the only portable way to reach them.
    const placeholder = screen.getByTestId('sticky-header-placeholder');
    expect(placeholder.className).toContain('invisible');
    expect(placeholder.getAttribute('aria-hidden')).toBe('true');
    expect(within(placeholder).getByTestId('page-header-expanded')).toBeTruthy();
  });

  it('shows no breadcrumb in the compact bar', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    expect(compactBar().queryByRole('link', { name: /Home/ })).toBeNull();
    expect(compactBar().queryByRole('link', { name: 'guide' })).toBeNull();
  });

  it('shows only the path tail as the title in the compact bar', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    // /docs/guide/example → "example"; the full path is not rendered.
    expect(compactBar().getByRole('heading', { level: 1 }).textContent).toBe('example');
  });

  it('renders the like button icon-only (no text label) in the compact bar', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    expect(compactBar().queryByText('いいね')).toBeNull();
    // The icon-only like button still exposes its accessible name.
    expect(compactBar().getByLabelText('いいねを追加')).toBeTruthy();
  });

  it('does not render the meta-chip row in the compact bar', () => {
    renderHeader(<PageHeader page={makePage({ commentCount: 3 })} sticky showActions />);
    // The meta-chip row carries the localized "... に更新" timestamp.
    expect(compactBar().queryByText(/に更新/)).toBeNull();
  });

  it('collapses watch / bookmark / link into the dotmenu in the compact bar', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    // watch / bookmark / link are not standalone controls in the bar.
    expect(compactBar().queryByLabelText('ウォッチする')).toBeNull();
    expect(compactBar().queryByLabelText('ブックマークを追加')).toBeNull();
    expect(compactBar().queryByLabelText('リンクを共有')).toBeNull();

    // They appear inside the dotmenu instead. Radix opens the menu on
    // pointerdown; jsdom needs an explicit PointerEvent.
    const trigger = compactBar().getByLabelText('その他のアクション');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'ウォッチ' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'ブックマーク' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'URLをコピー' })).toBeTruthy();
  });

  it('renders the live presence row at compact size in the compact bar', () => {
    // Desktop viewport: the compact bar's presence surface is the (
    // unchanged) compact avatar strip. Narrow viewports get the mobile
    // `Live · N` trigger there instead — see the mobile describe below.
    mockWideViewport();
    // `usePresence` is now hoisted to PageView; PageHeader receives the
    // result as a prop. The `showPresence && isAuthenticated && presence`
    // gate needs a non-null `presence` to render the row, so pass a mock
    // `UsePresenceResult` directly (the other 15 call sites render without
    // presence and rely on the gate hiding the row).
    const presence = {
      viewers: [
        { userId: 'u1', username: 'me', displayName: 'Me', avatarUrl: null, isEditing: false, joinedAt: 1 },
        { userId: 'u2', username: 'bob', displayName: 'Bob', avatarUrl: null, isEditing: false, joinedAt: 2 },
      ],
      selfUserId: 'u1',
      status: 'connected' as const,
      pageUpdatedSeq: { current: 0 },
      hasViewersForConnection: true,
    };
    renderHeader(<PageHeader page={makePage()} sticky showActions showPresence presence={presence} />);
    // live-presence-row is a layout row with a data-size attribute but no accessible role;
    // getByTestId is the only portable way to reach it for data-size inspection.
    expect(compactBar().getByTestId('live-presence-row').getAttribute('data-size')).toBe('compact');
  });
});

describe('PageHeader — placeholder keeps document flow constant', () => {
  it('the placeholder wrapper is present in BOTH expanded and compact states', () => {
    // Expanded: the wrapper is the visible header.
    useStickyHeader.mockReturnValue({ compact: false });
    const { unmount } = renderHeader(<PageHeader page={makePage()} sticky showActions />);
    // sticky-header-placeholder is a layout-state wrapper with no accessible role;
    // getByTestId is the only portable way to reach it.
    expect(screen.getByTestId('sticky-header-placeholder')).toBeTruthy();
    unmount();
    cleanup();

    // Compact: the same wrapper survives in flow as the H-tall spacer.
    useStickyHeader.mockReturnValue({ compact: true });
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    expect(screen.getByTestId('sticky-header-placeholder')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// feature-mobile-presence-card
// ---------------------------------------------------------------------------

function makeToc(): TocEntryResponse[] {
  return [
    { level: 1, text: 'Intro', anchorId: 'intro' },
    { level: 1, text: 'Details', anchorId: 'details' },
  ];
}

const presenceTwoViewers = {
  viewers: [
    { userId: 'u1', username: 'me', displayName: 'Me', avatarUrl: null, isEditing: false, joinedAt: 1 },
    { userId: 'u2', username: 'bob', displayName: 'Bob', avatarUrl: null, isEditing: false, joinedAt: 2 },
  ],
  selfUserId: 'u1',
  status: 'connected' as const,
  pageUpdatedSeq: { current: 0 },
  hasViewersForConnection: true,
};

// 6 viewers so `LivePresenceRow`'s desktop `[+N]` overflow popover exists
// too (5 inline max).
const presenceSixViewers = {
  ...presenceTwoViewers,
  viewers: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'].map((id, i) => ({
    userId: id,
    username: id,
    displayName: `User ${id}`,
    avatarUrl: null,
    isEditing: false,
    joinedAt: i,
  })),
};

describe('PageHeader — mobile presence card DOM order', () => {
  it('places title -> meta (author/updated) -> statistics chips -> presence card slot in that document order', () => {
    renderHeader(<PageHeader page={makePage({ commentCount: 2 })} sticky showActions showPresence presence={presenceTwoViewers} />);
    const title = screen.getByRole('heading', { level: 1 });
    const metaTimestamp = screen.getByText(/に更新/);
    const card = screen.getByTestId('mobile-presence-card-slot');

    // Node.DOCUMENT_POSITION_FOLLOWING (4): the argument follows the node
    // compareDocumentPosition was called on.
    expect(title.compareDocumentPosition(metaTimestamp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(metaTimestamp.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('page-header-expanded').contains(card)).toBe(true);
  });

  it('AC: the pre-restructure outer presence/TOC row is NOT RENDERED below 768px (not merely display:none)', () => {
    // The default jsdom matchMedia stub reports "no match" → narrow.
    renderHeader(<PageHeader page={makePage()} sticky showActions showPresence presence={presenceTwoViewers} toc={makeToc()} />);
    // Not "hidden", not "display:none" — absent from the DOM entirely, so
    // it can neither reserve vertical rhythm nor mount a `LivePresenceRow`
    // this viewport never shows.
    expect(screen.queryByTestId('presence-toc-row-desktop')).toBeNull();
    expect(screen.queryByTestId('live-presence-row')).toBeNull();
    // ...and the TOC, which DOES belong at this width, gets its own row in
    // the same pre-title position.
    expect(screen.getByTestId('presence-toc-row-mobile')).toBeTruthy();
  });

  it('renders the pre-title presence/TOC row at 768px and up', () => {
    mockWideViewport();
    renderHeader(<PageHeader page={makePage()} sticky showActions showPresence presence={presenceTwoViewers} toc={makeToc()} />);
    expect(screen.getByTestId('presence-toc-row-desktop')).toBeTruthy();
    // ...and then the mobile-only TOC row is the one that does not exist.
    expect(screen.queryByTestId('presence-toc-row-mobile')).toBeNull();
  });

  it('does not render the mobile presence card at 768px and up', () => {
    mockWideViewport();
    renderHeader(<PageHeader page={makePage()} sticky showActions showPresence presence={presenceTwoViewers} />);
    expect(screen.queryByTestId('mobile-presence-card-slot')).toBeNull();
  });

  it('renders a mobile-only TOC row (no presence) when the TOC is needed and presence is off', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions toc={makeToc()} />);
    const mobileRow = screen.getByTestId('presence-toc-row-mobile');
    expect(mobileRow.className).toContain('md:hidden');
    expect(within(mobileRow).getByLabelText('目次')).toBeTruthy();
  });

  it('does not render the mobile TOC row when there is no TOC to show', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    expect(screen.queryByTestId('presence-toc-row-mobile')).toBeNull();
  });

  it('replaces the card with the short Live · N trigger inside the 60px compact bar (never both)', () => {
    mockCompact();
    renderHeader(<PageHeader page={makePage()} sticky showActions showPresence presence={presenceTwoViewers} />);
    const bar = screen.getByTestId('page-header-compact');
    expect(bar.className).toContain('h-[60px]');
    expect(within(bar).getByText('Live')).toBeTruthy();
    // The full card exists only in the (inert) expanded placeholder — the
    // bar itself must not duplicate it.
    expect(within(bar).queryByTestId('mobile-presence-card-slot')).toBeNull();
  });
});

describe('PageHeader — desktop presence strip unchanged', () => {
  beforeEach(() => {
    mockWideViewport();
  });

  it('still renders the desktop avatar strip (LivePresenceRow) inside the desktop-only row', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions showPresence presence={presenceTwoViewers} />);
    const desktopRow = screen.getByTestId('presence-toc-row-desktop');
    expect(within(desktopRow).getByTestId('live-presence-row').getAttribute('data-size')).toBe('default');
    // The desktop avatar strip's own viewer names are reachable via its
    // Tooltip trigger (accessible-name-less avatar, so assert structurally
    // by counting rendered avatar list items instead).
    expect(within(desktopRow).getByRole('list')).toBeTruthy();
  });

  it('does not render MobilePresenceCard content duplicated inside the desktop row', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions showPresence presence={presenceTwoViewers} />);
    const desktopRow = screen.getByTestId('presence-toc-row-desktop');
    expect(within(desktopRow).queryByTestId('mobile-presence-card-slot')).toBeNull();
  });
});

describe('PageHeader — compact-transition forceClose + focus handoff', () => {
  function openDropdown(trigger: HTMLElement) {
    // Radix DropdownMenu opens on pointerdown; jsdom needs an explicit
    // PointerEvent (same workaround the existing dotmenu test uses).
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(trigger);
  }

  it('force-closes LinkSharePopover (desktop) when the header compacts', () => {
    useStickyHeader.mockReturnValue({ compact: false });
    const { rerender } = renderHeader(<PageHeader page={makePage()} sticky showActions />);
    const trigger = screen.getByLabelText('リンクを共有');
    openDropdown(trigger);
    expect(screen.getByRole('menu')).toBeTruthy();

    useStickyHeader.mockReturnValue({ compact: true });
    rerender(<PageHeader page={makePage()} sticky showActions />);

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('moves focus to the compact scroll-to-top button when the header compacts while focus was inside the expanded subtree', () => {
    useStickyHeader.mockReturnValue({ compact: false });
    const { rerender } = renderHeader(<PageHeader page={makePage()} sticky showActions />);
    // Focus an ordinary (non-menu-opening) control inside the expanded
    // subtree — the focus-handoff mechanism is independent of whether an
    // overlay happens to be open; it only cares whether `document.
    // activeElement` was somewhere inside the soon-to-be-`inert`
    // placeholder.
    const trigger = screen.getByLabelText('リンクを共有');
    act(() => {
      trigger.focus();
    });
    expect(document.activeElement).toBe(trigger);

    useStickyHeader.mockReturnValue({ compact: true });
    rerender(<PageHeader page={makePage()} sticky showActions />);

    // Focus moved to the compact bar's scroll-to-top button — the one
    // control guaranteed to exist whenever `compact` is true — rather
    // than being lost to `<body>` once the placeholder becomes `inert`.
    expect(document.activeElement).toBe(screen.getByLabelText('ページ上部へスクロール'));
  });

  it('leaves focus untouched when it was already outside the expanded subtree at compact time', () => {
    useStickyHeader.mockReturnValue({ compact: false });
    const { rerender } = renderHeader(<PageHeader page={makePage()} sticky showActions />);
    document.body.tabIndex = -1;
    act(() => {
      document.body.focus();
    });
    expect(document.activeElement).toBe(document.body);

    useStickyHeader.mockReturnValue({ compact: true });
    rerender(<PageHeader page={makePage()} sticky showActions />);

    expect(document.activeElement).toBe(document.body);
  });

  it('force-closes the desktop PageActionsMenu dotmenu when the header compacts', () => {
    useStickyHeader.mockReturnValue({ compact: false });
    const { rerender } = renderHeader(<PageHeader page={makePage()} sticky showActions />);
    // Two "その他のアクション" triggers exist (mobile + desktop instances);
    // the desktop one lives in the `hidden md:inline-flex` wrapper.
    const triggers = screen.getAllByLabelText('その他のアクション');
    for (const trigger of triggers) openDropdown(trigger);
    expect(screen.getAllByRole('menu').length).toBeGreaterThan(0);

    useStickyHeader.mockReturnValue({ compact: true });
    rerender(<PageHeader page={makePage()} sticky showActions />);
    expect(screen.queryAllByRole('menu')).toHaveLength(0);
  });

  it('force-closes the expanded PageTocMenu popover when the header compacts', () => {
    mockWideViewport();
    useStickyHeader.mockReturnValue({ compact: false });
    const { rerender } = renderHeader(<PageHeader page={makePage()} sticky showActions toc={makeToc()} />);
    const desktopRow = screen.getByTestId('presence-toc-row-desktop');
    const trigger = within(desktopRow).getByLabelText('目次');
    fireEvent.click(trigger);
    expect(screen.getByText('Intro')).toBeTruthy();

    useStickyHeader.mockReturnValue({ compact: true });
    rerender(<PageHeader page={makePage()} sticky showActions toc={makeToc()} />);
    expect(screen.queryByText('Intro')).toBeNull();
  });

  it('force-closes the desktop LivePresenceRow [+N] overflow popover when the header compacts', () => {
    mockWideViewport();
    useStickyHeader.mockReturnValue({ compact: false });
    const { rerender } = renderHeader(<PageHeader page={makePage()} sticky showActions showPresence presence={presenceSixViewers} />);
    // 6 viewers, 5 inline max -> a `+1` overflow trigger.
    fireEvent.click(screen.getByText('+1'));
    expect(screen.getByText('User u6')).toBeTruthy();

    useStickyHeader.mockReturnValue({ compact: true });
    rerender(<PageHeader page={makePage()} sticky showActions showPresence presence={presenceSixViewers} />);
    expect(screen.queryByText('User u6')).toBeNull();
  });

  it("force-closes the mobile card's own viewer Sheet when the header compacts", () => {
    useStickyHeader.mockReturnValue({ compact: false });
    const { rerender } = renderHeader(<PageHeader page={makePage()} sticky showActions showPresence presence={presenceTwoViewers} />);
    const cardButton = screen.getByRole('button', { name: /閲覧中/ });
    fireEvent.click(cardButton);
    expect(screen.getByRole('dialog')).toBeTruthy();

    useStickyHeader.mockReturnValue({ compact: true });
    rerender(<PageHeader page={makePage()} sticky showActions showPresence presence={presenceTwoViewers} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('force-closes PageActionsMenu-owned dialogs (e.g. rename) when the header compacts, not just the dotmenu itself', () => {
    useStickyHeader.mockReturnValue({ compact: false });
    const { rerender } = renderHeader(<PageHeader page={makePage()} sticky showActions />);
    const triggers = screen.getAllByLabelText('その他のアクション');
    openDropdown(triggers[0]);
    fireEvent.click(screen.getByText('リネーム'));
    expect(screen.getByRole('dialog')).toBeTruthy();

    useStickyHeader.mockReturnValue({ compact: true });
    rerender(<PageHeader page={makePage()} sticky showActions />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('force-closes MetaChipRow-owned dialogs (e.g. likers) when the header compacts', () => {
    useStickyHeader.mockReturnValue({ compact: false });
    const page = makePage({ likerCount: 1 });
    const { rerender } = renderHeader(<PageHeader page={page} sticky showActions />);
    fireEvent.click(screen.getByLabelText('1 件のいいね — いいねした人を表示'));
    expect(screen.getByRole('dialog')).toBeTruthy();

    useStickyHeader.mockReturnValue({ compact: true });
    rerender(<PageHeader page={page} sticky showActions />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('PageHeader — placeholder inert / tab exclusion', () => {
  it('the placeholder is not inert while expanded', () => {
    useStickyHeader.mockReturnValue({ compact: false });
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    expect(screen.getByTestId('sticky-header-placeholder')).not.toHaveAttribute('inert');
  });

  it('the placeholder becomes inert once compact — hidden expanded controls are excluded from tab order', () => {
    useStickyHeader.mockReturnValue({ compact: true });
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    expect(screen.getByTestId('sticky-header-placeholder')).toHaveAttribute('inert');
  });
});
