import type { AttachmentUsageResponse, PastAttachmentUsage } from '@crowi/api-contract';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAttachment } from '@/lib/test-utils/factories';

// Mock the data + auth hooks so the view is pure UI — no react-query, no API.
const { useAttachmentUsage } = vi.hoisted(() => ({ useAttachmentUsage: vi.fn() }));
const { useRemoveAttachment } = vi.hoisted(() => ({ useRemoveAttachment: vi.fn() }));
const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock('@/lib/use-attachment-usage', () => ({ useAttachmentUsage }));
vi.mock('@/lib/use-attachments', () => ({ useRemoveAttachment }));
vi.mock('@/lib/use-auth', () => ({ useAuth }));

// `next/link` renders a plain anchor in unit tests so `href` reads directly.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { AttachmentUsageView } from './attachment-usage-view';

function makePastUsage(overrides: Partial<PastAttachmentUsage> = {}): PastAttachmentUsage {
  return {
    attachment: makeAttachment({ _id: 'att-past', originalName: 'old.png', url: '/api/v2/attachments/att-past', inUse: false }),
    referencingRevisions: [
      {
        revisionId: 'rev-9',
        createdAt: '2026-04-01T00:00:00.000Z',
        author: { _id: 'u1', username: 'alice', name: 'Alice', email: 'a@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
      },
    ],
    ...overrides,
  };
}

function mockUsage(usage: Partial<AttachmentUsageResponse>) {
  useAttachmentUsage.mockReturnValue({
    data: { pagePath: '/docs/page', latest: [], past: [], ...usage },
    isLoading: false,
    isError: false,
    error: null,
  });
}

beforeEach(() => {
  useAuth.mockReturnValue({ user: null });
  useRemoveAttachment.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AttachmentUsageView', () => {
  it('shows a loading state', () => {
    useAttachmentUsage.mockReturnValue({ data: undefined, isLoading: true, isError: false, error: null });
    render(<AttachmentUsageView pageId="page-1" />);
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('shows an error state when the fetch fails', () => {
    useAttachmentUsage.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error('boom') });
    render(<AttachmentUsageView pageId="page-1" />);
    expect(screen.getByText('boom')).toBeTruthy();
  });

  it('renders a latest-revision attachment in the top section', () => {
    mockUsage({ latest: [makeAttachment({ originalName: 'latest.png', url: '/api/v2/attachments/att-1' })] });
    render(<AttachmentUsageView pageId="page-1" />);
    expect(screen.getByRole('img', { name: 'latest.png' })).toBeTruthy();
  });

  it('renders a past-only attachment with a link to its referencing revision', () => {
    mockUsage({ past: [makePastUsage()] });
    render(<AttachmentUsageView pageId="page-1" />);

    // The past-only file's image renders.
    expect(screen.getByRole('img', { name: 'old.png' })).toBeTruthy();

    // The revision link points at /<path>?revision_id=<id>.
    const revLink = screen.getByRole('link', { name: /の版で使用/ });
    expect(revLink.getAttribute('href')).toBe('/docs/page?revision_id=rev-9');
  });

  it('renders both sections at once (latest + past)', () => {
    mockUsage({
      latest: [makeAttachment({ _id: 'att-l', originalName: 'current.png', url: '/api/v2/attachments/att-l' })],
      past: [makePastUsage()],
    });
    render(<AttachmentUsageView pageId="page-1" />);

    expect(screen.getByRole('img', { name: 'current.png' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'old.png' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /の版で使用/ })).toBeTruthy();
  });

  it('labels an orphan attachment (no referencing revisions) instead of showing revision links', () => {
    mockUsage({ past: [makePastUsage({ referencingRevisions: [] })] });
    render(<AttachmentUsageView pageId="page-1" />);

    expect(screen.getByRole('img', { name: 'old.png' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /の版で使用/ })).toBeNull();
    expect(screen.getByText('どの版からも参照されていません')).toBeTruthy();
  });
});
