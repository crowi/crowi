'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Paperclip, History } from 'lucide-react';
import { ErrorAlert } from '@/components/ui/error-alert';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { useAuth } from '@/lib/use-auth';
import { useAttachmentUsage } from '@/lib/use-attachment-usage';
import { useRemoveAttachment } from '@/lib/use-attachments';
import { formatDateTime } from '@/lib/date-utils';
import { AttachmentDetailModal } from './attachment-detail-modal';
import { AttachmentThumbnail } from './attachment-thumbnail';
import type { Attachment, PastAttachmentUsage } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

interface AttachmentUsageViewProps {
  pageId: string;
}

/** Build the revision-view link for a past revision (`/<path>?revision_id=<id>`). */
const revisionHref = (pagePath: string, revisionId: string): string => {
  const path = pagePath.startsWith('/') ? pagePath : `/${pagePath}`;
  return `${path}?revision_id=${encodeURIComponent(revisionId)}`;
};

/**
 * Phase 8 — the `/_attachments?pageId=` page body.
 *
 * Two sections:
 *   - top: attachments referenced by the page's latest revision.
 *   - bottom: attachments referenced ONLY by past revisions (each linking
 *     to the revision(s) that used it), plus orphan files referenced by no
 *     revision at all.
 *
 * Thumbnail / icon rendering (`AttachmentThumbnail`) and the click-to-open
 * detail modal (`AttachmentDetailModal`) are reused from Phase 5/6.
 */
export function AttachmentUsageView({ pageId }: AttachmentUsageViewProps) {
  const { user: currentUser } = useAuth();
  const { data, isLoading, isError, error } = useAttachmentUsage(pageId);
  const removeMutation = useRemoveAttachment(pageId);
  const [selected, setSelected] = useState<Attachment | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (isLoading) return <LoadingSpinner message={m['page.attachments_all_loading']()} />;
  if (isError || !data) {
    return <ErrorAlert message={error instanceof Error ? error.message : m['page.attachments_all_failed']()} />;
  }

  // Wiki policy: deletion is open to any authenticated user.
  const canDelete = !!currentUser;

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
    <div className="mx-auto w-full max-w-3xl py-6">
      <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
        <Paperclip className="h-5 w-5" aria-hidden="true" />
        {m['page.attachments_all_title']()}
      </h1>
      <Link
        href={data.pagePath.startsWith('/') ? data.pagePath : `/${data.pagePath}`}
        className="mt-1 inline-block text-sm text-muted-foreground hover:text-primary break-all"
      >
        {data.pagePath}
      </Link>

      {/* Top section — referenced by the latest revision. */}
      <section className="mt-6" aria-labelledby="attachments-latest-heading">
        <h2 id="attachments-latest-heading" className="text-sm font-semibold text-muted-foreground mb-3">
          {m['page.attachments_section_latest']()}
        </h2>
        {data.latest.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m['page.attachments_none_in_use']()}</p>
        ) : (
          <ul className="grid grid-cols-3 gap-3 sm:grid-cols-5">
            {data.latest.map((att) => (
              <li key={att._id}>
                <AttachmentThumbnail attachment={att} onSelect={setSelected} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Bottom section — referenced only by past revisions (+ orphans). */}
      <section className="mt-8 pt-6 border-t" aria-labelledby="attachments-past-heading">
        <h2 id="attachments-past-heading" className="text-sm font-semibold text-muted-foreground mb-3">
          {m['page.attachments_section_past']()}
        </h2>
        {data.past.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m['page.attachments_past_none']()}</p>
        ) : (
          <ul className="space-y-5">
            {data.past.map((entry: PastAttachmentUsage) => (
              <li key={entry.attachment._id} className="flex flex-col gap-2 text-sm">
                <div className="flex items-start gap-3">
                  <AttachmentThumbnail attachment={entry.attachment} onSelect={setSelected} />
                </div>
                {entry.referencingRevisions.length === 0 ? (
                  <p className="text-xs text-muted-foreground pl-1">{m['page.attachments_orphan']()}</p>
                ) : (
                  <ul className="flex flex-col gap-1 pl-1">
                    {entry.referencingRevisions.map((rev) => (
                      <li key={rev.revisionId}>
                        <Link
                          href={revisionHref(data.pagePath, rev.revisionId)}
                          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-primary"
                        >
                          <History className="h-3.5 w-3.5" aria-hidden="true" />
                          {m['page.attachments_used_in_revision']({ date: formatDateTime(rev.createdAt) })}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {deleteError && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
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
    </div>
  );
}
