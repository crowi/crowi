import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';
import type { RevisionMeta, UserPublic } from '@crowi/api-contract';
import { PageHistory } from './page-history';

// Stub out the revisions data hook + the diff viewer so we focus the
// test on the list-table renderer's contributors path. The diff
// viewer pulls its own ts-rest queries; rendering it would force
// MSW / additional mocks that aren't necessary here.
const usePageRevisionsMock = vi.fn();
vi.mock('@/lib/use-page-revisions', () => ({
  usePageRevisions: () => usePageRevisionsMock(),
}));
vi.mock('./revision-diff', () => ({
  RevisionDiff: () => null,
}));

afterEach(() => {
  cleanup();
  usePageRevisionsMock.mockReset();
});

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

const baseUser = (overrides: Partial<UserPublic>): UserPublic => ({
  _id: overrides._id ?? 'user-1',
  username: overrides.username ?? 'alice',
  name: overrides.name ?? 'Alice',
  email: overrides.email ?? 'alice@example.com',
  image: overrides.image ?? null,
  createdAt: overrides.createdAt ?? new Date().toISOString(),
});

const baseRevision = (overrides: Partial<RevisionMeta>): RevisionMeta => ({
  _id: overrides._id ?? 'rev-1',
  path: '/some/page',
  author: overrides.author ?? null,
  savedBy: overrides.savedBy,
  contributors: overrides.contributors,
  createdAt: overrides.createdAt ?? new Date().toISOString(),
});

describe('PageHistory contributors rendering', () => {
  it('shows just the author name when contributors are absent (v1.x revision)', () => {
    const alice = baseUser({ _id: 'alice-id', name: 'Alice', username: 'alice' });
    usePageRevisionsMock.mockReturnValue({
      revisions: [baseRevision({ _id: 'rev-A', author: alice }), baseRevision({ _id: 'rev-B', author: alice })],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    render(createElement(PageHistory, { pageId: 'page-1', pagePath: '/some/page' }), { wrapper: makeWrapper() });

    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0);
    // No "with ..." suffix at all
    expect(screen.queryByText(/with /)).toBeNull();
  });

  it('renders savedBy + "with N..." for collab-flow revisions', () => {
    const alice = baseUser({ _id: 'alice-id', name: 'Alice', username: 'alice' });
    const bob = baseUser({ _id: 'bob-id', name: 'Bob', username: 'bob' });
    const carol = baseUser({ _id: 'carol-id', name: 'Carol', username: 'carol' });
    usePageRevisionsMock.mockReturnValue({
      revisions: [
        baseRevision({ _id: 'rev-collab', author: alice, savedBy: alice, contributors: [bob, carol] }),
        baseRevision({ _id: 'rev-legacy', author: alice }),
      ],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    render(createElement(PageHistory, { pageId: 'page-1', pagePath: '/some/page' }), { wrapper: makeWrapper() });

    // Saved-by name (Alice) appears at least twice — once in the
    // collab row, once in the legacy row.
    expect(screen.getAllByText('Alice').length).toBeGreaterThanOrEqual(2);
    // Contributors appended via `Intl.ListFormat`. Locale-specific
    // separator (", and" in en, 「、」 in ja) makes a strict regex
    // fragile, so assert on the locale-neutral presence of both
    // contributor names inside the row's "with others" span.
    const withOthersText = screen.getByText(/Bob.*Carol|Carol.*Bob/);
    expect(withOthersText).toBeDefined();
  });

  it('de-duplicates savedBy from the contributors list', () => {
    const alice = baseUser({ _id: 'alice-id', name: 'Alice', username: 'alice' });
    const bob = baseUser({ _id: 'bob-id', name: 'Bob', username: 'bob' });
    usePageRevisionsMock.mockReturnValue({
      revisions: [
        // Defensive case: server returned savedBy duplicated inside contributors.
        baseRevision({ _id: 'rev-dup', author: alice, savedBy: alice, contributors: [alice, bob] }),
        baseRevision({ _id: 'rev-second', author: alice }),
      ],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    render(createElement(PageHistory, { pageId: 'page-1', pagePath: '/some/page' }), { wrapper: makeWrapper() });

    // Bob must appear in the "with" suffix; Alice must NOT appear
    // there a second time as a contributor. We confirm by checking
    // the suffix span — it should not contain the substring "Alice".
    const withSuffix = screen.getByText(/Bob/);
    expect(withSuffix.textContent).not.toMatch(/Alice/);
    expect(withSuffix.textContent).toMatch(/Bob/);
  });
});
