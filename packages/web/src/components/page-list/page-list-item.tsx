'use client';

import type { Page } from '@crowi/api-contract';
import { PageStatusEnum } from '@crowi/api-contract';
import { isLinkOnlyGrant, isPrivateGrant } from '@/lib/page-grant';
import { m } from '@paraglide/messages.js';
import { Compass, Link2, Loader2, Lock, MessageSquare, MoreHorizontal, RotateCcw, ThumbsUp, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { UserAvatar } from '@/components/user-avatar';
import { SearchHitSnippet } from '@/components/search/search-hit-snippet';
import { formatDistanceToNow } from '@/lib/date-utils';
import { resolveDisplayUser } from '@/lib/page-display-user';
import { pageDisplayName, pageDisplayParent, pagePathToHref } from '@/lib/page-path';
import { useDeletePage, useRevertDeletedPage } from '@/lib/use-page-mutations';
import { cn } from '@/lib/utils';

export type PageListVariant = 'default' | 'trash';

interface PageListItemProps {
  page: Page;
  variant?: PageListVariant;
  /**
   * Sanitised search-result excerpt, rendered as an extra line below the
   * directory/author/time line. Only search passes this — every other
   * list (`PageList` / `UserRecentPages` / `UserBookmarks`) has no
   * per-row snippet, so the row keeps its plain two-line layout there.
   */
  snippet?: string;
}

/**
 * One row in the page list. Title-forward, two-line layout:
 *
 *   ◍  basename                                   ♡3  💬2
 *      /parent/dir/ · author · 3 days ago
 *
 * The basename is the scannable hero; the muted directory prefix +
 * author + timestamp sit on a quieter second line. Reaction counts
 * (like / comment) hug the right edge so they form a tidy column down
 * the list. The whole row is one link / hit-target.
 */
export function PageListItem({ page, variant = 'default', snippet }: PageListItemProps) {
  const isTrash = variant === 'trash';

  const rowClass = 'group flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/50';

  // Trash rows are not links — the path is dead and the row hosts a
  // restore / delete-forever menu instead.
  if (isTrash) {
    return (
      <div className={rowClass}>
        <PageRowBody page={page} isTrash snippet={snippet} />
        <TrashItemActions pageId={page._id} pagePath={page.path} />
      </div>
    );
  }

  return (
    <Link href={pagePathToHref(page.path)} className={cn(rowClass, 'focus-visible:bg-accent/50 focus-visible:outline-none')}>
      <PageRowBody page={page} snippet={snippet} />
    </Link>
  );
}

function PageRowBody({ page, isTrash = false, snippet }: { page: Page; isTrash?: boolean; snippet?: string }) {
  // Populated user fields may arrive as bare ObjectId strings; only the
  // object form carries a name / avatar. `resolveDisplayUser` also falls
  // back to the revision author (last resort) — see its doc comment.
  const displayUser = resolveDisplayUser(page);
  // Preserve the legacy '?' placeholder for populated-but-empty users
  // (e.g. legacy rows where both `name` and `username` are blank): a stray
  // empty author column would otherwise misalign neighbouring rows.
  const displayName = displayUser ? displayUser.name || displayUser.username || '?' : null;

  const isPortal = page.path.endsWith('/');
  // RESTRICTED = "anyone with the link can view"; SPECIFIED / OWNER =
  // limited to listed users / the owner. Separating the two visually
  // matters because the privacy implications differ: a link-only page
  // is sharable, a private page is not.
  const isLinkOnly = isLinkOnlyGrant(page.grant);
  const isPrivate = isPrivateGrant(page.grant);
  // Drafts only surface in the listing for the creator themselves
  // (RFC-0004 visibility), so showing the badge to whoever sees the row
  // is safe and signals "this is mine and not yet public".
  const isDraft = page.status === PageStatusEnum.DRAFT;

  // `pageDisplayName` collapses a trailing date hierarchy (e.g. `/2026/05/23`)
  // into a single readable title — so a daily-note page shows "2026/05/23"
  // rather than just "23" while its sibling on `parentPath` stays short.
  const basename = pageDisplayName(page.path) || page.path;
  const parentPath = pageDisplayParent(page.path);
  // A standalone '/' on line 2 is visual noise — the title already
  // conveys the full path (e.g. root-level dailies '/2026/05/23'), so
  // hide the parent slot entirely in that case.
  const showParent = parentPath !== '/';

  const likeCount = page.likerCount ?? page.liker?.length ?? 0;
  const commentCount = page.commentCount ?? 0;
  const hasReactions = likeCount > 0 || commentCount > 0;
  const updatedAt = page.updatedAt || page.createdAt;

  return (
    <>
      {displayUser ? <UserAvatar user={displayUser} size="md" className="shrink-0" /> : <div className="h-8 w-8 shrink-0 rounded-full bg-muted" aria-hidden />}

      <div className="min-w-0 flex-1">
        {/* Line 1 — title + flags, reactions pinned right */}
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'truncate text-[15px] font-semibold leading-snug',
              isTrash ? 'text-foreground' : 'text-foreground transition-colors group-hover:text-primary',
            )}
            title={page.path}
          >
            {basename}
          </span>
          {isPortal && <Compass className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Portal page" />}
          {isLinkOnly && <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Link-only sharing" />}
          {isPrivate && <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Private page" />}
          {isDraft && (
            <span className="inline-flex shrink-0 items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              {m['page_list.draft_badge']()}
            </span>
          )}
          {isTrash && (
            <span className="inline-flex shrink-0 items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
              {m['page_list.deleted_badge']()}
            </span>
          )}

          {hasReactions && (
            <div className="ml-auto flex shrink-0 items-center gap-3 pl-2 text-xs text-muted-foreground tabular-nums">
              {likeCount > 0 && (
                <span className="flex items-center gap-1">
                  <ThumbsUp className="h-3.5 w-3.5" />
                  {likeCount}
                </span>
              )}
              {commentCount > 0 && (
                <span className="flex items-center gap-1">
                  <MessageSquare className="h-3.5 w-3.5" />
                  {commentCount}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Line 2 — muted directory prefix · author · relative time */}
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          {showParent && <span className="truncate font-mono">{parentPath}</span>}
          {displayName && (
            <>
              {showParent && <Dot />}
              <span className="shrink-0">{displayName}</span>
            </>
          )}
          {(showParent || displayName) && <Dot />}
          <time dateTime={updatedAt} className="shrink-0">
            {formatDistanceToNow(updatedAt)}
          </time>
        </div>

        {/* Line 3 (search results only) — sanitised match excerpt */}
        {snippet && <SearchHitSnippet snippet={snippet} />}
      </div>
    </>
  );
}

function Dot() {
  return (
    <span aria-hidden className="shrink-0 text-border">
      ·
    </span>
  );
}

interface TrashItemActionsProps {
  pageId: string;
  pagePath: string;
}

type ConfirmKind = 'restore' | 'delete-forever';

const CONFIRM_COPY: Record<
  ConfirmKind,
  { title: () => string; description: (path: string) => string; confirmLabel: () => string; buttonVariant: 'default' | 'destructive' }
> = {
  restore: {
    title: () => m['page_list.confirm_restore_title'](),
    description: (path) => m['page_list.confirm_restore_description']({ path }),
    confirmLabel: () => m['page_list.confirm_restore_button'](),
    buttonVariant: 'default',
  },
  'delete-forever': {
    title: () => m['page_list.confirm_delete_forever_title'](),
    description: (path) => m['page_list.confirm_delete_forever_description']({ path }),
    confirmLabel: () => m['page_list.confirm_delete_forever_button'](),
    buttonVariant: 'destructive',
  },
};

function TrashItemActions({ pageId, pagePath }: TrashItemActionsProps) {
  const [confirmKind, setConfirmKind] = useState<ConfirmKind | null>(null);
  const revert = useRevertDeletedPage();
  const remove = useDeletePage();

  const isPending = revert.isPending || remove.isPending;
  const error = revert.error ?? remove.error;
  const errorMessage = error instanceof Error ? error.message : null;
  const copy = confirmKind ? CONFIRM_COPY[confirmKind] : null;

  const closeDialog = () => {
    if (isPending) return;
    setConfirmKind(null);
    revert.reset();
    remove.reset();
  };

  const handleConfirm = () => {
    if (confirmKind === 'restore') {
      revert.mutate({ page_id: pageId }, { onSuccess: () => setConfirmKind(null) });
    } else if (confirmKind === 'delete-forever') {
      remove.mutate({ page_id: pageId, completely: true }, { onSuccess: () => setConfirmKind(null) });
    }
  };

  return (
    <div className="shrink-0">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={m['page_list.actions_aria']()}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setConfirmKind('restore')}>
            <RotateCcw className="h-4 w-4 mr-2" />
            {m['page_list.action_restore']()}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setConfirmKind('delete-forever')} className="text-red-600 focus:text-red-600">
            <Trash2 className="h-4 w-4 mr-2" />
            {m['page_list.action_delete_forever']()}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={confirmKind !== null} onOpenChange={(next) => !next && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy?.title()}</DialogTitle>
            <DialogDescription>{copy?.description(pagePath)}</DialogDescription>
          </DialogHeader>

          {errorMessage && (
            <p className="text-sm text-destructive" role="alert">
              {errorMessage}
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={isPending}>
              {m['common.cancel']()}
            </Button>
            <Button variant={copy?.buttonVariant ?? 'default'} onClick={handleConfirm} disabled={isPending}>
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  {m['page_list.confirm_in_progress']()}
                </>
              ) : (
                copy?.confirmLabel()
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
