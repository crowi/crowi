'use client';

import { Loader2, ThumbsUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToggleLike } from '@/lib/use-like';

interface LikeButtonProps {
  pageId: string;
  isLiked: boolean;
}

export function LikeButton({ pageId, isLiked }: LikeButtonProps) {
  const { toggle, isPending, isError, error } = useToggleLike(pageId, isLiked);

  const label = isLiked ? 'Liked' : 'Like';
  const ariaLabel = isLiked ? 'Remove like' : 'Like';

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
      {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <ThumbsUp className={`h-4 w-4 mr-1${isLiked ? ' fill-current' : ''}`} />}
      {label}
    </Button>
  );
}
