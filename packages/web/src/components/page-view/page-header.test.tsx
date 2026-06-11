import type { PageWithRevision } from '@crowi/api-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { PropsWithChildren, ReactElement } from 'react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@/lib/use-presence', () => ({ usePresence }));
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
  usePresence.mockReturnValue({ viewers: [], selfUserId: 'u1', status: 'connected' });
  useBacklinks.mockReturnValue({ data: { backlinks: [], hasNext: false } });
  useLikers.mockReturnValue({ data: { users: [], totalCount: 0 }, isLoading: false });
  useSeenUsers.mockReturnValue({ data: { seenUsers: [], seenUsersCount: 0 }, isLoading: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Mark the sticky header as scrolled past `H` → compact layout. */
function mockCompact() {
  useStickyHeader.mockReturnValue({ compact: true });
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
    expect(document.querySelector('header')?.getAttribute('data-compact')).toBe('false');
    expect(screen.getByTestId('page-header-expanded')).toBeTruthy();
    // No fixed compact bar while expanded.
    expect(screen.queryByTestId('page-header-compact')).toBeNull();
  });

  it('keeps the expanded header in normal flow (the placeholder wrapper is visible, not invisible)', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    // While expanded the measurement/placeholder wrapper is the visible
    // header — it must not carry the `invisible` class.
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
    expect(screen.queryByTestId('sticky-header-placeholder')).toBeNull();
    expect(screen.queryByTestId('page-header-compact')).toBeNull();
    expect(document.querySelector('header')?.getAttribute('data-compact')).toBe('false');
  });
});

describe('PageHeader — compact state', () => {
  beforeEach(() => {
    mockCompact();
  });

  /** The fixed compact bar. The compact-layout assertions scope here. */
  function compactBar() {
    return within(screen.getByTestId('page-header-compact'));
  }

  it('marks the header as compact when scrolled past H', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    expect(document.querySelector('header')?.getAttribute('data-compact')).toBe('true');
  });

  it('mounts a fixed compact bar with the compact-layout classes', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
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
    expect(screen.getByRole('menuitem', { name: 'タイトルとURL' })).toBeTruthy();
  });

  it('renders the live presence row at compact size in the compact bar', () => {
    usePresence.mockReturnValue({
      viewers: [
        { userId: 'u1', username: 'me', displayName: 'Me', avatarUrl: null, isEditing: false, joinedAt: 1 },
        { userId: 'u2', username: 'bob', displayName: 'Bob', avatarUrl: null, isEditing: false, joinedAt: 2 },
      ],
      selfUserId: 'u1',
      status: 'connected',
    });
    renderHeader(<PageHeader page={makePage()} sticky showActions showPresence />);
    expect(compactBar().getByTestId('live-presence-row').getAttribute('data-size')).toBe('compact');
  });
});

describe('PageHeader — placeholder keeps document flow constant', () => {
  it('the placeholder wrapper is present in BOTH expanded and compact states', () => {
    // Expanded: the wrapper is the visible header.
    useStickyHeader.mockReturnValue({ compact: false });
    const { unmount } = renderHeader(<PageHeader page={makePage()} sticky showActions />);
    expect(screen.getByTestId('sticky-header-placeholder')).toBeTruthy();
    unmount();
    cleanup();

    // Compact: the same wrapper survives in flow as the H-tall spacer.
    useStickyHeader.mockReturnValue({ compact: true });
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    expect(screen.getByTestId('sticky-header-placeholder')).toBeTruthy();
  });
});
