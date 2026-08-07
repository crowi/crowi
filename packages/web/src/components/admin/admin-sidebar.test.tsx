import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The sidebar's plugin entries come from the admin plugin list; the two
// query hooks and navigation are mocked so this is a pure placement test.
// Paraglide messages are the real compiled output (aliased in
// vitest.config.ts), so headings are asserted by their rendered copy.
const { useAdminPlugins, useAdminPendingUsersCount } = vi.hoisted(() => ({
  useAdminPlugins: vi.fn(),
  useAdminPendingUsersCount: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/use-admin-plugins', () => ({ useAdminPlugins }));
vi.mock('@/lib/use-admin-users', () => ({ useAdminPendingUsersCount }));

import { AdminSidebar } from './admin-sidebar';

const pluginInfo = (name: string, section: string, label: string) => ({
  name,
  hasConfig: true,
  adminPlacement: { section, label, icon: 'key-round' },
});

/** The nav entries under a heading, by the heading's rendered text. */
const itemsUnder = (heading: string) => {
  const section = screen.getByText(heading).closest('div');
  if (!section) throw new Error(`no section for heading ${heading}`);
  return within(section)
    .getAllByRole('link')
    .map((link) => link.textContent);
};

beforeEach(() => {
  vi.clearAllMocks();
  useAdminPendingUsersCount.mockReturnValue({ data: { count: 0 } });
});

afterEach(cleanup);

describe('AdminSidebar plugin placement', () => {
  it('puts a platform plugin under the platform-services heading', () => {
    useAdminPlugins.mockReturnValue({ data: { plugins: [pluginInfo('@crowi/plugin-google', 'platform', 'Google')] } });
    render(<AdminSidebar />);

    expect(itemsUnder('プラットフォームサービス')).toEqual(['Google']);
  });

  // `adminPlacement.section` allows `'auth'` and `'notification'`, but this
  // sidebar has no heading for either. Dropping them made the plugin's
  // config page reachable only by typing its URL — which is exactly how
  // @crowi/plugin-google went missing from the sidebar.
  it.each(['auth', 'notification'])('still shows a plugin declaring the unimplemented %s section', (section) => {
    useAdminPlugins.mockReturnValue({ data: { plugins: [pluginInfo('@crowi/plugin-x', section, 'Some Plugin')] } });
    render(<AdminSidebar />);

    expect(screen.getByRole('link', { name: 'Some Plugin' })).toHaveAttribute('href', '/admin/plugins/edit?name=%40crowi%2Fplugin-x');
  });

  it('leaves the platform heading out entirely when no plugin claims it', () => {
    useAdminPlugins.mockReturnValue({ data: { plugins: [] } });
    render(<AdminSidebar />);

    expect(screen.queryByText('プラットフォームサービス')).not.toBeInTheDocument();
  });

  it('ignores a plugin that exposes no config', () => {
    useAdminPlugins.mockReturnValue({ data: { plugins: [{ ...pluginInfo('@crowi/plugin-y', 'platform', 'No Config'), hasConfig: false }] } });
    render(<AdminSidebar />);

    expect(screen.queryByRole('link', { name: 'No Config' })).not.toBeInTheDocument();
  });
});
