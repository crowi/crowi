import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Attachment } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { formatAbsoluteDateTime } from '@/lib/date-utils';
import { AttachmentDetailModal } from './attachment-detail-modal';

const removeLabel = m['page.attachments_remove']();
const downloadLabel = m['page.attachment_detail_download']();

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
    createdAt: '2026-05-01T09:30:00.000Z',
    url: '/api/v2/attachments/att-1',
    ...overrides,
  };
}

const noopDelete = () => Promise.resolve();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AttachmentDetailModal', () => {
  it('renders nothing when attachment is null', () => {
    const { container } = render(
      <AttachmentDetailModal attachment={null} open={false} onOpenChange={() => {}} canDelete onDelete={noopDelete} isDeleting={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows an image enlarged with object-contain for an image attachment', () => {
    render(<AttachmentDetailModal attachment={makeAttachment()} open onOpenChange={() => {}} canDelete onDelete={noopDelete} isDeleting={false} />);
    const img = screen.getByRole('img', { name: 'diagram.png' });
    expect(img.getAttribute('src')).toBe('/api/v2/attachments/att-1');
    expect(img.className).toContain('object-contain');
  });

  it('embeds a PDF in an iframe titled with the file name', () => {
    const pdf = makeAttachment({ fileName: 'spec.pdf', originalName: 'spec.pdf', fileFormat: 'application/pdf', url: '/api/v2/attachments/att-2' });
    // The Dialog mounts into a portal on document.body, so query there.
    render(<AttachmentDetailModal attachment={pdf} open onOpenChange={() => {}} canDelete onDelete={noopDelete} isDeleting={false} />);
    // No enlarged <img> preview for a PDF.
    expect(document.body.querySelector('img')).toBeNull();
    const iframe = document.body.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('src')).toBe('/api/v2/attachments/att-2');
    expect(iframe?.getAttribute('title')).toBe('spec.pdf');
  });

  it('shows a file-type icon and no preview for other file types', () => {
    const zip = makeAttachment({ fileName: 'data.zip', originalName: 'data.zip', fileFormat: 'application/zip' });
    render(<AttachmentDetailModal attachment={zip} open onOpenChange={() => {}} canDelete onDelete={noopDelete} isDeleting={false} />);
    // No image / iframe preview for a generic file type.
    expect(document.body.querySelector('img')).toBeNull();
    expect(document.body.querySelector('iframe')).toBeNull();
    expect(screen.getByText(m['page.attachment_detail_preview_unavailable']())).toBeTruthy();
    // The file-type icon renders as an <svg>.
    expect(document.body.querySelector('svg')).not.toBeNull();
  });

  it('shows file metadata: type, size, uploader and uploaded-at', () => {
    render(<AttachmentDetailModal attachment={makeAttachment()} open onOpenChange={() => {}} canDelete onDelete={noopDelete} isDeleting={false} />);
    expect(screen.getByText('image/png')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('@alice')).toBeTruthy();
    // Uploaded-at uses the locale-stable YYYY-MM-DD HH:mm formatter.
    expect(screen.getByText(formatAbsoluteDateTime('2026-05-01T09:30:00.000Z'))).toBeTruthy();
  });

  it('renders a download link pointing at the attachment url with a download attribute', () => {
    render(<AttachmentDetailModal attachment={makeAttachment()} open onOpenChange={() => {}} canDelete onDelete={noopDelete} isDeleting={false} />);
    const link = screen.getByRole('link', { name: downloadLabel });
    expect(link.getAttribute('href')).toBe('/api/v2/attachments/att-1');
    expect(link.hasAttribute('download')).toBe(true);
  });

  it('invokes onDelete after confirmation when the delete button is clicked', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AttachmentDetailModal attachment={makeAttachment()} open onOpenChange={() => {}} canDelete onDelete={onDelete} isDeleting={false} />);
    fireEvent.click(screen.getByRole('button', { name: removeLabel }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
    confirmSpy.mockRestore();
  });

  it('does not invoke onDelete when confirmation is cancelled', () => {
    const onDelete = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AttachmentDetailModal attachment={makeAttachment()} open onOpenChange={() => {}} canDelete onDelete={onDelete} isDeleting={false} />);
    fireEvent.click(screen.getByRole('button', { name: removeLabel }));
    expect(onDelete).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('hides the delete button when canDelete is false', () => {
    render(<AttachmentDetailModal attachment={makeAttachment()} open onOpenChange={() => {}} canDelete={false} onDelete={noopDelete} isDeleting={false} />);
    expect(screen.queryByRole('button', { name: removeLabel })).toBeNull();
  });
});
