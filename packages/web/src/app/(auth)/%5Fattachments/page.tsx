'use client';

import { m } from '@paraglide/messages.js';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { AttachmentUsageView } from '@/components/page-view/attachment-usage-view';
import { ErrorAlert } from '@/components/ui/error-alert';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { pageDisplayName } from '@/lib/page-path';
import { usePage } from '@/lib/use-page';
import { usePageTitle } from '@/lib/use-page-title';

/**
 * /_attachments?pageId=<id>
 *
 * Phase 8 — the "view all attachments" destination linked from the page
 * footer (`AttachmentList`). Reserved (`/_*`) route so it never collides
 * with a user-created page slug. Splits a page's attachments into ones
 * used by the latest revision and ones used only by past revisions.
 */
function AttachmentsPageInner() {
  const searchParams = useSearchParams();
  const pageId = searchParams.get('pageId');

  const { page } = usePage({ page_id: pageId ?? undefined });
  usePageTitle(page ? m['doc_title.attachments']({ path: pageDisplayName(page.path) }) : null);

  if (!pageId) {
    return <ErrorAlert message={m['page.attachments_all_failed']()} />;
  }

  return <AttachmentUsageView pageId={pageId} />;
}

export default function AttachmentsPage() {
  return (
    <Suspense fallback={<LoadingSpinner message={m['page.attachments_all_loading']()} />}>
      <AttachmentsPageInner />
    </Suspense>
  );
}
