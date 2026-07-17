import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

// `next/link` renders a plain anchor in unit tests — keep the mock minimal
// so the "view all" link assertion can read `href` directly (same pattern
// as `attachment-list.test.tsx`).
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// `PageRowsCard` (real component) renders a `PageListItem` per page, which
// pulls in avatar/date/dropdown machinery unrelated to what this test cares
// about (dedupe + preview/full wiring). Replace it with a minimal stub that
// still renders one element per page keyed by `_id`, so a dedupe bug shows
// up as a wrong element COUNT — the rest of `page-list-shared`'s exports
// (skeleton / empty-card / section-header / load-more) stay real.
vi.mock('@/components/page-list/page-list-shared', async () => {
  const actual = await vi.importActual<typeof import('@/components/page-list/page-list-shared')>('@/components/page-list/page-list-shared');
  return {
    ...actual,
    PageRowsCard: ({ pages }: { pages: Page[] }) => (
      <ul>
        {pages.map((p) => (
          <li key={p._id} data-testid="subpage-row">
            {p.path}
          </li>
        ))}
      </ul>
    ),
  };
});

const { useUserSubpagesInfinite } = vi.hoisted(() => ({ useUserSubpagesInfinite: vi.fn() }));
vi.mock('@/lib/use-user-page', () => ({ useUserSubpagesInfinite }));

import { UserSubpages } from './user-subpages';

afterEach(() => {
  cleanup();
});

const makePage = (overrides: Partial<Page> & { _id: string; path: string }): Page => ({
  commentCount: 0,
  createdAt: new Date(0).toISOString(),
  ...overrides,
});

describe('UserSubpages', () => {
  it('shows the skeleton while loading', () => {
    useUserSubpagesInfinite.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    });

    render(<UserSubpages username="alice" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows a localized error message on failure', () => {
    useUserSubpagesInfinite.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('boom'),
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    });

    render(<UserSubpages username="alice" />);
    expect(screen.getByText(m['user_page.subpages_failed']())).toBeInTheDocument();
  });

  it('shows the empty-state card when there are no subpages', () => {
    useUserSubpagesInfinite.mockReturnValue({
      data: { pages: [{ pages: [], pager: { prev: null, next: null, offset: 0 }, total: 0 }] },
      isLoading: false,
      error: null,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    });

    render(<UserSubpages username="alice" />);
    expect(screen.getByText(m['user_page.subpages_empty']())).toBeInTheDocument();
  });

  it('de-duplicates by _id across fetched pages before rendering (offset-pagination boundary overlap)', () => {
    const a = makePage({ _id: 'p1', path: '/user/alice/a' });
    const b = makePage({ _id: 'p2', path: '/user/alice/b' });
    // A boundary-shift overlap: page 2 re-includes `b` (same `_id` as one
    // already rendered from page 1) alongside a genuinely new row `c`.
    const bDuplicate = makePage({ _id: 'p2', path: '/user/alice/b' });
    const c = makePage({ _id: 'p3', path: '/user/alice/c' });

    useUserSubpagesInfinite.mockReturnValue({
      data: {
        pages: [
          { pages: [a, b], pager: { prev: null, next: 2, offset: 0 }, total: 3 },
          { pages: [bDuplicate, c], pager: { prev: 0, next: null, offset: 2 }, total: 3 },
        ],
      },
      isLoading: false,
      error: null,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    });

    render(<UserSubpages username="alice" />);

    const rows = screen.getAllByTestId('subpage-row');
    // 3 unique rows, not 4 — the duplicate `p2` collapses to one.
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.textContent)).toEqual(['/user/alice/a', '/user/alice/b', '/user/alice/c']);
  });

  it('preview mode shows a "View all" link to /user/<username>/pages only when total exceeds the preview limit', () => {
    const pages = Array.from({ length: 3 }, (_, i) => makePage({ _id: `p${i}`, path: `/user/alice/page-${i}` }));

    useUserSubpagesInfinite.mockReturnValue({
      data: { pages: [{ pages, pager: { prev: null, next: null, offset: 0 }, total: 12 }] },
      isLoading: false,
      error: null,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    });

    render(<UserSubpages username="alice" preview previewLimit={3} />);

    const link = screen.getByRole('link', { name: m['user_page.view_all_subpages']({ count: 12 }) });
    expect(link).toHaveAttribute('href', '/user/alice/pages');
  });

  it('preview mode omits the "View all" link when total is within the preview limit', () => {
    const pages = Array.from({ length: 3 }, (_, i) => makePage({ _id: `p${i}`, path: `/user/alice/page-${i}` }));

    useUserSubpagesInfinite.mockReturnValue({
      data: { pages: [{ pages, pager: { prev: null, next: null, offset: 0 }, total: 3 }] },
      isLoading: false,
      error: null,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    });

    render(<UserSubpages username="alice" preview previewLimit={3} />);

    // The mocked `PageRowsCard` rows are plain `<li>`s (no links), so any
    // link in the tree at all would have to be the "View all" CTA.
    expect(screen.queryByRole('link')).toBeNull();
  });
});
