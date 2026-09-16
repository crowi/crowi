import type { Page } from '@crowi/api-contract';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `next/link` renders a plain anchor in unit tests (same minimal mock as
// `user-subpages.test.tsx`).
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { PageListItem } from './page-list-item';

function makePage(overrides: Partial<Page> = {}): Page {
  return {
    _id: 'page-1',
    path: '/docs/example',
    commentCount: 0,
    createdAt: new Date('2026-05-01T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-05-01T00:00:00.000Z').toISOString(),
    likerCount: 0,
    seenUsersCount: 0,
    isLiked: false,
    ...overrides,
  } as Page;
}

afterEach(() => {
  cleanup();
});

describe('PageListItem', () => {
  it('renders the basename as the row title', () => {
    render(<PageListItem page={makePage({ path: '/docs/example' })} />);
    expect(screen.getByTitle('/docs/example').textContent).toBe('example');
  });

  // AC-11/D-2 — like count is read directly from the required
  // `page.likerCount`; there is no `liker` array to fall back to anymore.
  it('displays the like chip count from page.likerCount alone', () => {
    render(<PageListItem page={makePage({ likerCount: 3, commentCount: 0 })} />);
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('hides the reactions row entirely when likerCount and commentCount are both 0', () => {
    render(<PageListItem page={makePage({ likerCount: 0, commentCount: 0 })} />);
    expect(screen.queryByText('0')).toBeNull();
  });

  it('shows both like and comment counts when both are non-zero', () => {
    render(<PageListItem page={makePage({ likerCount: 2, commentCount: 5 })} />);
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
  });
});
