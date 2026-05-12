'use client';

import { Trash2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { formatDistanceToNow } from '@/lib/date-utils';
import type { Comment } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

interface CommentItemProps {
  comment: Comment;
  canDelete: boolean;
  isDeleting?: boolean;
  onDelete?: (commentId: string) => void;
}

/**
 * Renders a single comment with creator avatar, name, time and body.
 * Body is rendered as plain text with newlines preserved (Markdown rendering
 * is intentionally deferred — see openQuestions in the migration task).
 */
export function CommentItem({ comment, canDelete, isDeleting, onDelete }: CommentItemProps) {
  const creator = typeof comment.creator === 'object' && comment.creator ? comment.creator : null;

  return (
    <div className="flex gap-3 py-3">
      <div className="flex-shrink-0 pt-0.5">
        {creator ? <UserAvatar user={creator} size="sm" /> : <div className="h-6 w-6 rounded-full bg-muted" aria-hidden />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">{creator?.name ?? creator?.username ?? m['page_comments.unknown_user']()}</span>
            <span className="text-muted-foreground text-xs">{formatDistanceToNow(comment.createdAt)}</span>
          </div>
          {canDelete && onDelete && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => onDelete(comment._id)}
              disabled={isDeleting}
              aria-label={m['page_comments.delete_aria']()}
            >
              {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </Button>
          )}
        </div>
        <div className="mt-1 text-sm whitespace-pre-wrap break-words">{comment.comment}</div>
      </div>
    </div>
  );
}
