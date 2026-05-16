import { Suspense } from 'react';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { CreatingPagesClient } from './creating-pages-client';
import { m } from '@paraglide/messages.js';

/**
 * RFC-0004 Phase 4 — `Creating pages` management view.
 *
 * Lists the signed-in user's draft pages (`status === 'draft'`) and
 * provides the New page flow. See
 * `docs/rfcs/0004-editor-ux-enhancement.md` §"Creating pages view".
 */
export default function CreatingPagesPage() {
  return (
    <Suspense fallback={<LoadingSpinner message={m['creating_pages.loading']()} />}>
      <CreatingPagesClient />
    </Suspense>
  );
}
