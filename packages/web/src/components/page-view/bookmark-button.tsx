'use client';

import { Bookmark, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToggleBookmark } from '@/lib/use-bookmark';
import { m } from '@paraglide/messages.js';

interface BookmarkButtonProps {
  pageId: string;
}

export function BookmarkButton({ pageId }: BookmarkButtonProps) {
  const { isBookmarked, toggle, isPending, isError, error } = useToggleBookmark(pageId);

  const ariaLabel = isBookmarked ? m['page.bookmark_aria_remove']() : m['page.bookmark_aria_add']();
  const Icon = isPending ? Loader2 : Bookmark;

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => toggle()}
      disabled={isPending}
      aria-label={ariaLabel}
      aria-pressed={isBookmarked}
      title={isError && error instanceof Error ? error.message : ariaLabel}
      className={isBookmarked ? 'text-primary hover:text-primary' : 'text-muted-foreground hover:text-foreground'}
    >
      <Icon className={`h-4 w-4 ${isPending ? 'animate-spin' : ''} ${isBookmarked && !isPending ? 'fill-current' : ''}`} />
    </Button>
  );
}
