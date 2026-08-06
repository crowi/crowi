import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { m } from '@paraglide/messages.js';

// Mock the readiness hook so this is a pure UI test — no react-query, no API
// (matches attachment-list.test.tsx / user-subpages.test.tsx's pattern).
const { useAdminPluginReadiness } = vi.hoisted(() => ({ useAdminPluginReadiness: vi.fn() }));
vi.mock('@/lib/use-admin-plugins', () => ({ useAdminPluginReadiness }));

// `next/link` renders a plain anchor in unit tests — keep the mock minimal
// so the edit-link assertions can read `href` directly.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { PluginReadinessBanner } from './plugin-readiness-banner';

afterEach(() => {
  cleanup();
});

const s3Issue = {
  id: 'plugin:@crowi/plugin-storage-aws-s3',
  source: 'plugin' as const,
  label: 'AWS S3',
  href: `/admin/plugins/edit?name=${encodeURIComponent('@crowi/plugin-storage-aws-s3')}`,
  fields: [{ name: 'bucket', configured: false as const }],
};

const esIssue = {
  id: 'plugin:@crowi/plugin-search-elasticsearch',
  source: 'plugin' as const,
  label: 'Elasticsearch',
  href: `/admin/plugins/edit?name=${encodeURIComponent('@crowi/plugin-search-elasticsearch')}`,
  fields: [{ name: 'url', configured: false as const }],
};

const coreMailIssue = {
  id: 'core:mail',
  source: 'core' as const,
  label: 'Mail',
  href: '/admin/mail',
  fields: [{ name: 'from', configured: false as const }],
};

describe('PluginReadinessBanner (feature-plugin-config-readiness, AC-5)', () => {
  it('calls the readiness hook with enabled=false for a non-admin, so no request is ever issued', () => {
    useAdminPluginReadiness.mockReturnValue({ data: undefined });

    render(<PluginReadinessBanner isAdmin={false} />);

    expect(useAdminPluginReadiness).toHaveBeenCalledWith(false);
  });

  it('calls the readiness hook with enabled=true for an admin', () => {
    useAdminPluginReadiness.mockReturnValue({ data: { issues: [] } });

    render(<PluginReadinessBanner isAdmin={true} />);

    expect(useAdminPluginReadiness).toHaveBeenCalledWith(true);
  });

  it('renders nothing for a non-admin, even if the hook happens to return issues (defense in depth)', () => {
    useAdminPluginReadiness.mockReturnValue({ data: { issues: [s3Issue] } });

    const { container } = render(<PluginReadinessBanner isAdmin={false} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an admin when there are no issues', () => {
    useAdminPluginReadiness.mockReturnValue({ data: { issues: [] } });

    const { container } = render(<PluginReadinessBanner isAdmin={true} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the query is still loading (data undefined)', () => {
    useAdminPluginReadiness.mockReturnValue({ data: undefined });

    const { container } = render(<PluginReadinessBanner isAdmin={true} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders the unset field name and an edit link for a single issue, without any config value', () => {
    useAdminPluginReadiness.mockReturnValue({ data: { issues: [s3Issue] } });

    render(<PluginReadinessBanner isAdmin={true} />);

    expect(screen.getByText(m['admin.plugins.readiness_banner_title']({ name: 'AWS S3', fields: 'bucket' }))).toBeTruthy();
    const link = screen.getByRole('link', { name: m['admin.plugins.readiness_banner_link']({ name: 'AWS S3' }) });
    expect(link.getAttribute('href')).toBe(`/admin/plugins/edit?name=${encodeURIComponent('@crowi/plugin-storage-aws-s3')}`);
  });

  it('never renders a raw field value anywhere in the DOM', () => {
    useAdminPluginReadiness.mockReturnValue({ data: { issues: [s3Issue] } });

    const { container } = render(<PluginReadinessBanner isAdmin={true} />);

    // The only thing the mocked issue carries besides names/labels is the
    // literal `configured: false` marker — assert it never leaks as text.
    expect(container.textContent).not.toContain('true');
    expect(container.textContent).not.toContain('configured');
  });

  it('renders one row per plugin when multiple plugins have issues', () => {
    useAdminPluginReadiness.mockReturnValue({ data: { issues: [s3Issue, esIssue] } });

    render(<PluginReadinessBanner isAdmin={true} />);

    expect(screen.getByText(m['admin.plugins.readiness_banner_title']({ name: 'AWS S3', fields: 'bucket' }))).toBeTruthy();
    expect(screen.getByText(m['admin.plugins.readiness_banner_title']({ name: 'Elasticsearch', fields: 'url' }))).toBeTruthy();
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('joins multiple unset field names for a single plugin', () => {
    const multiFieldIssue = {
      id: 'plugin:@crowi/plugin-multi',
      source: 'plugin' as const,
      label: 'Multi',
      href: `/admin/plugins/edit?name=${encodeURIComponent('@crowi/plugin-multi')}`,
      fields: [
        { name: 'fieldA', configured: false as const },
        { name: 'fieldB', configured: false as const },
      ],
    };
    useAdminPluginReadiness.mockReturnValue({ data: { issues: [multiFieldIssue] } });

    render(<PluginReadinessBanner isAdmin={true} />);

    expect(screen.getByText(m['admin.plugins.readiness_banner_title']({ name: 'Multi', fields: 'fieldA / fieldB' }))).toBeTruthy();
  });
});

describe('PluginReadinessBanner — core config issues (feature-core-config-readiness-and-mail, AC-1)', () => {
  it('renders a core mail issue with its field name and the /admin/mail link, identically to a plugin issue', () => {
    useAdminPluginReadiness.mockReturnValue({ data: { issues: [coreMailIssue] } });

    render(<PluginReadinessBanner isAdmin={true} />);

    expect(screen.getByText(m['admin.plugins.readiness_banner_title']({ name: 'Mail', fields: 'from' }))).toBeTruthy();
    const link = screen.getByRole('link', { name: m['admin.plugins.readiness_banner_link']({ name: 'Mail' }) });
    expect(link.getAttribute('href')).toBe('/admin/mail');
  });

  it('renders a core mail issue alongside a plugin issue, one row each', () => {
    useAdminPluginReadiness.mockReturnValue({ data: { issues: [coreMailIssue, s3Issue] } });

    render(<PluginReadinessBanner isAdmin={true} />);

    expect(screen.getByText(m['admin.plugins.readiness_banner_title']({ name: 'Mail', fields: 'from' }))).toBeTruthy();
    expect(screen.getByText(m['admin.plugins.readiness_banner_title']({ name: 'AWS S3', fields: 'bucket' }))).toBeTruthy();
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });
});
