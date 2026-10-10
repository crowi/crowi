import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextLinkMockModule } from '@/lib/test-utils/mocks';

/**
 * `/user/<username>` shows the profile and, when a wiki page lives at
 * `/user/<username>`, that page below it. Whether the page header offers the
 * Markdown editor depends on that page's current revision kind, so the user
 * home is not assumed to be Markdown. Everything around the header is stubbed;
 * only the callback handed to it is observed.
 */
const { useUserPage, usePage, push, headerProps } = vi.hoisted(() => ({
  useUserPage: vi.fn(),
  usePage: vi.fn(),
  push: vi.fn(),
  headerProps: [] as Array<{ onEdit?: () => void }>,
}));
vi.mock('@/lib/use-user-page', () => ({ useUserPage }));
vi.mock('@/lib/use-page', () => ({ usePage }));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }) }));
vi.mock('next/link', () => nextLinkMockModule());
vi.mock('@/components/user-page', () => ({
  UserProfile: () => null,
  UserRecentPages: () => null,
  UserBookmarks: () => null,
  UserSubpages: () => null,
}));
vi.mock('@/components/page-view', () => ({
  PageHeader: (props: { onEdit?: () => void }) => {
    headerProps.push(props);
    return null;
  },
  PageContent: () => null,
}));

import UserPage from './page';

const userHome = (contentType: 'markdown' | 'artifact' | undefined) => ({
  _id: 'home-1',
  path: '/user/alice',
  revision: { _id: 'rev-1', contentType },
});

function renderUserPage() {
  // `use(params)` accepts an already-resolved thenable without suspending.
  const params = Object.assign(Promise.resolve({ username: 'alice' }), { status: 'fulfilled', value: { username: 'alice' } });
  return render(createElement(UserPage, { params }));
}

beforeEach(() => {
  useUserPage.mockReturnValue({ data: { user: { username: 'alice' }, createdPagesCount: 0, bookmarksCount: 0 }, isLoading: false, error: null });
});

afterEach(() => {
  cleanup();
  headerProps.length = 0;
  push.mockReset();
  usePage.mockReset();
});

describe('UserPage — user home page edit entry (artifact-edit-guard, AC-01)', () => {
  it('passes the header an edit callback for a Markdown user page, which opens the page-id editor', () => {
    usePage.mockReturnValue({ page: userHome('markdown'), notFound: false });
    renderUserPage();
    expect(typeof headerProps.at(-1)?.onEdit).toBe('function');
    headerProps.at(-1)?.onEdit?.();
    expect(push).toHaveBeenCalledWith('/_edit?page_id=home-1');
  });

  it('treats a revision without contentType as Markdown', () => {
    usePage.mockReturnValue({ page: userHome(undefined), notFound: false });
    renderUserPage();
    expect(typeof headerProps.at(-1)?.onEdit).toBe('function');
  });

  it('passes no callback when the user home page is an artifact', () => {
    usePage.mockReturnValue({ page: userHome('artifact'), notFound: false });
    renderUserPage();
    expect(headerProps).toHaveLength(1);
    expect(headerProps.at(-1)?.onEdit).toBeUndefined();
  });

  it('renders no page header at all when there is no user home page', () => {
    usePage.mockReturnValue({ page: null, notFound: true });
    renderUserPage();
    expect(headerProps).toHaveLength(0);
  });
});
