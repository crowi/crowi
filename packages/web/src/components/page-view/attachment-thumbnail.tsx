'use client';

import { createElement } from 'react';
import { ZoomIn } from 'lucide-react';
import { getFileTypeIcon } from '@/lib/file-type-icon';
import { isImageFormat } from './attachment-list';
import type { Attachment } from '@crowi/api-contract';

interface AttachmentThumbnailProps {
  attachment: Attachment;
  /** Opens the detail modal — image thumbnail and non-image row share it. */
  onSelect: (attachment: Attachment) => void;
}

/**
 * Render the runtime-resolved lucide file-type icon. `createElement` (not
 * JSX from a variable) keeps it from tripping `react-hooks/static-components`
 * — same wrapper pattern as `attachment-detail-modal.tsx`.
 */
function FileTypeIconView({ mime, fileName, className }: { mime: string; fileName: string; className?: string }) {
  return createElement(getFileTypeIcon(mime, fileName), { className, 'aria-hidden': 'true' });
}

/**
 * Phase 8 — one attachment entry (image thumbnail or non-image file row),
 * extracted so `AttachmentList` (page footer) and `AttachmentUsageView`
 * (the `/_attachments` page) render attachments identically.
 *
 * Both variants are the same square tile so the list reads as a uniform
 * grid — image: the thumbnail with a hover `(+)` zoom overlay; non-image:
 * the file name (clamped to 2 lines) above a file-type icon, since an
 * icon alone doesn't say which file it is. Clicking either opens the
 * detail modal via `onSelect` (which shows the full metadata).
 */
export function AttachmentThumbnail({ attachment, onSelect }: AttachmentThumbnailProps) {
  const name = attachment.originalName || attachment.fileName;

  if (isImageFormat(attachment.fileFormat)) {
    return (
      <button
        type="button"
        onClick={() => onSelect(attachment)}
        className="group relative block aspect-square w-full max-w-[150px] overflow-hidden rounded border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={name}
        title={name}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={attachment.url} alt={name} className="h-full w-full object-cover" loading="lazy" />
        <span
          className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          aria-hidden="true"
        >
          <ZoomIn className="h-6 w-6 text-white" />
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(attachment)}
      className="flex aspect-square w-full max-w-[150px] flex-col items-center justify-center gap-1.5 rounded border border-border bg-muted/30 p-2 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={name}
      title={name}
    >
      <span className="line-clamp-2 w-full break-all text-center text-[11px] leading-tight text-muted-foreground">{name}</span>
      <FileTypeIconView mime={attachment.fileFormat} fileName={name} className="h-2/5 w-2/5 shrink-0 text-muted-foreground" />
    </button>
  );
}
