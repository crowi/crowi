import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAttachment } from '@/lib/test-utils/factories';

// Mock the data + auth hooks so the list is pure UI — no react-query, no API.
const { useAttachmentList } = vi.hoisted(() => ({ useAttachmentList: vi.fn() }));
const { useRemoveAttachment } = vi.hoisted(() => ({ useRemoveAttachment: vi.fn() }));
const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock('@/lib/use-attachments', () => ({ useAttachmentList, useRemoveAttachment }));
vi.mock('@/lib/use-auth', () => ({ useAuth }));

// `next/link` renders a plain anchor in unit tests — keep the mock minimal
// so the "view all attachments" link assertions can read `href` directly.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { AttachmentList } from './attachment-list';

beforeEach(() => {
  useAuth.mockReturnValue({ user: null });
  useRemoveAttachment.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AttachmentList', () => {
  it('renders nothing when the page has no attachments', () => {
    useAttachmentList.mockReturnValue({ data: { attachments: [] }, isLoading: false });
    const { container } = render(<AttachmentList pageId="page-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing while loading', () => {
    useAttachmentList.mockReturnValue({ data: undefined, isLoading: true });
    const { container } = render(<AttachmentList pageId="page-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders an image attachment as a thumbnail button with a hover zoom mark', () => {
    useAttachmentList.mockReturnValue({ data: { attachments: [makeAttachment()] }, isLoading: false });
    render(<AttachmentList pageId="page-1" />);

    // The thumbnail is a <button> so Phase 6 can wire a detail modal onto it.
    const thumbButton = screen.getByRole('button', { name: 'diagram.png' });
    const img = screen.getByRole('img', { name: 'diagram.png' });
    expect(thumbButton.contains(img)).toBe(true);

    // 150px cap + square tile (the grid cell sizes the width).
    expect(thumbButton.className).toContain('max-w-[150px]');
    expect(thumbButton.className).toContain('aspect-square');

    // Hover overlay carries the ZoomIn (+) mark, hidden until group-hover.
    expect(thumbButton.className).toContain('group');
    const overlay = thumbButton.querySelector('span[aria-hidden="true"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.className).toContain('group-hover:opacity-100');
    expect(overlay?.querySelector('svg')).not.toBeNull();
  });

  it('renders a non-image attachment as a button with a file-type icon', () => {
    useAttachmentList.mockReturnValue({
      data: {
        attachments: [
          makeAttachment({
            _id: 'att-2',
            fileName: 'att-2.pdf',
            originalName: 'spec.pdf',
            fileFormat: 'application/pdf',
            url: '/api/v2/attachments/att-2',
          }),
        ],
      },
      isLoading: false,
    });
    render(<AttachmentList pageId="page-1" />);

    // No thumbnail for non-image files; the row is a <button> (download moved
    // into the detail modal so click behaviour is uniform with images).
    expect(screen.queryByRole('img')).toBeNull();
    const button = screen.getByRole('button', { name: /spec\.pdf/ });
    const item = button.closest('li');
    expect(item?.querySelector('svg')).not.toBeNull();
  });

  it('opens the detail modal when an image thumbnail is clicked', () => {
    useAttachmentList.mockReturnValue({ data: { attachments: [makeAttachment()] }, isLoading: false });
    render(<AttachmentList pageId="page-1" />);

    // The detail modal (a Radix Dialog) is closed until a row is clicked.
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'diagram.png' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('opens the detail modal when a non-image row is clicked', () => {
    useAttachmentList.mockReturnValue({
      data: {
        attachments: [makeAttachment({ _id: 'att-2', fileName: 'att-2.pdf', originalName: 'spec.pdf', fileFormat: 'application/pdf' })],
      },
      isLoading: false,
    });
    render(<AttachmentList pageId="page-1" />);

    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /spec\.pdf/ }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  // Phase 7 — the footer list shows only attachments referenced by the
  // latest revision (`inUse`), with a link to the full listing.
  it('shows only inUse attachments and hides ones not used in the latest revision', () => {
    useAttachmentList.mockReturnValue({
      data: {
        attachments: [
          makeAttachment({ _id: 'att-used', originalName: 'used.png', url: '/api/v2/attachments/att-used', inUse: true }),
          makeAttachment({ _id: 'att-stale', originalName: 'stale.png', url: '/api/v2/attachments/att-stale', inUse: false }),
        ],
      },
      isLoading: false,
    });
    render(<AttachmentList pageId="page-1" />);

    expect(screen.getByRole('img', { name: 'used.png' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'stale.png' })).toBeNull();
  });

  it('renders a "view all attachments" link pointing at /_attachments?pageId=<id>', () => {
    useAttachmentList.mockReturnValue({ data: { attachments: [makeAttachment()] }, isLoading: false });
    render(<AttachmentList pageId="page-42" />);

    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/_attachments?pageId=page-42');
  });

  it('keeps the section (with the view-all link) when no attachment is inUse', () => {
    useAttachmentList.mockReturnValue({
      data: { attachments: [makeAttachment({ inUse: false })] },
      isLoading: false,
    });
    render(<AttachmentList pageId="page-1" />);

    // No thumbnails are rendered, but the full-listing link stays reachable.
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/_attachments?pageId=page-1');
  });
});
