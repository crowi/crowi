'use client';

import { Loader2, ThumbsUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToggleLike } from '@/lib/use-like';
import { m } from '@paraglide/messages.js';

interface LikeButtonProps {
  pageId: string;
  isLiked: boolean;
  /**
   * Compact rendering for the sticky header: drop the text label and
   * shrink to an icon-only button matching the watch / bookmark icons.
   */
  iconOnly?: boolean;
}

export function LikeButton({ pageId, isLiked, iconOnly = false }: LikeButtonProps) {
  const { toggle, isPending, isError, error } = useToggleLike(pageId, isLiked);

  const label = isLiked ? m['page.like_label_done']() : m['page.like_label']();
  const ariaLabel = isLiked ? m['page.like_aria_remove']() : m['page.like_aria_add']();
  const Icon = isPending ? Loader2 : ThumbsUp;
  const iconClass = `h-4 w-4${isPending ? ' animate-spin' : ''}${!isPending && isLiked ? ' fill-current' : ''}`;

  if (iconOnly) {
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => toggle()}
        disabled={isPending}
        aria-label={ariaLabel}
        aria-pressed={isLiked}
        title={isError && error instanceof Error ? error.message : ariaLabel}
        className={isLiked ? 'text-primary hover:text-primary' : 'text-muted-foreground hover:text-foreground'}
      >
        <Icon className={iconClass} />
      </Button>
    );
  }

  return (
    <Button
      variant={isLiked ? 'default' : 'outline'}
      size="sm"
      onClick={() => toggle()}
      disabled={isPending}
      aria-label={ariaLabel}
      aria-pressed={isLiked}
      title={isError && error instanceof Error ? error.message : undefined}
    >
      <Icon className={`${iconClass} mr-1`} />
      {label}
    </Button>
  );
}
