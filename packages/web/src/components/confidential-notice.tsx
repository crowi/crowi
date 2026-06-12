'use client';

import { ShieldAlert } from 'lucide-react';
import { useAppInfo } from '@/lib/use-app-info';
import { useSearchFocus } from '@/lib/search-focus-context';

/**
 * Always-on confidentiality notice driven by the operator-set
 * `app:confidential` value, surfaced via the public `/app/info` channel
 * (see use-app-info). Hidden entirely when the notice is unset (null).
 *
 * Two placements keep the marker visible on every viewport without a
 * band getting in the way on desktop:
 * - `inline` (default): a compact muted-amber label in the right cluster
 *   of the (auth) header (≥ sm). Yields (hides) while the search box is
 *   focused so it can expand into the right cluster.
 * - `bar`: a thin centered line directly under the header, mobile only
 *   (< sm), where the right cluster has no room for inline text but the
 *   marker must still appear on screenshots / printouts.
 */
export function ConfidentialNotice({ placement = 'inline' }: { placement?: 'inline' | 'bar' }) {
  const { data: appInfo } = useAppInfo();
  const { isSearchFocused } = useSearchFocus();
  const notice = appInfo?.confidential;
  if (!notice) {
    return null;
  }

  if (placement === 'bar') {
    return (
      <div
        role="note"
        className="sm:hidden border-b border-amber-200/70 bg-amber-50 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-200"
      >
        <div className="max-w-4xl mx-auto px-4 py-1 flex items-center justify-center gap-1 text-xs font-medium tracking-wide">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{notice}</span>
        </div>
      </div>
    );
  }

  // Yield the header width to the search box while it is expanded.
  if (isSearchFocused) {
    return null;
  }
  return (
    <span
      role="note"
      title={notice}
      className="hidden sm:flex items-center gap-1 max-w-[16rem] min-w-0 text-xs font-medium tracking-wide text-amber-700 dark:text-amber-400"
    >
      <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{notice}</span>
    </span>
  );
}
