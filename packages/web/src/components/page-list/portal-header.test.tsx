import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PortalHeader composes a tree of data-driven children (BookmarkButton,
// PageActionsMenu -> LikeMenuItem/WatchMenuItem). Mock every leaf hook so
// the test is pure layout/wiring — no react-query, no API.
const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
const { useToggleLike } = vi.hoisted(() => ({ useToggleLike: vi.fn() }));
const { useToggleBookmark } = vi.hoisted(() => ({ useToggleBookmark: vi.fn() }));
const { useToggleWatch } = vi.hoisted(() => ({ useToggleWatch: vi.fn() }));
const { useAppInfo } = vi.hoisted(() => ({ useAppInfo: vi.fn() }));
const { useDeletePage } = vi.hoisted(() => ({ useDeletePage: vi.fn() }));

vi.mock('@/lib/use-auth', () => ({ useAuth }));
vi.mock('@/lib/use-like', () => ({ useToggleLike }));
vi.mock('@/lib/use-bookmark', () => ({ useToggleBookmark }));
vi.mock('@/lib/use-watch', () => ({ useToggleWatch, useWatchStatus: vi.fn() }));
vi.mock('@/lib/use-app-info', () => ({ useAppInfo }));
// `DeletePageDialog` (always mounted inside `PageActionsMenu`, gated only on
// its own Radix `open` prop) calls `useDeletePage()` unconditionally — same
// mock as `page-actions-menu.test.tsx` so mounting it doesn't need a real
// `QueryClientProvider`.
vi.mock('@/lib/use-page-mutations', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-page-mutations')>('@/lib/use-page-mutations');
  return { ...actual, useDeletePage };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));

import { PortalHeader } from './portal-header';

function makePage(overrides: Partial<PageWithRevision> = {}): PageWithRevision {
  return {
    _id: 'portal-1',
    path: '/docs/guide/',
    revision: {
      _id: 'rev-1',
      path: '/docs/guide/',
      body: '# guide',
      format: 'markdown',
      createdAt: '2026-05-01T00:00:00.000Z',
    },
    creator: null,
    lastUpdateUser: { _id: 'u1', username: 'alice', name: 'Alice', email: 'a@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
    commentCount: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
    likerCount: 0,
    seenUsersCount: 0,
    isLiked: false,
    ...overrides,
  } as PageWithRevision;
}

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};

  useAuth.mockReturnValue({ user: { id: 'u1' }, isAuthenticated: true });
  useToggleLike.mockReturnValue({ toggle: vi.fn(), isPending: false, isError: false, error: null });
  useToggleBookmark.mockReturnValue({ isBookmarked: false, toggle: vi.fn(), isPending: false, isError: false, error: null });
  useToggleWatch.mockReturnValue({ watching: false, toggle: vi.fn(), isPending: false, isError: false, error: null });
  useAppInfo.mockReturnValue({ data: { title: 'Crowi' } });
  useDeletePage.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false, error: null, reset: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Opens the folded (foldSocial) dotmenu so LikeMenuItem becomes visible. */
function openFoldedMenu(page: PageWithRevision) {
  render(<PortalHeader page={page} onEdit={vi.fn()} />);
  const trigger = screen.getByLabelText(m['page.action_more']());
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

describe('PortalHeader', () => {
  it('renders the PORTAL tag and folder overline', () => {
    render(<PortalHeader page={makePage()} onEdit={vi.fn()} />);
    expect(screen.getByText(m['page_list.portal_label']())).toBeTruthy();
  });

  it('renders the bookmark button for an authenticated viewer', () => {
    render(<PortalHeader page={makePage()} onEdit={vi.fn()} />);
    expect(screen.getByLabelText(m['page.bookmark_aria_add']())).toBeTruthy();
  });

  it('calls onEdit when the edit button is clicked', () => {
    const onEdit = vi.fn();
    render(<PortalHeader page={makePage()} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: m['page.action_edit']() }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  // AC-11/D-2 — the folded LikeMenuItem is driven by page.isLiked, the
  // ALREADY-COMPUTED value PortalHeader passes to PageActionsMenu (never
  // a client-recomputed membership from a liker id array).
  it('drives the folded like menu item from page.isLiked (false: "add" state)', () => {
    openFoldedMenu(makePage({ isLiked: false }));
    expect(screen.getByRole('menuitem', { name: m['page.like_label']() })).toBeInTheDocument();
  });

  it('drives the folded like menu item from page.isLiked (true: "liked" state)', () => {
    openFoldedMenu(makePage({ isLiked: true }));
    expect(screen.getByRole('menuitem', { name: m['page.like_label_done']() })).toBeInTheDocument();
  });
});
