import type { ListPagesResponse, Page } from '@crowi/api-contract';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { usePageList } = vi.hoisted(() => ({ usePageList: vi.fn() }));
vi.mock('@/lib/use-page-list', () => ({ usePageList }));
vi.mock('@/lib/use-auth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// The header / banner / body pieces render nothing these tests look at, and
// pull in the renderer and the api client.
vi.mock('@/components/page-view/page-content', () => ({ PageContent: () => null }));
vi.mock('@/components/page-view/portalize-dialog', () => ({ PortalizeBanner: () => null }));
vi.mock('@/components/create-page/create-page-dialog', () => ({ CreatePageCtaButton: () => null, CreatePageListButton: () => null }));
vi.mock('./portal-header', () => ({ PortalHeader: () => null, PortalOverline: () => null }));

import { PageList } from './page-list';

const makePage = (path: string): Page =>
  ({
    _id: `id:${path}`,
    path,
    commentCount: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    likerCount: 0,
    seenUsersCount: 0,
    isLiked: false,
  }) as Page;

const serve = (response: Partial<ListPagesResponse>) => {
  usePageList.mockReturnValue({
    data: { pages: [], pager: { prev: null, next: null, offset: 0 }, portalPage: null, contentPage: null, total: 0, ...response },
    isLoading: false,
    error: null,
  });
};

/** The row for `path` — its title cell carries the full path. */
const row = (path: string) => screen.queryByTitle(path);

afterEach(() => {
  cleanup();
  usePageList.mockReset();
});

describe('PageList of a folder whose path is also a page', () => {
  // Listing `/xxx/yyy/aa/` while a page lives at `/xxx/yyy/aa`: the server
  // hands that page back as `contentPage`, separate from the rows under it.
  it('lists the same-named page first, ahead of the pages inside the folder', () => {
    serve({ pages: [makePage('/xxx/yyy/aa/bb')], contentPage: makePage('/xxx/yyy/aa'), total: 1 });
    render(<PageList initialParams={{ path: '/xxx/yyy/aa/' }} />);

    const aa = row('/xxx/yyy/aa');
    const bb = row('/xxx/yyy/aa/bb');
    expect(aa?.closest('a')?.getAttribute('href')).toBe('/xxx/yyy/aa');
    expect(bb).not.toBeNull();
    expect(aa && bb && aa.compareDocumentPosition(bb) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lists the same-named page even when nothing sits inside the folder yet', () => {
    serve({ pages: [], contentPage: makePage('/xxx/yyy/zz') });
    render(<PageList initialParams={{ path: '/xxx/yyy/zz/' }} />);

    expect(row('/xxx/yyy/zz')?.closest('a')?.getAttribute('href')).toBe('/xxx/yyy/zz');
  });

  it('pins it to the first page of results only', () => {
    serve({ pages: [makePage('/xxx/yyy/aa/bb')], pager: { prev: 0, next: null, offset: 100 }, contentPage: makePage('/xxx/yyy/aa') });
    render(<PageList initialParams={{ path: '/xxx/yyy/aa/', offset: 100 }} />);

    expect(row('/xxx/yyy/aa/bb')).not.toBeNull();
    expect(row('/xxx/yyy/aa')).toBeNull();
  });
});
