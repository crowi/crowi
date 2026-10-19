import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { pathname, search } = vi.hoisted(() => ({ pathname: { current: '/' }, search: { current: '' } }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
  useSearchParams: () => new URLSearchParams(search.current),
}));
vi.mock('@/lib/use-auth', () => ({ useAuth: () => ({ user: { username: 'alice', admin: false } }) }));
vi.mock('@/lib/use-app-info', () => ({ useAppInfo: () => ({ data: { title: 'Team Wiki' } }) }));

import { SidebarNavLinks } from '@/components/page-sidebar/sidebar-nav-links';
import { SiteBrand } from '@/components/site-brand';

const renderWith = (ui: ReactNode) => {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return invalidate;
};

const topLink = () => screen.getByRole('link', { name: 'トップ' });
const brandLink = () => screen.getByRole('link', { name: 'Team Wiki' });

afterEach(() => {
  cleanup();
  pathname.current = '/';
  search.current = '';
});

describe('a link back to the top page while on it', () => {
  it.each([
    ['the sidebar top link', () => <SidebarNavLinks />, topLink],
    ['the site logo', () => <SiteBrand />, brandLink],
  ])('%s refetches the page queries in place', (_name, ui, link) => {
    const invalidate = renderWith(ui());
    const notPrevented = fireEvent.click(link());
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false);
  });

  it('leaves a modified click to the browser', () => {
    const invalidate = renderWith(<SiteBrand />);
    expect(fireEvent.click(brandLink(), { metaKey: true })).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('navigates normally from an old revision of the top page', () => {
    search.current = 'revision_id=abc';
    const invalidate = renderWith(<SiteBrand />);
    expect(fireEvent.click(brandLink())).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('navigates normally from any other page', () => {
    pathname.current = '/some/page';
    const invalidate = renderWith(<SidebarNavLinks />);
    expect(fireEvent.click(topLink())).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
