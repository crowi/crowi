'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellOff, Bookmark, History, Link2, MoreHorizontal, MoveRight, Trash2 } from 'lucide-react';
import type { PageWithRevision } from '@crowi/api-contract';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useToggleBookmark } from '@/lib/use-bookmark';
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
}

export function PageActionsMenu({ page, compact = false, isAuthenticated = false }: PageActionsMenuProps) {
  const router = useRouter();
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={m['page.action_more']()} className="text-muted-foreground hover:text-foreground">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {compact && (
            <>
              {isAuthenticated && <WatchMenuItem pageId={page._id} />}
              <BookmarkMenuItem pageId={page._id} />
              <CopyLinkMenuItem pageId={page._id} />
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={() => router.push(`/_history?path=${encodeURIComponent(page.path)}`)}>
            <History className="h-4 w-4 mr-2" />
            {m['page.action_history']()}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setIsRenameOpen(true)}>
            <MoveRight className="h-4 w-4 mr-2" />
            {m['page.action_rename']()}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setIsDeleteOpen(true)} className="text-red-600 focus:text-red-600">
            <Trash2 className="h-4 w-4 mr-2" />
            {m['page.action_delete']()}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameDialog page={page} open={isRenameOpen} onOpenChange={setIsRenameOpen} />
      <DeletePageDialog pageId={page._id} pagePath={page.path} revisionId={page.revision?._id} open={isDeleteOpen} onOpenChange={setIsDeleteOpen} />
    </>
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
