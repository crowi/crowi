'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Link2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { useBacklinks } from '@/lib/use-backlinks';
import { m } from '@/paraglide/messages.js';

const INITIAL_LIMIT = 5;
const PAGE_SIZE = 5;

interface BacklinkListProps {
  pageId: string;
}

/**
 * Aux panel rendered inside the page Card. Mirrors the legacy React
 * Backlink.js (git ce868a2e) behaviour:
 * - Fetch the first `INITIAL_LIMIT` records.
 * - Hide the panel entirely when there are zero backlinks.
 * - "Read More" widens the limit by `PAGE_SIZE` and re-fetches at the new
 *   key (offset stays at 0 — simpler than maintaining an accumulator).
 *
 * Errors are silently treated as empty (the hook returns an empty payload
 * on non-200), so a failing API call never prevents the page from rendering.
 */
export function BacklinkList({ pageId }: BacklinkListProps) {
  const [limit, setLimit] = useState(INITIAL_LIMIT);
  const { data, isLoading, isFetching } = useBacklinks(pageId, { limit });

  const backlinks = data?.backlinks ?? [];
  const hasNext = data?.hasNext ?? false;

  // Initial load (no data yet) shows nothing — same end state as 0 backlinks.
  // We don't render a spinner here to keep the panel fully invisible until we
  // know the page actually has incoming links.
  if (isLoading) return null;
  if (backlinks.length === 0) return null;

  return (
    <section className="mt-6 pt-6 border-t" aria-labelledby="backlinks-heading">
      <h3 id="backlinks-heading" className="flex items-center gap-2 text-sm font-semibold text-muted-foreground mb-3">
        <Link2 className="h-4 w-4" aria-hidden="true" />
        {m['page.backlinks_heading']()}
      </h3>
      <ul className="space-y-2">
        {backlinks.map((b) => {
          const author = b.fromRevision.author;
          return (
            <li key={b._id} className="flex items-center gap-3 text-sm">
              {author ? (
                <UserAvatar user={author} size="sm" />
              ) : (
                // Keep the row layout stable when the author is missing
                // (e.g. populated user was deleted). Empty placeholder ring.
                <div className="h-6 w-6 rounded-full bg-muted" aria-hidden="true" />
              )}
              <Link href={b.fromPage.path} className="text-foreground hover:text-primary transition-colors truncate" title={b.fromPage.path}>
                {b.fromPage.path}
              </Link>
            </li>
          );
        })}
      </ul>
      {hasNext && (
        <div className="mt-3">
          <Button variant="ghost" size="sm" disabled={isFetching} onClick={() => setLimit((current) => current + PAGE_SIZE)}>
            {isFetching ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                {m['common.loading']()}
              </>
            ) : (
              m['page.backlinks_read_more']()
            )}
          </Button>
        </div>
      )}
    </section>
  );
}
