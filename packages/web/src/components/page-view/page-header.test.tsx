import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren, ReactElement } from 'react';
import { createElement } from 'react';
import type { PageWithRevision } from '@crowi/api-contract';

// PageHeader composes a tree of data-driven children. Mock every leaf
// hook so the test is pure layout — no react-query, no API, no WS.
const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
const { useStickyHeader } = vi.hoisted(() => ({ useStickyHeader: vi.fn() }));
const { useToggleLike } = vi.hoisted(() => ({ useToggleLike: vi.fn() }));
const { useWatchStatus, useToggleWatch } = vi.hoisted(() => ({ useWatchStatus: vi.fn(), useToggleWatch: vi.fn() }));
const { useToggleBookmark } = vi.hoisted(() => ({ useToggleBookmark: vi.fn() }));
const { useAppInfo } = vi.hoisted(() => ({ useAppInfo: vi.fn() }));
const { usePresence } = vi.hoisted(() => ({ usePresence: vi.fn() }));
const { useBacklinks } = vi.hoisted(() => ({ useBacklinks: vi.fn() }));
const { useLikers } = vi.hoisted(() => ({ useLikers: vi.fn() }));
const { useSeenUsers } = vi.hoisted(() => ({ useSeenUsers: vi.fn() }));

vi.mock('@/lib/use-auth', () => ({ useAuth }));
vi.mock('@/lib/use-sticky-header', () => ({ useStickyHeader }));
vi.mock('@/lib/use-like', () => ({ useToggleLike }));
vi.mock('@/lib/use-watch', () => ({ useWatchStatus, useToggleWatch }));
vi.mock('@/lib/use-bookmark', () => ({ useToggleBookmark }));
vi.mock('@/lib/use-app-info', () => ({ useAppInfo }));
vi.mock('@/lib/use-presence', () => ({ usePresence }));
vi.mock('@/lib/use-backlinks', () => ({ useBacklinks }));
vi.mock('@/lib/use-likers', () => ({ useLikers, likersKeys: { pagePrefix: (id: string) => ['likers', id] } }));
vi.mock('@/lib/use-seen', () => ({ useSeenUsers }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

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
  useStickyHeader.mockReturnValue({ sentinelRef: { current: null }, compact: false });
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

/** Mark the sticky header as scrolled past → compact layout. */
function mockCompact() {
  useStickyHeader.mockReturnValue({ sentinelRef: { current: null }, compact: true });
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
  it('renders a sticky header with a sentinel when sticky is enabled', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    const header = document.querySelector('header');
    expect(header?.className).toContain('sticky');
    expect(header?.className).toContain('top-0');
    expect(screen.getByTestId('sticky-header-sentinel')).toBeTruthy();
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

  it('renders no sentinel and no sticky class when sticky is disabled', () => {
    renderHeader(<PageHeader page={makePage()} showActions />);
    expect(screen.queryByTestId('sticky-header-sentinel')).toBeNull();
    expect(document.querySelector('header')?.className).not.toContain('sticky');
  });
});

describe('PageHeader — compact state', () => {
  beforeEach(() => {
    mockCompact();
  });

  it('marks the header as compact when scrolled past the sentinel', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    expect(document.querySelector('header')?.getAttribute('data-compact')).toBe('true');
  });

  it('hides the breadcrumb in the compact state', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    expect(screen.queryByRole('link', { name: /Home/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'guide' })).toBeNull();
  });

  it('shows only the path tail as the title in the compact state', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    // /docs/guide/example → "example"; the full path is not rendered.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('example');
  });

  it('renders the like button icon-only (no text label) in the compact state', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    expect(screen.queryByText('いいね')).toBeNull();
    // The icon-only like button still exposes its accessible name.
    expect(screen.getByLabelText('いいねを追加')).toBeTruthy();
  });

  it('does not render the meta-chip row in the compact state', () => {
    renderHeader(<PageHeader page={makePage({ commentCount: 3 })} sticky showActions />);
    // The meta-chip row carries the localized "... に更新" timestamp.
    expect(screen.queryByText(/に更新/)).toBeNull();
  });

  it('collapses watch / bookmark / link into the dotmenu in the compact state', () => {
    renderHeader(<PageHeader page={makePage()} sticky showActions />);
    // watch / bookmark / link are no longer standalone controls.
    expect(screen.queryByLabelText('ウォッチする')).toBeNull();
    expect(screen.queryByLabelText('ブックマークを追加')).toBeNull();
    expect(screen.queryByLabelText('リンクを共有')).toBeNull();

    // They appear inside the dotmenu instead. Radix opens the menu on
    // pointerdown; jsdom needs an explicit PointerEvent.
    const trigger = screen.getByLabelText('その他のアクション');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'ウォッチ' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'ブックマーク' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'タイトルとURL' })).toBeTruthy();
  });

  it('renders the live presence row at compact size', () => {
    usePresence.mockReturnValue({
      viewers: [
        { userId: 'u1', username: 'me', displayName: 'Me', avatarUrl: null, isEditing: false, joinedAt: 1 },
        { userId: 'u2', username: 'bob', displayName: 'Bob', avatarUrl: null, isEditing: false, joinedAt: 2 },
      ],
      selfUserId: 'u1',
      status: 'connected',
    });
    renderHeader(<PageHeader page={makePage()} sticky showActions showPresence />);
    expect(screen.getByTestId('live-presence-row').getAttribute('data-size')).toBe('compact');
  });
});
