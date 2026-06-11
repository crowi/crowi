'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellOff, Bookmark, ClipboardCopy, History, Link2, MoreHorizontal, MoveRight, ThumbsUp, Trash2 } from 'lucide-react';
import type { PageWithRevision } from '@crowi/api-contract';
import { PageStatusEnum } from '@crowi/api-contract';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { notify } from '@/lib/notify';
import { isUserHomePath } from '@/lib/page-path';
import { useToggleBookmark } from '@/lib/use-bookmark';
import { useToggleLike } from '@/lib/use-like';
import { useToggleWatch } from '@/lib/use-watch';
import { m } from '@paraglide/messages.js';
import { DeletePageDialog } from './delete-page-dialog';
import { RenameDialog } from './rename-dialog';

interface PageActionsMenuProps {
  page: PageWithRevision;
  /**
   * Compact mode (sticky header): watch / bookmark / copy-link — which
   * are standalone icon buttons in the expanded header — fold into this
   * dropdown as menu items so the pinned header stays narrow.
   */
  compact?: boolean;
  /** Whether the current user can use the authenticated-only actions (watch). */
  isAuthenticated?: boolean;
  /**
   * Portal mode: fold the social actions (like / watch / copy-link) in as
   * menu items so the portal header stays minimal. Unlike `compact`,
   * bookmark is NOT folded in — the portal keeps it as a visible button —
   * and `like` IS folded in (a portal has no separate like button).
   */
  foldSocial?: boolean;
  /** Current like state, used only by the `foldSocial` like menu item. */
  isLiked?: boolean;
}

export function PageActionsMenu({ page, compact = false, isAuthenticated = false, foldSocial = false, isLiked = false }: PageActionsMenuProps) {
  const router = useRouter();
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  // Drafts hide the social affordances (watch / bookmark / copy-link)
  // that the compact dropdown otherwise folds in. The page-level
  // history / rename / delete actions still apply to the draft.
  const isDraft = page.status === PageStatusEnum.DRAFT;
  // A user's home page (`/user/<username>`) is bound to the username, so it
  // can't be renamed — the server rejects it too (`isRenamableName`).
  const canRename = !isUserHomePath(page.path);

  const handleCopyMarkdown = () => {
    const body = page.revision?.body ?? '';
    void navigator.clipboard
      ?.writeText(body)
      .then(() => notify.info(m['page.markdown_copied']()))
      .catch(() => notify.error(m['page.markdown_copy_failed']()));
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={m['page.action_more']()} className="text-muted-foreground hover:text-foreground">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* Compact sticky header: fold watch / bookmark / copy-link in
              (like stays a separate icon button up in the bar). */}
          {compact && !isDraft && (
            <>
              {isAuthenticated && <WatchMenuItem pageId={page._id} />}
              <BookmarkMenuItem pageId={page._id} />
              <CopyLinkMenuItem pageId={page._id} />
              <DropdownMenuSeparator />
            </>
          )}
          {/* Portal: fold like / watch / copy-link in — bookmark stays a
              visible button in the portal header, so it is not folded. */}
          {foldSocial && !isDraft && (
            <>
              {isAuthenticated && <LikeMenuItem pageId={page._id} isLiked={isLiked} />}
              {isAuthenticated && <WatchMenuItem pageId={page._id} />}
              <CopyLinkMenuItem pageId={page._id} />
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={() => router.push(`/_history?path=${encodeURIComponent(page.path)}`)}>
            <History className="h-4 w-4 mr-2" />
            {m['page.action_history']()}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleCopyMarkdown}>
            <ClipboardCopy className="h-4 w-4 mr-2" />
            {m['page.action_copy_markdown']()}
          </DropdownMenuItem>
          {canRename && (
            <DropdownMenuItem onSelect={() => setIsRenameOpen(true)}>
              <MoveRight className="h-4 w-4 mr-2" />
              {m['page.action_rename']()}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setIsDeleteOpen(true)} className="text-red-600 focus:text-red-600">
            <Trash2 className="h-4 w-4 mr-2" />
            {m['page.action_delete']()}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {canRename && <RenameDialog page={page} open={isRenameOpen} onOpenChange={setIsRenameOpen} />}
      <DeletePageDialog pageId={page._id} pagePath={page.path} revisionId={page.revision?._id} open={isDeleteOpen} onOpenChange={setIsDeleteOpen} />
    </>
  );
}

/** Like toggle as a dropdown item (portal header `foldSocial`). */
function LikeMenuItem({ pageId, isLiked }: { pageId: string; isLiked: boolean }) {
  const { toggle } = useToggleLike(pageId, isLiked);
  return (
    <DropdownMenuItem
      onSelect={(e) => {
        e.preventDefault();
        toggle();
      }}
    >
      <ThumbsUp className={`h-4 w-4 mr-2 ${isLiked ? 'fill-current' : ''}`} />
      {isLiked ? m['page.like_label_done']() : m['page.like_label']()}
    </DropdownMenuItem>
  );
}

/** Watch toggle as a dropdown item (compact header). */
function WatchMenuItem({ pageId }: { pageId: string }) {
  const { watching, toggle } = useToggleWatch(pageId);
  const Icon = watching ? Bell : BellOff;
  // Keep the dropdown open on toggle so the state change is visible.
  return (
    <DropdownMenuItem
      onSelect={(e) => {
        e.preventDefault();
        toggle();
      }}
    >
      <Icon className={`h-4 w-4 mr-2 ${watching ? 'fill-current' : ''}`} />
      {watching ? m['page.watch_label_done']() : m['page.watch_label']()}
    </DropdownMenuItem>
  );
}

/** Bookmark toggle as a dropdown item (compact header). */
function BookmarkMenuItem({ pageId }: { pageId: string }) {
  const { isBookmarked, toggle } = useToggleBookmark(pageId);
  return (
    <DropdownMenuItem
      onSelect={(e) => {
        e.preventDefault();
        toggle();
      }}
    >
      <Bookmark className={`h-4 w-4 mr-2 ${isBookmarked ? 'fill-current' : ''}`} />
      {isBookmarked ? m['page.bookmark_label_done']() : m['page.bookmark_label']()}
    </DropdownMenuItem>
  );
}

/** Copy page URL to the clipboard from a dropdown item (compact header). */
function CopyLinkMenuItem({ pageId }: { pageId: string }) {
  const handleCopy = () => {
    if (typeof window === 'undefined') return;
    void navigator.clipboard?.writeText(`${window.location.origin}/${pageId}`).catch(() => {
      // clipboard unavailable (insecure context / denied) — silently ignore.
    });
  };
  return (
    <DropdownMenuItem onSelect={handleCopy}>
      <Link2 className="h-4 w-4 mr-2" />
      {m['page.share.link_label']()}
    </DropdownMenuItem>
  );
}
