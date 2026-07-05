'use client';

import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { Eye, Loader2, MessageSquare, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { COMMENT_HIGHLIGHT_MS, diffNewCommentIds } from '@/lib/comment-highlight';
import { SCROLL_TARGETS } from '@/lib/scroll-to-section';
import { useAuth } from '@/lib/use-auth';
import { useAddComment, useDeleteComment, usePageCommentsList } from '@/lib/use-page-comments';
import { useToggleWatch } from '@/lib/use-watch';
import { CommentForm } from './comment-form';
import { CommentItem } from './comment-item';

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

  const { comments, isLoading, isError, error } = usePageCommentsList(pageId);
  const { addComment, isPending: isAdding, error: addError } = useAddComment(pageId);
  const { deleteComment, isPending: isDeleting } = useDeleteComment(pageId);
  const { toggle: toggleWatch } = useToggleWatch(pageId);

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  // Shown once after a comment auto-creates a fresh WATCH row. Hidden again
  // when the user dismisses it or chooses to stop watching from here.
  const [showWatchHint, setShowWatchHint] = useState(false);

  // ── feature-live-page-comment-sync — new-comment highlight ───────────
  // When a `comment-changed` frame from another user makes PageView
  // invalidate the comment list, the re-fetch surfaces the new comment
  // here. `PageView` never tells us *which* id is new — we derive it from
  // a seen-set diff (spec §highlight), which is idempotent under the
  // origin double-delivery and robust to dropped frames.
  //   - `seenIdsRef === null` until the first load resolves, so existing
  //     comments never flash on initial render.
  //   - a newly-seen id is added to `highlightedIds` and removed after
  //     `COMMENT_HIGHLIGHT_MS`, letting the amber background fade out.
  const seenIdsRef = useRef<Set<string> | null>(null);
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(() => new Set());
  const highlightTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Reset per page: SPA navigation swaps the `page` prop WITHOUT
  // remounting PageComments, so a stale seen-set from page X would make
  // every one of page Y's comments look "new" (or suppress a real new
  // one). Clears the seen-set and any in-flight fade timers.
  useEffect(() => {
    seenIdsRef.current = null;
    for (const timer of highlightTimersRef.current.values()) clearTimeout(timer);
    highlightTimersRef.current.clear();
    setHighlightedIds(new Set());
  }, [pageId]);

  // Detect newly-appeared comments and highlight them transiently. Keyed
  // on the id list so it re-runs whenever a comment is added / removed.
  const commentIdsKey = comments.map((c) => c._id).join(',');
  useEffect(() => {
    // Don't seed the seen-set until the first load resolves — an empty
    // list mid-load would seed `∅`, then flash every existing comment
    // when the data arrives.
    if (isLoading) return;
    const currentIds = comments.map((c) => c._id);
    // The reader's own comments must never highlight: their add-mutation
    // invalidates + re-fetches the list locally (independent of the
    // presence self-suppression), surfacing their own id here as newly
    // seen. Author-keyed suppression covers that local path (AC#4).
    const ownIds = new Set(
      comments
        .filter((c) => {
          const creator = typeof c.creator === 'object' && c.creator ? c.creator : null;
          return !!user && !!creator && creator._id === user.id;
        })
        .map((c) => c._id),
    );
    const { newIds, nextSeen } = diffNewCommentIds(seenIdsRef.current, currentIds, ownIds);
    seenIdsRef.current = nextSeen;
    if (newIds.length === 0) return;

    setHighlightedIds((prev) => {
      const next = new Set(prev);
      for (const id of newIds) next.add(id);
      return next;
    });
    for (const id of newIds) {
      const existing = highlightTimersRef.current.get(id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        highlightTimersRef.current.delete(id);
        setHighlightedIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, COMMENT_HIGHLIGHT_MS);
      highlightTimersRef.current.set(id, timer);
    }
    // `comments` is captured via the stable `commentIdsKey`; depending on
    // the array identity would re-run on every query settle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentIdsKey, isLoading]);

  // Clear pending fade timers on unmount so a late timer never fires into
  // an unmounted component.
  useEffect(() => {
    const timers = highlightTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const handleSubmit = async (commentBody: string) => {
    if (!revisionId) return;
    const { newlyWatching } = await addComment({ revisionId, comment: commentBody });
    setShowWatchHint(newlyWatching);
  };

  const handleStopWatching = () => {
    setShowWatchHint(false);
    toggleWatch();
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
    <section id="comments" className="mt-8 border-t pt-6 scroll-mt-4" aria-label={m['page_comments.heading']()}>
      <div className="flex items-center gap-2 mb-4">
        <MessageSquare className="h-5 w-5 text-muted-foreground" />
        <h2 id={SCROLL_TARGETS.COMMENTS} className="text-lg font-semibold scroll-mt-4 outline-none">
          {m['page_comments.heading']()} {comments.length > 0 ? `(${comments.length})` : ''}
        </h2>
      </div>

      {!isReadOnly && revisionId && (
        <div className="mb-4">
          <CommentForm isSubmitting={isAdding} error={addError} onSubmit={handleSubmit} isFirstComment={!isLoading && !isError && comments.length === 0} />
        </div>
      )}

      {showWatchHint && (
        <Alert className="mb-4 items-center [&>svg]:translate-y-0">
          <Eye className="h-4 w-4" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{m['page_comments.now_watching']()}</span>
            <span className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={handleStopWatching}>
                {m['page_comments.now_watching_undo']()}
              </Button>
              <Button type="button" variant="ghost" size="sm" aria-label={m['page_comments.now_watching_dismiss']()} onClick={() => setShowWatchHint(false)}>
                <X className="h-4 w-4" />
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">{m['page_comments.loading']()}</span>
        </div>
      )}

      {isError && (
        <Alert variant="destructive">
          <AlertTitle>{m['page_comments.failed_to_load']()}</AlertTitle>
          <AlertDescription>{error?.message ?? m['common.try_again_later']()}</AlertDescription>
        </Alert>
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
                  isNew={highlightedIds.has(comment._id)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
