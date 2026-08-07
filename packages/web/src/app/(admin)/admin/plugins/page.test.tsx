import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginInfo } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

// Mock the plugin hooks so this is a pure UI test — no react-query, no API
// (matches plugin-readiness-banner.test.tsx's pattern).
const { useAdminPlugins, useAdminPluginReadiness, useClearRenderCacheAll } = vi.hoisted(() => ({
  useAdminPlugins: vi.fn(),
  useAdminPluginReadiness: vi.fn(),
  useClearRenderCacheAll: vi.fn(),
}));
vi.mock('@/lib/use-admin-plugins', () => ({ useAdminPlugins, useAdminPluginReadiness, useClearRenderCacheAll }));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import AdminPluginsPage from './page';

afterEach(() => {
  cleanup();
});

const S3_NAME = '@crowi/plugin-storage-aws-s3';
const s3Plugin: PluginInfo = {
  name: S3_NAME,
  version: '0.1.0',
  hasConfig: true,
  registers: ['storage'],
  adminPlacement: { section: 'storage', label: 'AWS S3' },
  supportsHotReload: true,
  status: 'active',
};

const otherPlugin: PluginInfo = {
  name: '@crowi/plugin-search-mongo',
  version: '0.1.0',
  hasConfig: false,
  registers: ['search'],
  adminPlacement: { section: 'search', label: 'MongoDB (search)' },
  supportsHotReload: false,
  status: 'active',
};

const s3PluginIssue = {
  id: `plugin:${S3_NAME}`,
  source: 'plugin' as const,
  label: 'AWS S3',
  href: `/admin/plugins/edit?name=${encodeURIComponent(S3_NAME)}`,
  fields: [{ name: 'bucket', configured: false as const }],
};

const coreMailIssue = {
  id: 'core:mail',
  source: 'core' as const,
  label: 'Mail',
  href: '/admin/mail',
  fields: [{ name: 'from', configured: false as const }],
};

function setup(overrides: { plugins?: PluginInfo[]; issues?: (typeof s3PluginIssue | typeof coreMailIssue)[] } = {}) {
  useAdminPlugins.mockReturnValue({ data: { plugins: overrides.plugins ?? [s3Plugin, otherPlugin] }, isLoading: false, error: null });
  useAdminPluginReadiness.mockReturnValue({ data: { issues: overrides.issues ?? [] } });
  useClearRenderCacheAll.mockReturnValue({ isPending: false, mutate: vi.fn() });
}

describe('AdminPluginsPage (feature-core-config-readiness-and-mail, AC-3)', () => {
  it('renders every plugin row with no readiness badge when there are no issues', () => {
    setup();
    render(<AdminPluginsPage />);

    expect(screen.getByText(S3_NAME)).toBeTruthy();
    expect(screen.getByText(otherPlugin.name)).toBeTruthy();
    expect(screen.queryByText(m['admin.plugins.readiness_badge']())).toBeNull();
  });

  it('shows the readiness badge and reason on the matching plugin row for a plugin-source issue', () => {
    setup({ issues: [s3PluginIssue] });
    render(<AdminPluginsPage />);

    expect(screen.getByText(m['admin.plugins.readiness_badge']())).toBeTruthy();
    // The reason text is one segment joined with other `PluginRowMeta`
    // parts inside a single <p> (not its own element), so assert via
    // substring rather than an exact-match getByText.
    expect(document.body.textContent).toContain(m['admin.plugins.readiness_reason']({ fields: 'bucket' }));
  });

  it('does not treat a core:mail issue as a plugin row badge — no plugin row shows the readiness badge', () => {
    setup({ issues: [coreMailIssue] });
    render(<AdminPluginsPage />);

    expect(screen.queryByText(m['admin.plugins.readiness_badge']())).toBeNull();
    expect(document.body.textContent).not.toContain(m['admin.plugins.readiness_reason']({ fields: 'from' }));
  });

  it('does not create a synthetic plugin row for a core issue — only the two loaded plugins render', () => {
    setup({ issues: [coreMailIssue] });
    render(<AdminPluginsPage />);

    expect(screen.getByText(S3_NAME)).toBeTruthy();
    expect(screen.getByText(otherPlugin.name)).toBeTruthy();
    expect(screen.queryByText('Mail')).toBeNull();
    expect(screen.queryByRole('link', { name: /Mail/ })).toBeNull();
  });

  it('a plugin issue and a core issue coexist: only the plugin row is badged, the core issue affects nothing on this page', () => {
    setup({ issues: [s3PluginIssue, coreMailIssue] });
    render(<AdminPluginsPage />);

    // Exactly one badge (the S3 row) — the core issue does not add a second.
    expect(screen.getAllByText(m['admin.plugins.readiness_badge']())).toHaveLength(1);
  });

  it('the S3 row still links to its edit href, unaffected by readiness state', () => {
    setup({ issues: [s3PluginIssue] });
    render(<AdminPluginsPage />);

    const link = screen.getByRole('link', { name: new RegExp(S3_NAME) });
    expect(link.getAttribute('href')).toBe(`/admin/plugins/edit?name=${encodeURIComponent(S3_NAME)}`);
  });
});
