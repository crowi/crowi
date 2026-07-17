'use client';

import type { Page } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { FolderTree } from 'lucide-react';
import Link from 'next/link';
import { LoadMoreButton, PageListEmptyCard, PageListSectionHeader, PageRowsCard, PageRowsSkeleton } from '@/components/page-list/page-list-shared';
import { Button } from '@/components/ui/button';
import { ErrorAlert } from '@/components/ui/error-alert';
import { useUserSubpagesInfinite } from '@/lib/use-user-page';

interface UserSubpagesProps {
  username: string;
  /** Preview mode renders only a few rows and a "View all" link. */
  preview?: boolean;
  /** How many rows to render in preview mode. */
  previewLimit?: number;
}

// Page size for the full-mode infinite query — matches the sibling
// `UserRecentPages`/`UserBookmarks` Load More page size.
const DEFAULT_FULL_LIMIT = 30;

/**
 * `/user/<username>/` subpages tab — path-rooted, fully recursive listing
 * (distinct from `UserRecentPages`, which is creator-rooted). Mirrors
 * `UserRecentPages`'s preview/full structure verbatim; the one addition is
 * de-duplicating by `_id` before rendering, because the underlying offset
 * pagination is best-effort (a create/delete/rename between page fetches can
 * shift row boundaries and hand back a row already seen on a prior page —
 * see `findSubpagesByUserNamespace`'s doc comment for why this is accepted
 * rather than solved with cursor pagination).
 */
export function UserSubpages({ username, preview = false, previewLimit = 5 }: UserSubpagesProps) {
  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useUserSubpagesInfinite(
    username,
    preview ? previewLimit : DEFAULT_FULL_LIMIT,
  );

  if (isLoading) {
    return <PageRowsSkeleton rows={preview ? previewLimit : 6} />;
  }

  if (error) {
    return <ErrorAlert message={m['user_page.subpages_failed']()} />;
  }

  // Flatten all infinite-query pages, de-duplicating by `_id` — a boundary
  // shift from a concurrent create/delete/rename can otherwise repeat a row
  // across two fetched pages, which would both double-render it and collide
  // on React's list `key`.
  const rawPages: Page[] = data?.pages.flatMap((p) => p.pages) ?? [];
  const seen = new Set<string>();
  const allPages: Page[] = [];
  for (const page of rawPages) {
    if (seen.has(page._id)) continue;
    seen.add(page._id);
    allPages.push(page);
  }
  const total = data?.pages[0]?.total ?? 0;

  if (allPages.length === 0) {
    return <PageListEmptyCard icon={FolderTree} message={m['user_page.subpages_empty']()} />;
  }

  const displayPages = preview ? allPages.slice(0, previewLimit) : allPages;

  return (
    <div className="space-y-2">
      <PageListSectionHeader icon={FolderTree} label={m['page_list.page_count']({ count: total })} />
      <PageRowsCard pages={displayPages} />

      {/* Preview mode: "View all" link */}
      {preview && total > previewLimit && (
        <div className="pt-2 text-center">
          <Button variant="outline" asChild>
            <Link href={`/user/${username}/pages`}>{m['user_page.view_all_subpages']({ count: total })}</Link>
          </Button>
        </div>
      )}

      {/* Full mode: "Load more" pager */}
      {!preview && hasNextPage && (
        <div className="pt-2">
          <LoadMoreButton onClick={() => fetchNextPage()} isLoading={isFetchingNextPage} />
        </div>
      )}
    </div>
  );
}
