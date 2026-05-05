'use client';

import { Bookmark, BookmarkCheck, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToggleBookmark } from '@/lib/use-bookmark';

interface BookmarkButtonProps {
  pageId: string;
}

export function BookmarkButton({ pageId }: BookmarkButtonProps) {
  const { isBookmarked, toggle, isPending, isError, error } = useToggleBookmark(pageId);

  const label = isBookmarked ? 'Bookmarked' : 'Bookmark';
  const ariaLabel = isBookmarked ? 'Remove bookmark' : 'Add bookmark';

  return (
    <Button
      variant={isBookmarked ? 'default' : 'outline'}
      size="sm"
      onClick={() => toggle()}
      disabled={isPending}
      aria-label={ariaLabel}
      aria-pressed={isBookmarked}
      title={isError && error instanceof Error ? error.message : undefined}
    >
      {isPending ? (
        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
      ) : isBookmarked ? (
        <BookmarkCheck className="h-4 w-4 mr-1" />
      ) : (
        <Bookmark className="h-4 w-4 mr-1" />
      )}
      {label}
    </Button>
  );
}
