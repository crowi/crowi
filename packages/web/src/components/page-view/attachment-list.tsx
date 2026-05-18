'use client';

import { useState } from 'react';
import { Paperclip, Loader2, Trash2, Download, ZoomIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/use-auth';
import { useAttachmentList, useRemoveAttachment } from '@/lib/use-attachments';
import { getFileTypeIcon } from '@/lib/file-type-icon';
import type { Attachment } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

interface AttachmentListProps {
  pageId: string;
}

const formatBytes = (size: number): string => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const isImageFormat = (fileFormat: string) => fileFormat.startsWith('image/');

/**
 * Page-footer attachment list. Mirrors the legacy Swig `<div id="page-attachment">`
 * placeholder by sitting between BacklinkList and PageComments inside the
 * page view Card. Hidden entirely when the page has no attachments — same
 * "ghost when empty" behaviour as BacklinkList.
 *
 * Delete is shown only to the attachment creator and to admins. The server
 * also accepts page.grantedUsers (see migrate-attachments task), but we
 * gate that arm in the UI on creator/admin alone for now since the page
 * payload doesn't expose grantedUsers detail to the client. (Editing-flow
 * users in `migrate-page-edit-attachment-dnd` can revisit this.)
 */
export function AttachmentList({ pageId }: AttachmentListProps) {
  const { user: currentUser } = useAuth();
  const { data, isLoading } = useAttachmentList(pageId);
  const removeMutation = useRemoveAttachment(pageId);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (isLoading) return null;
  const attachments = data?.attachments ?? [];
  if (attachments.length === 0) return null;

  const canDelete = (att: Attachment) => {
    if (!currentUser) return false;
    if (currentUser.admin === true) return true;
    return att.creator._id === currentUser.id;
  };

  const handleDelete = async (att: Attachment) => {
    if (!confirm(m['page.attachments_remove_confirm']())) return;
    setDeleteError(null);
    try {
      await removeMutation.mutateAsync(att._id);
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
                // Phase 6 wires this button to a detail modal; the thumbnail
                // is a <button> already so that change is just an onClick.
                <button
                  type="button"
                  // TODO(phase-6): open the attachment detail modal on click.
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
                <div className="flex items-start gap-2 flex-1">
                  <FileTypeIcon className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                    <a
                      href={att.url}
                      download={att.originalName}
                      className="text-foreground hover:text-primary transition-colors break-all inline-flex items-center gap-1"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{att.originalName || att.fileName}</span>
                    </a>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {att.fileFormat} · {formatBytes(att.fileSize)}
                    </p>
                  </div>
                </div>
              )}

              {canDelete(att) && (
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
    </section>
  );
}
