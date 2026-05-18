'use client';

import { createElement } from 'react';
import { ZoomIn } from 'lucide-react';
import { getFileTypeIcon } from '@/lib/file-type-icon';
import { formatBytes, isImageFormat } from './attachment-list';
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
 * Image: a 150px-max thumbnail with a hover `(+)` zoom overlay (Phase 5).
 * Non-image: a file-type icon (Phase 5) + name + type/size line. Clicking
 * either opens the detail modal (Phase 6) via `onSelect`.
 */
export function AttachmentThumbnail({ attachment, onSelect }: AttachmentThumbnailProps) {
  const name = attachment.originalName || attachment.fileName;

  if (isImageFormat(attachment.fileFormat)) {
    return (
      <button
        type="button"
        onClick={() => onSelect(attachment)}
        className="group relative block w-1/5 max-w-[150px] shrink-0 overflow-hidden rounded border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={name}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={attachment.url} alt={name} className="aspect-square w-full object-cover" loading="lazy" />
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
      className="flex flex-1 items-start gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
    >
      <FileTypeIconView mime={attachment.fileFormat} fileName={name} className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <span className="text-foreground transition-colors break-all hover:text-primary">{name}</span>
        <p className="text-xs text-muted-foreground mt-0.5">
          {attachment.fileFormat} · {formatBytes(attachment.fileSize)}
        </p>
      </div>
    </button>
  );
}
