'use client';

import { useState } from 'react';
import { Paperclip, Loader2, Trash2, ZoomIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/use-auth';
import { useAttachmentList, useRemoveAttachment } from '@/lib/use-attachments';
import { getFileTypeIcon } from '@/lib/file-type-icon';
import { AttachmentDetailModal } from './attachment-detail-modal';
import type { Attachment } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

interface AttachmentListProps {
  pageId: string;
}

/** Human-readable byte size. Exported so the detail modal reuses the same format. */
export const formatBytes = (size: number): string => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

/** Whether a MIME type is an image — shared with the detail modal. */
export const isImageFormat = (fileFormat: string) => fileFormat.startsWith('image/');

/**
 * Page-footer attachment list. Mirrors the legacy Swig `<div id="page-attachment">`
 * placeholder by sitting between BacklinkList and PageComments inside the
 * page view Card. Hidden entirely when the page has no attachments — same
 * "ghost when empty" behaviour as BacklinkList.
 *
 * Clicking any attachment (image thumbnail or non-image row) opens the
 * detail modal. Delete is offered to any authenticated user — attachment
 * deletion is open collaboration (wiki policy), matching the server's
 * authenticated-only `removeAttachment` authz.
 */
export function AttachmentList({ pageId }: AttachmentListProps) {
  const { user: currentUser } = useAuth();
  const { data, isLoading } = useAttachmentList(pageId);
  const removeMutation = useRemoveAttachment(pageId);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Attachment | null>(null);

  if (isLoading) return null;
  const attachments = data?.attachments ?? [];
  if (attachments.length === 0) return null;

  // Wiki policy: deletion is open to any authenticated user.
  const canDelete = !!currentUser;

  const handleDelete = async (att: Attachment) => {
    if (!confirm(m['page.attachments_remove_confirm']())) return;
    setDeleteError(null);
    try {
      await removeMutation.mutateAsync(att._id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : m['page.attachments_remove_failed']());
    }
  };

  // Delete invoked from the detail modal — close the modal on success so the
  // user isn't left looking at a now-deleted file.
  const handleModalDelete = async (att: Attachment) => {
    setDeleteError(null);
    try {
      await removeMutation.mutateAsync(att._id);
      setSelected(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : m['page.attachments_remove_failed']());
    }
  };

  return (
    <section className="mt-6 pt-6 border-t" aria-labelledby="attachments-heading">
      <h3 id="attachments-heading" className="flex items-center gap-2 text-sm font-semibold text-muted-foreground mb-3">
        <Paperclip className="h-4 w-4" aria-hidden="true" />
        {m['page.attachments_heading']()}
      </h3>

      <ul className="space-y-3">
        {attachments.map((att) => {
          const FileTypeIcon = getFileTypeIcon(att.fileFormat, att.originalName || att.fileName);
          return (
            <li key={att._id} className="flex items-start gap-3 text-sm">
              {isImageFormat(att.fileFormat) ? (
                <button
                  type="button"
                  onClick={() => setSelected(att)}
                  className="group relative block w-1/5 max-w-[150px] shrink-0 overflow-hidden rounded border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={att.originalName || att.fileName}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={att.url} alt={att.originalName} className="aspect-square w-full object-cover" loading="lazy" />
                  <span
                    className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                    aria-hidden="true"
                  >
                    <ZoomIn className="h-6 w-6 text-white" />
                  </span>
                </button>
              ) : (
                // Clicking opens the detail modal — download moved into the
                // modal so image / non-image click behaviour is uniform.
                <button
                  type="button"
                  onClick={() => setSelected(att)}
                  className="flex flex-1 items-start gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                >
                  <FileTypeIcon className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                    <span className="text-foreground transition-colors break-all hover:text-primary">{att.originalName || att.fileName}</span>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {att.fileFormat} · {formatBytes(att.fileSize)}
                    </p>
                  </div>
                </button>
              )}

              {canDelete && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(att)}
                  disabled={removeMutation.isPending}
                  aria-label={m['page.attachments_remove']()}
                  className="shrink-0"
                >
                  {removeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {deleteError && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">
          {deleteError}
        </p>
      )}

      <AttachmentDetailModal
        attachment={selected}
        open={selected !== null}
        onOpenChange={(o) => {
          if (!o) setSelected(null);
        }}
        canDelete={canDelete}
        onDelete={handleModalDelete}
        isDeleting={removeMutation.isPending}
      />
    </section>
  );
}
