import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { PageWithRevision } from '@crowi/api-contract';

// Mock the data hooks so the row is pure UI — no react-query, no API.
const { useBacklinks } = vi.hoisted(() => ({ useBacklinks: vi.fn() }));
const { useLikers } = vi.hoisted(() => ({ useLikers: vi.fn() }));
const { useSeenUsers } = vi.hoisted(() => ({ useSeenUsers: vi.fn() }));
vi.mock('@/lib/use-backlinks', () => ({ useBacklinks }));
vi.mock('@/lib/use-likers', () => ({ useLikers, likersKeys: { pagePrefix: (id: string) => ['likers', id] } }));
vi.mock('@/lib/use-seen', () => ({ useSeenUsers }));

import { MetaChipRow } from './meta-chip-row';

function makePage(overrides: Partial<PageWithRevision> = {}): PageWithRevision {
  return {
    _id: 'page-1',
    path: '/docs/example',
    revision: {
      _id: 'rev-1',
      path: '/docs/example',
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

// Radix Tooltip mounts a presence layer that reads element size via
// ResizeObserver, which jsdom does not implement. A no-op stub is enough
// for these render-level assertions.
beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  useBacklinks.mockReturnValue({ data: { backlinks: [], hasNext: false } });
  useLikers.mockReturnValue({ data: { users: [], totalCount: 0 }, isLoading: false });
  useSeenUsers.mockReturnValue({ data: { seenUsers: [], seenUsersCount: 0 }, isLoading: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MetaChipRow', () => {
  it('renders the static author + last-updated elements', () => {
    render(<MetaChipRow page={makePage()} />);
    expect(screen.getByText('Alice')).toBeTruthy();
    // last-updated time chip carries the localized "... に更新" string.
    expect(screen.getByText(/に更新/)).toBeTruthy();
  });

  it('renders four meta chips (like / view / comment / backlink)', () => {
    const page = makePage({ likerCount: 2, seenUsersCount: 3, commentCount: 4 });
    useBacklinks.mockReturnValue({ data: { backlinks: [{ _id: 'b1' }, { _id: 'b2' }], hasNext: false } });
    render(<MetaChipRow page={page} />);

    // Active chips are buttons; with all four counts > 0 there are four.
    expect(screen.getAllByRole('button')).toHaveLength(4);
  });

  it('greys out a zero-count chip as non-interactive', () => {
    // likerCount 0 → the like chip is disabled (not a button);
    // backlinks default to 0 via the beforeEach mock.
    render(<MetaChipRow page={makePage({ likerCount: 0, seenUsersCount: 5, commentCount: 1 })} />);
    // 0 likes + 0 backlinks → 2 active chips (view, comment).
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('opens the "Liked by" modal when the like chip is clicked', () => {
    render(<MetaChipRow page={makePage({ likerCount: 1 })} />);
    const likeChip = screen.getByRole('button', { name: /いいね/ });
    fireEvent.click(likeChip);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('いいねした人')).toBeTruthy();
  });

  it('opens the "Seen by" modal when the view chip is clicked', () => {
    render(<MetaChipRow page={makePage({ seenUsersCount: 2 })} />);
    const viewChip = screen.getByRole('button', { name: /閲覧/ });
    fireEvent.click(viewChip);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('閲覧者一覧')).toBeTruthy();
  });

  it('renders the updater name as a link to the user page when populated', () => {
    render(<MetaChipRow page={makePage()} />);
    const updaterLink = screen.getByRole('link', { name: 'Alice' });
    expect(updaterLink.getAttribute('href')).toBe('/user/alice');
  });

  it('renders the updater name as plain text when not populated (bare id)', () => {
    // A non-populated `lastUpdateUser` is a bare id string; the row then
    // falls back to `creator` — keep that null too so nothing is populated.
    render(<MetaChipRow page={makePage({ lastUpdateUser: 'u1' as never, creator: null, revision: undefined })} />);
    expect(screen.queryByRole('link', { name: 'Alice' })).toBeNull();
  });

  it('links the updated-at chip to the page history view', () => {
    render(<MetaChipRow page={makePage()} />);
    const historyLink = screen.getByRole('link', { name: /に更新/ });
    expect(historyLink.getAttribute('href')).toBe(`/_history?path=${encodeURIComponent('/docs/example')}`);
  });

  it('shows an absolute datetime tooltip on the updated-at chip', async () => {
    render(<MetaChipRow page={makePage()} />);
    const historyLink = screen.getByRole('link', { name: /に更新/ });
    fireEvent.focus(historyLink);
    // updatedAt 2026-05-10T00:00:00Z → formatAbsoluteDateTime → `YYYY-MM-DD HH:mm`.
    const tooltips = await screen.findAllByText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(tooltips.length).toBeGreaterThan(0);
  });

  // feature-mobile-presence-card stacks the row on mobile by wrapping its
  // children in two groups. jsdom cannot compute Tailwind layout, so the
  // honest assertion is the class contract: at `md`+ both wrappers become
  // `display: contents`, which makes their children direct flex items of
  // the outer row again — i.e. the md+ row is the pre-split six-item
  // wrapping flex row by construction, not by visual approximation. If this
  // ever regresses to two nested flex groups, the md+ wrap points (and with
  // them the header height / sticky threshold / TOC alignment) drift.
  describe('mobile stacking without changing the md+ row', () => {
    it('renders the two mobile groups', () => {
      render(<MetaChipRow page={makePage({ likerCount: 1 })} />);
      expect(screen.getByTestId('meta-chip-group-meta')).toBeTruthy();
      expect(screen.getByTestId('meta-chip-group-stats')).toBeTruthy();
    });

    it('collapses both groups to display:contents at md+ so the row keeps its original direct children', () => {
      render(<MetaChipRow page={makePage({ likerCount: 1 })} />);
      for (const testId of ['meta-chip-group-meta', 'meta-chip-group-stats']) {
        expect(screen.getByTestId(testId).className.split(/\s+/)).toContain('md:contents');
      }
    });

    it('keeps the outer row on the pre-split md+ flex classes', () => {
      render(<MetaChipRow page={makePage({ likerCount: 1 })} />);
      const row = screen.getByTestId('meta-chip-group-meta').parentElement;
      expect(row).not.toBeNull();
      const classes = row?.className.split(/\s+/) ?? [];
      // The md+ computed container == the original
      // `flex flex-wrap items-center gap-x-3 gap-y-2`.
      for (const cls of ['md:flex-row', 'md:flex-wrap', 'md:items-center', 'gap-x-3', 'gap-y-2']) {
        expect(classes).toContain(cls);
      }
    });
  });

  it('scrolls to the comments heading when the comment chip is clicked', () => {
    const heading = document.createElement('h2');
    heading.id = 'comments-heading';
    heading.scrollIntoView = vi.fn();
    heading.focus = vi.fn();
    document.body.appendChild(heading);

    render(<MetaChipRow page={makePage({ commentCount: 3 })} />);
    fireEvent.click(screen.getByRole('button', { name: /コメント/ }));

    expect(heading.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(heading.focus).toHaveBeenCalled();
    document.body.removeChild(heading);
  });
});
