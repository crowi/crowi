'use client';

import Link from 'next/link';
import { Loader2, AlertCircle, FileText } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageListItem } from '@/components/page-list/page-list-item';
import { useUserPagesInfinite } from '@/lib/use-user-page';
import type { Page } from '@crowi/api-contract';

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
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <span className="ml-2 text-muted-foreground">Loading pages...</span>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>Failed to load pages. Please try again later.</AlertDescription>
      </Alert>
    );
  }

  // Flatten all pages
  const allPages: Page[] = data?.pages.flatMap((page) => page.pages) ?? [];
  const total = data?.pages[0]?.total ?? 0;

  if (allPages.length === 0) {
    return (
      <Card className="p-8 text-center">
        <FileText className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
        <p className="text-muted-foreground">No pages created yet.</p>
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
            <Link href={`/user/${username}/recent-create`}>View all {total} pages</Link>
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
                Loading...
              </>
            ) : (
              'Load more'
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
