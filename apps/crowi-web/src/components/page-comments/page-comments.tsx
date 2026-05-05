'use client';

import { useState } from 'react';
import { Loader2, MessageSquare } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useAuth } from '@/lib/use-auth';
import { usePageComments } from '@/lib/use-page-comments';
import type { PageWithRevision } from '@crowi/api-contract';
import { CommentItem } from './comment-item';
import { CommentForm } from './comment-form';

interface PageCommentsProps {
  page: PageWithRevision;
}

/**
 * Comment section rendered below the page body.
 * - Read-only when the page is in trash (status === 'deleted').
 * - The auth-required guard happens at the layout level, so by the time we
 *   render here the user is expected to be signed in.
 */
export function PageComments({ page }: PageCommentsProps) {
  const { user } = useAuth();
  const pageId = page._id;
  const revisionId = typeof page.revision === 'object' ? page.revision._id : (page.revision ?? null);
  const isReadOnly = page.status === 'deleted';

  const {
    comments,
    isLoading,
    isError,
    error,
    addComment,
    isAdding,
    addError,
    deleteComment,
    isDeleting,
  } = usePageComments(pageId);

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const handleSubmit = async (commentBody: string) => {
    if (!revisionId) return;
    await addComment({ revisionId, comment: commentBody });
  };

  const handleDelete = async (commentId: string) => {
    setPendingDeleteId(commentId);
    try {
      await deleteComment(commentId);
    } finally {
      setPendingDeleteId(null);
    }
  };

  return (
    <section className="mt-8 border-t pt-6" aria-label="Comments">
      <div className="flex items-center gap-2 mb-4">
        <MessageSquare className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Comments {comments.length > 0 ? `(${comments.length})` : ''}</h2>
      </div>

      {!isReadOnly && revisionId && (
        <div className="mb-4">
          <CommentForm isSubmitting={isAdding} error={addError} onSubmit={handleSubmit} />
        </div>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Loading comments...</span>
        </div>
      )}

      {isError && (
        <Alert variant="destructive">
          <AlertTitle>Failed to load comments</AlertTitle>
          <AlertDescription>{error?.message ?? 'Please try again later.'}</AlertDescription>
        </Alert>
      )}

      {!isLoading && !isError && comments.length === 0 && (
        <p className="text-sm text-muted-foreground py-4">No comments yet.</p>
      )}

      {!isLoading && !isError && comments.length > 0 && (
        <ul className="divide-y">
          {comments.map((comment) => {
            const creator = typeof comment.creator === 'object' && comment.creator ? comment.creator : null;
            const isOwner = !!user && !!creator && creator._id === user.id;
            return (
              <li key={comment._id}>
                <CommentItem
                  comment={comment}
                  canDelete={!isReadOnly && isOwner}
                  isDeleting={isDeleting && pendingDeleteId === comment._id}
                  onDelete={isOwner ? handleDelete : undefined}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
