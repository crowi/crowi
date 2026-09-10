import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `PageList` is only exercised here for RFC-0020's artifact-page
 * portalize-banner suppression at the "/foo/" content-page-fallback branch
 * (`contentPage && portalPath`) — not the whole component's data-loading /
 * pagination / portal-document surface, which has no prior test coverage of
 * its own. `usePageList` is mocked (same pattern as `usePage` in
 * `page-view.test.tsx`) so this stays a pure render test.
 */
const { usePageList } = vi.hoisted(() => ({ usePageList: vi.fn() }));
const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));

vi.mock('@/lib/use-page-list', () => ({ usePageList }));
vi.mock('@/lib/use-auth', () => ({ useAuth }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));

import { PageList } from './page-list';

function makeContentPage(overrides: Partial<PageWithRevision> = {}): PageWithRevision {
  return {
    _id: 'content-page-1',
    path: '/foo',
    revision: {
      _id: 'rev-1',
      path: '/foo',
      body: '# hi',
      format: 'markdown',
      createdAt: '2026-05-01T00:00:00.000Z',
      contentType: 'markdown',
    },
    creator: null,
    lastUpdateUser: null,
    commentCount: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
    likerCount: 0,
    seenUsersCount: 0,
    contentType: 'markdown',
    ...overrides,
  } as PageWithRevision;
}

beforeEach(() => {
  useAuth.mockReturnValue({ user: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PageList — portalize banner at the content-page fallback (RFC-0020, AC-CH-5)', () => {
  it('shows the portalize banner when the content page at the stripped path is Markdown', () => {
    usePageList.mockReturnValue({
      data: { contentPage: makeContentPage(), pages: [], pager: { offset: 0, next: null } },
      isLoading: false,
      error: null,
    });

    render(<PageList initialParams={{ path: '/foo/' }} disableCreatePortal />);

    expect(screen.getByRole('button', { name: m['page_list.portalize_banner_action']() })).toBeTruthy();
  });

  it('hides the portalize banner when the content page at the stripped path is an artifact', () => {
    usePageList.mockReturnValue({
      data: { contentPage: makeContentPage({ contentType: 'artifact' }), pages: [], pager: { offset: 0, next: null } },
      isLoading: false,
      error: null,
    });

    render(<PageList initialParams={{ path: '/foo/' }} disableCreatePortal />);

    expect(screen.queryByRole('button', { name: m['page_list.portalize_banner_action']() })).toBeNull();
  });
});
