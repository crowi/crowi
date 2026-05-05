'use client';

import Link from 'next/link';
import { Loader2, AlertCircle, Bookmark } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageListItem } from '@/components/page-list/page-list-item';
import { useUserBookmarksInfinite } from '@/lib/use-user-page';
import type { Bookmark as BookmarkType } from '@crowi/api-contract';

interface UserBookmarksProps {
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

export function UserBookmarks({ username, preview = false, previewLimit = 5 }: UserBookmarksProps) {
  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useUserBookmarksInfinite(username, preview ? previewLimit : 10);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <span className="ml-2 text-muted-foreground">Loading bookmarks...</span>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>Failed to load bookmarks. Please try again later.</AlertDescription>
      </Alert>
    );
  }

  // Flatten all pages of bookmarks
  const allBookmarks: BookmarkType[] = data?.pages.flatMap((page) => page.bookmarks) ?? [];
  const total = data?.pages[0]?.total ?? 0;

  if (allBookmarks.length === 0) {
    return (
      <Card className="p-8 text-center">
        <Bookmark className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
        <p className="text-muted-foreground">No bookmarks yet.</p>
      </Card>
    );
  }

  // In preview mode, show limited items
  const displayBookmarks = preview ? allBookmarks.slice(0, previewLimit) : allBookmarks;

  return (
    <div className="space-y-4">
      <Card className="divide-y">
        {displayBookmarks.map((bookmark) => (
          <PageListItem key={bookmark._id} page={bookmark.page} />
        ))}
      </Card>

      {/* Preview mode: "View all" link */}
      {preview && total > previewLimit && (
        <div className="text-center">
          <Button variant="outline" asChild>
            <Link href={`/user/${username}/bookmarks`}>View all {total} bookmarks</Link>
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
