'use client';

import Link from 'next/link';
import { Loader2, FileText } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { ErrorAlert } from '@/components/ui/error-alert';
import { PageListItem } from '@/components/page-list/page-list-item';
import { useUserPagesInfinite } from '@/lib/use-user-page';
import type { Page } from '@crowi/api-contract';
import { m } from '@/paraglide/messages.js';

interface UserRecentPagesProps {
  username: string;
  /**
   * If true, shows only a preview (limited items with "View all" link)
   */
  preview?: boolean;
  /**
   * Number of items to show in preview mode
   */
  previewLimit?: number;
}

export function UserRecentPages({ username, preview = false, previewLimit = 5 }: UserRecentPagesProps) {
  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useUserPagesInfinite(username, preview ? previewLimit : 10);

  if (isLoading) {
    return <LoadingSpinner message={m['user_page.recent_pages_loading']()} size="md" className="py-8" />;
  }

  if (error) {
    return <ErrorAlert message={m['user_page.recent_pages_failed']()} />;
  }

  // Flatten all pages
  const allPages: Page[] = data?.pages.flatMap((page) => page.pages) ?? [];
  const total = data?.pages[0]?.total ?? 0;

  if (allPages.length === 0) {
    return (
      <Card className="p-8 text-center">
        <FileText className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
        <p className="text-muted-foreground">{m['user_page.recent_pages_empty']()}</p>
      </Card>
    );
  }

  // In preview mode, show limited items
  const displayPages = preview ? allPages.slice(0, previewLimit) : allPages;

  return (
    <div className="space-y-4">
      <Card className="divide-y">
        {displayPages.map((page) => (
          <PageListItem key={page._id} page={page} />
        ))}
      </Card>

      {/* Preview mode: "View all" link */}
      {preview && total > previewLimit && (
        <div className="text-center">
          <Button variant="outline" asChild>
            <Link href={`/user/${username}/recent-create`}>{m['user_page.view_all_pages']({ count: total })}</Link>
          </Button>
        </div>
      )}

      {/* Full mode: "Load more" button */}
      {!preview && hasNextPage && (
        <div className="text-center">
          <Button variant="outline" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                {m['user_page.loading']()}
              </>
            ) : (
              m['user_page.load_more']()
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
