'use client';

import type { Page } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { FileText } from 'lucide-react';
import Link from 'next/link';
import { LoadMoreButton, PageListEmptyCard, PageListSectionHeader, PageRowsCard, PageRowsSkeleton } from '@/components/page-list/page-list-shared';
import { Button } from '@/components/ui/button';
import { ErrorAlert } from '@/components/ui/error-alert';
import { useUserPagesInfinite } from '@/lib/use-user-page';

interface UserRecentPagesProps {
  username: string;
  /** Preview mode renders only a few rows and a "View all" link. */
  preview?: boolean;
  /** How many rows to render in preview mode. */
  previewLimit?: number;
}

// Page size for the full-mode infinite query. Bumped up from the
// legacy 10 so the first scroll already shows a substantial chunk —
// the redesigned dense rows can comfortably absorb the extra height.
const DEFAULT_FULL_LIMIT = 30;

export function UserRecentPages({ username, preview = false, previewLimit = 5 }: UserRecentPagesProps) {
  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useUserPagesInfinite(
    username,
    preview ? previewLimit : DEFAULT_FULL_LIMIT,
  );

  if (isLoading) {
    return <PageRowsSkeleton rows={preview ? previewLimit : 6} />;
  }

  if (error) {
    return <ErrorAlert message={m['user_page.recent_pages_failed']()} />;
  }

  // Flatten all infinite-query pages of results.
  const allPages: Page[] = data?.pages.flatMap((p) => p.pages) ?? [];
  const total = data?.pages[0]?.total ?? 0;

  if (allPages.length === 0) {
    return <PageListEmptyCard icon={FileText} message={m['user_page.recent_pages_empty']()} />;
  }

  const displayPages = preview ? allPages.slice(0, previewLimit) : allPages;

  return (
    <div className="space-y-2">
      <PageListSectionHeader icon={FileText} label={m['page_list.page_count']({ count: total })} />
      <PageRowsCard pages={displayPages} />

      {/* Preview mode: "View all" link */}
      {preview && total > previewLimit && (
        <div className="pt-2 text-center">
          <Button variant="outline" asChild>
            <Link href={`/user/${username}/recent-create`}>{m['user_page.view_all_pages']({ count: total })}</Link>
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
