'use client';

import { useState } from 'react';
import Link from 'next/link';
import { MessageSquare, ThumbsUp, Lock, FileText, MoreHorizontal, RotateCcw, Trash2, Loader2 } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useDeletePage, useRevertDeletedPage } from '@/lib/use-page-mutations';
import { formatRelativeDate } from '@/lib/format-relative-date';
import { m } from '@paraglide/messages.js';
import type { Page } from '@crowi/api-contract';
import { PageGrantEnum } from '@crowi/api-contract';

export type PageListVariant = 'default' | 'trash';

interface PageListItemProps {
  page: Page;
  variant?: PageListVariant;
}

export function PageListItem({ page, variant = 'default' }: PageListItemProps) {
  // Extract user data from populated fields
  const creator = typeof page.creator === 'object' && page.creator ? page.creator : null;
  const lastUpdateUser = typeof page.lastUpdateUser === 'object' && page.lastUpdateUser ? page.lastUpdateUser : null;

  // Determine the display user (prefer lastUpdateUser, fallback to creator)
  const displayUser = lastUpdateUser || creator;

  // Get display name with fallback to username or default
  const displayName = displayUser?.name || displayUser?.username || '?';

  // Check if page is a portal page (ends with /)
  const isPortal = page.path.endsWith('/');

  // Check if page is private
  const isPrivate = page.grant === PageGrantEnum.OWNER || page.grant === PageGrantEnum.SPECIFIED;

  const isTrash = variant === 'trash';

  return (
    <div className="flex items-start gap-4 p-4 hover:bg-accent/50 transition-colors rounded-lg border-b last:border-0">
      {/* User Avatar */}
      {displayUser && (
        <Avatar className="h-10 w-10 flex-shrink-0">
          <AvatarImage src={displayUser.image || undefined} alt={displayName} />
          <AvatarFallback className="bg-primary/10 text-primary">{displayName.charAt(0).toUpperCase()}</AvatarFallback>
        </Avatar>
      )}

      {/* Page Info */}
      <div className="flex-1 min-w-0">
        {/* Page path and icons */}
        <div className="flex items-center gap-2 mb-1">
          {isTrash ? (
            <span className="font-medium text-foreground truncate" title={page.path}>
              {page.path}
            </span>
          ) : (
            <Link href={page.path} className="font-medium text-foreground hover:text-primary transition-colors truncate">
              {page.path}
            </Link>
          )}
          {isPortal && <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" aria-label="Portal page" />}
          {isPrivate && <Lock className="h-4 w-4 text-muted-foreground flex-shrink-0" aria-label="Private page" />}
          {isTrash && (
            <span className="inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive flex-shrink-0">
              {m['page_list.deleted_badge']()}
            </span>
          )}
        </div>

        {/* User and date info */}
        {displayUser && (
          <div className="text-sm text-muted-foreground">
            <span className="font-medium">{displayName}</span>
            {' · '}
            <time dateTime={page.updatedAt || page.createdAt}>{formatRelativeDate(page.updatedAt || page.createdAt)}</time>
          </div>
        )}

        {/* Metadata (comments, likes) */}
        <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
          {page.commentCount > 0 && (
            <div className="flex items-center gap-1">
              <MessageSquare className="h-4 w-4" />
              <span>{page.commentCount}</span>
            </div>
          )}
          {(page.likerCount ?? page.liker?.length ?? 0) > 0 && (
            <div className="flex items-center gap-1">
              <ThumbsUp className="h-4 w-4" />
              <span>{page.likerCount ?? page.liker?.length ?? 0}</span>
            </div>
          )}
        </div>
      </div>

      {isTrash && <TrashItemActions pageId={page._id} pagePath={page.path} />}
    </div>
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
    <div className="flex-shrink-0">
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
