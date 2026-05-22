'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ErrorAlert } from '@/components/ui/error-alert';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { PageHistoryView } from '@/components/page-history/page-history-view';
import { pageBasename } from '@/lib/page-path';
import { usePageTitle } from '@/lib/use-page-title';
import { m } from '@paraglide/messages.js';

/**
 * /_history?path=<page path>
 *
 * Reserved (`/_*`) route for the revision-history view. Splitting it off the
 * `[[...slug]]` catch-all avoids collisions with any user-created page whose
 * slug happens to end in 'history'.
 */
function HistoryPageInner() {
  const searchParams = useSearchParams();
  const path = searchParams.get('path');

  usePageTitle(path ? m['doc_title.history']({ path: pageBasename(path) }) : null);

  if (!path) {
    return <ErrorAlert message={m['page_history.failed_to_load']({ message: 'path parameter is required' })} />;
  }

  return <PageHistoryView path={path} />;
}

export default function HistoryPage() {
  return (
    <Suspense fallback={<LoadingSpinner message={m['page_history.loading']()} />}>
      <HistoryPageInner />
    </Suspense>
  );
}
