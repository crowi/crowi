import type { Page } from '@crowi/api-contract';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `next/link` renders a plain anchor in unit tests (same minimal mock as
// `page-list-item.test.tsx`).
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { SearchSuggestionItem } from './search-suggestion-item';

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

describe('SearchSuggestionItem', () => {
  it('renders the page path as the link text', () => {
    render(<SearchSuggestionItem href="/docs/example" page={makePage({ path: '/docs/example' })} />);
    expect(screen.getByText('/docs/example')).toBeTruthy();
  });

  it('shows the portal icon for a page whose path ends with /', () => {
    render(<SearchSuggestionItem href="/docs/" page={makePage({ path: '/docs/' })} />);
    expect(screen.getByLabelText('Portal page')).toBeTruthy();
  });

  it('shows the private icon for a private-grant page', () => {
    // grant 4 = GRANT_OWNER (owner-only), one of the private grants.
    render(<SearchSuggestionItem href="/docs/example" page={makePage({ grant: 4 })} />);
    expect(screen.getByLabelText('Private page')).toBeTruthy();
  });

  // RFC-0020 (AC-CH-6) — artifact is a kind, shown as an icon, never a pill.
  it('shows the artifact icon (not a pill) for a page with the artifact content-type hint', () => {
    render(<SearchSuggestionItem href="/docs/example" page={makePage({ path: '/docs/example', contentType: 'artifact' })} />);
    const icon = screen.getByLabelText('HTML artifact page');
    // Icons and pills are visually distinct implementations — an `<svg>`
    // (lucide) never carries a pill's rounded-badge text content (same
    // assertion as `page-list-item.test.tsx`'s equivalent case).
    expect(icon.tagName.toLowerCase()).toBe('svg');
    // No pill/badge text node was added alongside the icon — the whole
    // link's text content is still just the bare path (a pill would add
    // its own visible label text, e.g. "Draft").
    expect(screen.getByRole('link').textContent).toBe('/docs/example');
  });

  it('does not show the artifact icon for a page without the hint', () => {
    render(<SearchSuggestionItem href="/docs/example" page={makePage()} />);
    expect(screen.queryByLabelText('HTML artifact page')).toBeNull();
  });

  it('shows the portal, private and artifact icons together without any of them suppressing the others', () => {
    render(<SearchSuggestionItem href="/docs/example/" page={makePage({ path: '/docs/example/', grant: 4, contentType: 'artifact' })} />);
    expect(screen.getByLabelText('Portal page')).toBeTruthy();
    expect(screen.getByLabelText('Private page')).toBeTruthy();
    expect(screen.getByLabelText('HTML artifact page')).toBeTruthy();
  });

  it('renders the snippet when provided, and omits it when absent', () => {
    const { rerender } = render(<SearchSuggestionItem href="/docs/example" page={makePage()} snippet="a <mark>match</mark> here" />);
    expect(screen.getByText('match')).toBeTruthy();

    rerender(<SearchSuggestionItem href="/docs/example" page={makePage()} />);
    expect(screen.queryByText('match')).toBeNull();
  });
});
