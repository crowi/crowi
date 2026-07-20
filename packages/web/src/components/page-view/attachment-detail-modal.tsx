'use client';

import { createElement } from 'react';
import { Download, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { UserAvatar } from '@/components/user-avatar';
import { formatAbsoluteDateTime } from '@/lib/date-utils';
import { getFileTypeIcon } from '@/lib/file-type-icon';
import { formatBytes, isImageFormat } from './attachment-list';
import type { Attachment } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

interface AttachmentDetailModalProps {
  /** The attachment to show. `null` keeps the modal closed. */
  attachment: Attachment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether the delete action is offered (any authenticated user — wiki policy). */
  canDelete: boolean;
  /** Invoked when the user confirms deletion; should resolve after the mutation. */
  onDelete: (attachment: Attachment) => Promise<void>;
  isDeleting: boolean;
}

/** A labelled metadata row in the modal sidebar/footer. */
function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all text-foreground">{children}</dd>
    </div>
  );
}

/**
 * Render the file-type icon for an attachment. `getFileTypeIcon` resolves a
 * lucide component at runtime; rendering it through this module-scope
 * wrapper keeps the dynamic component out of the parent's render body.
 */
function FileTypeIconView({ mime, fileName, className }: { mime: string; fileName: string; className?: string }) {
  // `createElement` (not JSX from a variable) keeps the runtime-resolved
  // lucide icon from tripping the `react-hooks/static-components` rule.
  return createElement(getFileTypeIcon(mime, fileName), { className, 'aria-hidden': 'true' });
}

/**
 * Near-full-screen attachment detail modal opened from `AttachmentList`.
 *
 * Three preview modes by `fileFormat`:
 *   - image (`image/*`): the file enlarged with `object-contain`.
 *   - PDF (`application/pdf`): an `<iframe>` embed with a download fallback.
 *   - other: the file-type icon only — no inline preview (PDF-only embed
 *     is an explicit scope decision, see the feature spec).
 *
 * Metadata, a download button and (when `canDelete`) a delete action are
 * shown for every mode. Controlled `open` / `onOpenChange` like
 * `LikersDialog`.
 *
 * feature-image-derivative-optimization Phase 2 §4 — every URL this modal
 * renders (image preview, PDF preview + fallback link, download button)
 * uses `attachment.originalUrl`, NOT `attachment.url` (canonical, now
 * display-priority). This modal's job is to show/save the authoritative,
 * unmodified file — always original, even for the image case where the
 * canonical URL would otherwise serve the optimized display derivative.
 */
export function AttachmentDetailModal({ attachment, open, onOpenChange, canDelete, onDelete, isDeleting }: AttachmentDetailModalProps) {
  if (!attachment) return null;

  const name = attachment.originalName || attachment.fileName;
  const isImage = isImageFormat(attachment.fileFormat);
  const isPdf = attachment.fileFormat === 'application/pdf';
  const creator = attachment.creator;

  const handleDelete = async () => {
    if (!confirm(m['page.attachments_remove_confirm']())) return;
    await onDelete(attachment);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex w-full max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[calc(100vw-4rem)] max-h-[calc(100vh-4rem)]">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="break-all pr-8">{name}</DialogTitle>
          <DialogDescription className="sr-only">
            {attachment.fileFormat} · {formatBytes(attachment.fileSize)}
          </DialogDescription>
        </DialogHeader>

        {/* Preview area — grows to fill the modal, scrolls when needed. */}
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/30 p-4">
          {isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={attachment.originalUrl} alt={name} className="max-h-full max-w-full object-contain" />
          ) : isPdf ? (
            <iframe src={attachment.originalUrl} title={name} className="h-full w-full min-h-[60vh] border-0">
              <a href={attachment.originalUrl} download={name} target="_blank" rel="noopener">
                {m['page.attachment_detail_pdf_fallback']()}
              </a>
            </iframe>
          ) : (
            <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
              <FileTypeIconView mime={attachment.fileFormat} fileName={name} className="h-20 w-20" />
              <p className="text-sm">{m['page.attachment_detail_preview_unavailable']()}</p>
            </div>
          )}
        </div>

        {/* Metadata + actions footer. */}
        <div className="flex flex-col gap-4 border-t px-6 py-4 sm:flex-row sm:items-end sm:justify-between">
          <dl className="flex flex-col gap-1">
            <MetaRow label={m['page.attachment_detail_meta_type']()}>{attachment.fileFormat}</MetaRow>
            <MetaRow label={m['page.attachment_detail_meta_size']()}>{formatBytes(attachment.fileSize)}</MetaRow>
            <MetaRow label={m['page.attachment_detail_meta_uploader']()}>
              <span className="inline-flex items-center gap-2">
                <UserAvatar user={{ username: creator.username, name: creator.name, image: creator.image }} size="sm" />
                <span>{creator.name || creator.username}</span>
                <span className="text-muted-foreground">@{creator.username}</span>
              </span>
            </MetaRow>
            <MetaRow label={m['page.attachment_detail_meta_uploaded_at']()}>{formatAbsoluteDateTime(attachment.createdAt)}</MetaRow>
          </dl>

          <div className="flex shrink-0 items-center gap-2">
            {canDelete && (
              <Button variant="outline" onClick={handleDelete} disabled={isDeleting}>
                {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                <span>{m['page.attachments_remove']()}</span>
              </Button>
            )}
            <Button asChild>
              {/* `target="_blank"` keeps the raw-file fetch in a new tab so
                  the wiki page never full-page-navigates away (which would
                  truncate its streaming-SSR response). */}
              <a href={attachment.originalUrl} download={name} target="_blank" rel="noopener">
                <Download className="h-4 w-4" />
                <span>{m['page.attachment_detail_download']()}</span>
              </a>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
