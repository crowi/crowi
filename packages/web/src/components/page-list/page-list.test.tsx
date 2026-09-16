import type { ListPagesResponse } from '@crowi/api-contract';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makePage } from '@/lib/test-utils/factories';
import { nextLinkMockModule } from '@/lib/test-utils/mocks';

const { usePageList } = vi.hoisted(() => ({ usePageList: vi.fn() }));
vi.mock('@/lib/use-page-list', () => ({ usePageList }));
vi.mock('@/lib/use-auth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => nextLinkMockModule());
// The header / banner / body pieces render nothing these tests look at, and
// pull in the renderer and the api client.
vi.mock('@/components/page-view/page-content', () => ({ PageContent: () => null }));
vi.mock('@/components/page-view/portalize-dialog', () => ({ PortalizeBanner: () => null }));
vi.mock('@/components/create-page/create-page-dialog', () => ({ CreatePageCtaButton: () => null, CreatePageListButton: () => null }));
vi.mock('./portal-header', () => ({ PortalHeader: () => null, PortalOverline: () => null }));

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

afterEach(() => {
  cleanup();
  usePageList.mockReset();
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
