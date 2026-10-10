import { type ListPagesResponse, PageStatusEnum } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makePage } from '@/lib/test-utils/factories';
import { nextLinkMockModule } from '@/lib/test-utils/mocks';

const { usePageList } = vi.hoisted(() => ({ usePageList: vi.fn() }));
vi.mock('@/lib/use-page-list', () => ({ usePageList }));
// The current-revision lookup used to judge a past-revision portal (a disabled query unless asked for).
const { usePage } = vi.hoisted(() => ({ usePage: vi.fn() }));
vi.mock('@/lib/use-page', () => ({ usePage }));
const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));
const { authUser } = vi.hoisted(() => ({ authUser: { value: null as { id: string; username: string } | null } }));
vi.mock('@/lib/use-auth', () => ({ useAuth: () => ({ user: authUser.value }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock('next/link', () => nextLinkMockModule());
// The header / banner / body pieces pull in the renderer and the api client.
// The banner is a stub rather than `null` because whether page-list renders
// it at all is what the portalize-banner tests below look at.
vi.mock('@/components/page-view/page-content', () => ({ PageContent: () => null }));
vi.mock('@/components/page-view/portalize-dialog', () => ({ PortalizeBanner: () => <div data-testid="portalize-banner-stub" /> }));
vi.mock('@/components/create-page/create-page-dialog', () => ({ CreatePageCtaButton: () => null, CreatePageListButton: () => null }));
vi.mock('./portal-meta-bar', () => ({ PortalMetaBar: () => null }));
vi.mock('@/components/page-view/stale-revision-banner', () => ({ StaleRevisionBanner: () => null }));
const { portalHeaderProps } = vi.hoisted(() => ({ portalHeaderProps: [] as Array<{ onEdit?: () => void }> }));
vi.mock('./portal-header', () => ({
  PortalHeader: (props: { onEdit?: () => void }) => {
    portalHeaderProps.push(props);
    return null;
  },
  PortalOverline: () => null,
}));

import { PageList } from './page-list';

/** A row at `path`, with an `_id` of its own so rows can share a list. */
const pageAt = (path: string) => makePage({ _id: `id:${path}`, path });

const serve = (response: Partial<ListPagesResponse>) => {
  usePageList.mockReturnValue({
    data: { pages: [], pager: { prev: null, next: null, offset: 0 }, portalPage: null, contentPage: null, total: 0, ...response },
    isLoading: false,
    error: null,
  });
};

/** The row for `path` — its title cell carries the full path. */
const row = (path: string) => screen.queryByTitle(path);

beforeEach(() => {
  usePage.mockReturnValue({
    page: null,
    isLoading: false,
    isError: false,
    error: null,
    notFound: false,
    notGranted: false,
    redirectTo: null,
    isDeleted: false,
  });
});

afterEach(() => {
  cleanup();
  usePageList.mockReset();
  usePage.mockReset();
  routerPush.mockReset();
  portalHeaderProps.length = 0;
  authUser.value = null;
});

describe('PageList of a folder whose path is also a page', () => {
  // Listing `/xxx/yyy/aa/` while a page lives at `/xxx/yyy/aa`: the server
  // hands that page back as `contentPage`, separate from the rows under it.
  it('lists the same-named page first, ahead of the pages inside the folder', () => {
    serve({ pages: [pageAt('/xxx/yyy/aa/bb')], contentPage: pageAt('/xxx/yyy/aa'), total: 1 });
    render(<PageList initialParams={{ path: '/xxx/yyy/aa/' }} />);

    expect(screen.getAllByTitle(/^\/xxx\/yyy\/aa(\/bb)?$/).map((el) => el.getAttribute('title'))).toEqual(['/xxx/yyy/aa', '/xxx/yyy/aa/bb']);
    expect(row('/xxx/yyy/aa')?.closest('a')?.getAttribute('href')).toBe('/xxx/yyy/aa');
  });

  it('lists the same-named page even when nothing sits inside the folder yet', () => {
    serve({ pages: [], contentPage: pageAt('/xxx/yyy/zz') });
    render(<PageList initialParams={{ path: '/xxx/yyy/zz/' }} />);

    expect(row('/xxx/yyy/zz')?.closest('a')?.getAttribute('href')).toBe('/xxx/yyy/zz');
  });

  it('pins it to the first page of results only', () => {
    serve({ pages: [pageAt('/xxx/yyy/aa/bb')], pager: { prev: 0, next: null, offset: 100 }, contentPage: pageAt('/xxx/yyy/aa') });
    render(<PageList initialParams={{ path: '/xxx/yyy/aa/', offset: 100 }} />);

    expect(row('/xxx/yyy/aa/bb')).not.toBeNull();
    expect(row('/xxx/yyy/aa')).toBeNull();
  });
});

describe('PageList — portalize banner at the content-page fallback (RFC-0020, AC-CH-5)', () => {
  it('shows the portalize banner when the content page at the stripped path is Markdown', () => {
    serve({ contentPage: makePage({ _id: 'id:/foo', path: '/foo', contentType: 'markdown' }) });
    render(<PageList initialParams={{ path: '/foo/' }} disableCreatePortal />);

    expect(screen.queryByTestId('portalize-banner-stub')).not.toBeNull();
  });

  it('hides the portalize banner when the content page at the stripped path is an artifact', () => {
    serve({ contentPage: makePage({ _id: 'id:/foo', path: '/foo', contentType: 'artifact' }) });
    render(<PageList initialParams={{ path: '/foo/' }} disableCreatePortal />);

    expect(screen.queryByTestId('portalize-banner-stub')).toBeNull();
    // The page itself is still listed — only the banner is withheld.
    expect(row('/foo')).not.toBeNull();
  });
});

describe('PageList — fetch failure', () => {
  it('shows the error state instead of an empty list', () => {
    usePageList.mockReturnValue({ data: undefined, isLoading: false, error: new Error('Failed to fetch page list') });
    render(<PageList initialParams={{ path: '/foo/' }} />);

    expect(screen.getByText(m['page_list.failed_to_load']())).toBeTruthy();
  });
});

describe('PageList — body edit entry (artifact-edit-guard, AC-01)', () => {
  /** A portal document whose viewed revision has `kind`; `latest` is the page's current revision id. */
  const portal = (kind: 'markdown' | 'artifact' | undefined, overrides: Record<string, unknown> = {}) =>
    makePage({
      _id: 'portal-1',
      path: '/foo/',
      revision: { _id: 'rev-1', path: '/foo/', body: '', format: 'markdown', createdAt: '2026-05-01T00:00:00.000Z', contentType: kind },
      latestRevision: 'rev-1',
      ...overrides,
    } as never);

  const edit = () => portalHeaderProps.at(-1)?.onEdit;

  it('gives a Markdown portal an edit callback that goes to the page-id editor', () => {
    serve({ portalPage: portal('markdown') as never });
    render(<PageList initialParams={{ path: '/foo/' }} />);
    expect(typeof edit()).toBe('function');
    edit()?.();
    expect(routerPush).toHaveBeenCalledWith('/_edit?page_id=portal-1');
  });

  it('gives an artifact portal no edit callback', () => {
    serve({ portalPage: portal('artifact') as never });
    render(<PageList initialParams={{ path: '/foo/' }} />);
    expect(edit()).toBeUndefined();
  });

  it('does not look up the current revision for a normal portal view', () => {
    serve({ portalPage: portal('markdown') as never });
    render(<PageList initialParams={{ path: '/foo/' }} />);
    expect(usePage).toHaveBeenCalledWith({ page_id: undefined });
  });

  describe('opened at a past revision', () => {
    const stale = (kind: 'markdown' | 'artifact') => portal(kind, { latestRevision: 'rev-now' });
    const current = (kind: 'markdown' | 'artifact') => ({
      page: { _id: 'portal-1', revision: { _id: 'rev-now', contentType: kind } },
      isLoading: false,
    });

    it('judges by the portal current revision: an old Markdown version of a now-artifact portal has no edit callback', () => {
      usePage.mockReturnValue(current('artifact'));
      serve({ portalPage: stale('markdown') as never });
      render(<PageList initialParams={{ path: '/foo/' }} />);
      expect(usePage).toHaveBeenCalledWith({ page_id: 'portal-1' });
      expect(edit()).toBeUndefined();
    });

    it('offers it when the current revision is Markdown, and nothing while it is still loading', () => {
      usePage.mockReturnValue(current('markdown'));
      serve({ portalPage: stale('artifact') as never });
      render(<PageList initialParams={{ path: '/foo/' }} />);
      expect(typeof edit()).toBe('function');

      cleanup();
      portalHeaderProps.length = 0;
      usePage.mockReturnValue({ page: null, isLoading: true });
      render(<PageList initialParams={{ path: '/foo/' }} />);
      expect(edit()).toBeUndefined();
    });
  });

  describe('own draft portal (the "Continue portal draft" entry)', () => {
    const draft = (kind: 'markdown' | 'artifact') =>
      portal(kind, {
        status: PageStatusEnum.DRAFT,
        creator: { _id: 'me', username: 'me', name: 'Me', email: 'm@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
      });
    const continueLabel = () => m['page_list.continue_portal_draft']();

    const renderAsMe = () => {
      render(<PageList initialParams={{ path: '/foo/' }} />);
    };

    it('shows the continue button for a Markdown draft and navigates to its editor', async () => {
      authUser.value = { id: 'me', username: 'me' };
      serve({ portalPage: draft('markdown') as never });
      renderAsMe();
      const button = screen.getByRole('button', { name: continueLabel() });
      button.click();
      expect(routerPush).toHaveBeenCalledWith('/_edit?page_id=portal-1');
    });

    it('keeps the draft notice but drops the continue button for an artifact draft', () => {
      authUser.value = { id: 'me', username: 'me' };
      serve({ portalPage: draft('artifact') as never });
      renderAsMe();
      expect(screen.queryByRole('button', { name: continueLabel() })).toBeNull();
      expect(screen.getByText(m['page_list.portal_draft_notice']())).toBeTruthy();
    });
  });
});
