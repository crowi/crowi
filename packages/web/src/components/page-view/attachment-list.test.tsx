import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { Attachment } from '@crowi/api-contract';

// Mock the data + auth hooks so the list is pure UI — no react-query, no API.
const { useAttachmentList } = vi.hoisted(() => ({ useAttachmentList: vi.fn() }));
const { useRemoveAttachment } = vi.hoisted(() => ({ useRemoveAttachment: vi.fn() }));
const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock('@/lib/use-attachments', () => ({ useAttachmentList, useRemoveAttachment }));
vi.mock('@/lib/use-auth', () => ({ useAuth }));

import { AttachmentList } from './attachment-list';

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    _id: 'att-1',
    page: 'page-1',
    creator: { _id: 'u1', username: 'alice', name: 'Alice', email: 'a@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
    filePath: 'attachment/page-1/att-1.png',
    fileName: 'att-1.png',
    originalName: 'diagram.png',
    fileFormat: 'image/png',
    fileSize: 2048,
    createdAt: '2026-05-01T00:00:00.000Z',
    url: '/api/v2/attachments/att-1',
    ...overrides,
  };
}

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

    // 150px cap + mobile 20% width constraint applied to the thumbnail.
    expect(thumbButton.className).toContain('max-w-[150px]');
    expect(thumbButton.className).toContain('w-1/5');

    // Hover overlay carries the ZoomIn (+) mark, hidden until group-hover.
    expect(thumbButton.className).toContain('group');
    const overlay = thumbButton.querySelector('span[aria-hidden="true"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.className).toContain('group-hover:opacity-100');
    expect(overlay?.querySelector('svg')).not.toBeNull();
  });

  it('renders a non-image attachment with a file-type icon and download link', () => {
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

    // No thumbnail for non-image files.
    expect(screen.queryByRole('img')).toBeNull();
    const link = screen.getByRole('link', { name: /spec\.pdf/ });
    expect(link.getAttribute('href')).toBe('/api/v2/attachments/att-2');
    // The file-type icon is rendered (lucide icons render as <svg>).
    const item = link.closest('li');
    expect(item?.querySelector('svg')).not.toBeNull();
  });
});
