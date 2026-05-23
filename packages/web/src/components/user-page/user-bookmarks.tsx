'use client';

import type { Bookmark as BookmarkType } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { Bookmark } from 'lucide-react';
import Link from 'next/link';
import { LoadMoreButton, PageListEmptyCard, PageListSectionHeader, PageRowsCard, PageRowsSkeleton } from '@/components/page-list/page-list-shared';
import { Button } from '@/components/ui/button';
import { ErrorAlert } from '@/components/ui/error-alert';
import { useUserBookmarksInfinite } from '@/lib/use-user-page';

interface UserBookmarksProps {
  username: string;
  /** Preview mode renders only a few rows and a "View all" link. */
  preview?: boolean;
  /** How many rows to render in preview mode. */
  previewLimit?: number;
}

// Page size for the full-mode infinite query. Bumped up from the
// legacy 10 so the first scroll already shows a substantial chunk.
const DEFAULT_FULL_LIMIT = 30;

export function UserBookmarks({ username, preview = false, previewLimit = 5 }: UserBookmarksProps) {
  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useUserBookmarksInfinite(
    username,
    preview ? previewLimit : DEFAULT_FULL_LIMIT,
  );

  if (isLoading) {
    return <PageRowsSkeleton rows={preview ? previewLimit : 6} />;
  }

  if (error) {
    return <ErrorAlert message={m['user_page.bookmarks_failed']()} />;
  }

  // Flatten all infinite-query pages of bookmarks.
  const allBookmarks: BookmarkType[] = data?.pages.flatMap((p) => p.bookmarks) ?? [];
  const total = data?.pages[0]?.total ?? 0;

  if (allBookmarks.length === 0) {
    return <PageListEmptyCard icon={Bookmark} message={m['user_page.bookmarks_empty']()} />;
  }

  const displayBookmarks = preview ? allBookmarks.slice(0, previewLimit) : allBookmarks;
  const displayPages = displayBookmarks.map((b) => b.page);

  return (
    <div className="space-y-2">
      <PageListSectionHeader icon={Bookmark} label={m['user_page.bookmark_count']({ count: total })} />
      <PageRowsCard pages={displayPages} />

      {/* Preview mode: "View all" link */}
      {preview && total > previewLimit && (
        <div className="pt-2 text-center">
          <Button variant="outline" asChild>
            <Link href={`/user/${username}/bookmarks`}>{m['user_page.view_all_bookmarks']({ count: total })}</Link>
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
