'use client';

import { Button } from '@/components/ui/button';
import { Breadcrumb } from '@/components/breadcrumb';
import { Lock, Edit2 } from 'lucide-react';
import type { PageWithRevision } from '@crowi/api-contract';
import { PageGrantEnum } from '@crowi/api-contract';
import { useAuth } from '@/lib/use-auth';
import { useStickyHeader } from '@/lib/use-sticky-header';
import { cn } from '@/lib/utils';
import { m } from '@paraglide/messages.js';
import { BookmarkButton } from './bookmark-button';
import { LikeButton } from './like-button';
import { LinkSharePopover } from './link-share-popover';
import { LivePresenceRow } from './live-presence-row';
import { MetaChipRow } from './meta-chip-row';
import { PageActionsMenu } from './page-actions-menu';
import { WatchButton } from './watch-button';

interface PageHeaderProps {
  page: PageWithRevision;
  onEdit?: () => void;
  showActions?: boolean;
  /**
   * `false` hides the restructured meta-chip row (author / timestamp /
   * like / view / comment / backlink chips). Used by /user/<username>
   * covers where the chips would be noise.
   */
  showMeta?: boolean;
  /**
   * `false` hides the H1 title row (used by /user/<username>: the
   * cover above already names the user, and the page title would
   * just echo the URL basename).
   */
  showTitle?: boolean;
  /**
   * RFC-0005 live presence row above the title. Defaults on for the
   * live page view; callers rendering a stale revision / deleted page
   * / user cover pass `false` — presence is only meaningful for the
   * page someone is actually reading right now.
   */
  showPresence?: boolean;
  /**
   * `false` opts out of the sticky / compact behaviour — the header
   * renders inline in its expanded form. Used by the deleted-page and
   * user-cover hosts where pinning a header makes no sense.
   */
  sticky?: boolean;
}

function getPageTitle(path: string): string {
  if (path === '/') return 'Home';
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] || 'Untitled';
}

export function PageHeader({ page, onEdit, showActions = false, showMeta = true, showTitle = true, showPresence = false, sticky = false }: PageHeaderProps) {
  const { user, isAuthenticated } = useAuth();
  const { sentinelRef, compact: scrolled } = useStickyHeader();
  const isLiked = isAuthenticated && !!user && (page.liker ?? []).includes(user.id);
  const isPrivate = page.grant === PageGrantEnum.OWNER || page.grant === PageGrantEnum.SPECIFIED;
  const pageTitle = getPageTitle(page.path);

  // Compact only when the header is both sticky-enabled and scrolled past.
  const compact = sticky && scrolled;

  const editButton = onEdit && (
    <Button variant="ghost" size="sm" onClick={onEdit} className="shrink-0 text-muted-foreground hover:text-foreground">
      <Edit2 className="h-4 w-4 mr-1" />
      {m['page.action_edit']()}
    </Button>
  );

  const editIconButton = onEdit && (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onEdit}
      aria-label={m['page.action_edit']()}
      title={m['page.action_edit']()}
      className="shrink-0 text-muted-foreground hover:text-foreground"
    >
      <Edit2 className="h-4 w-4" />
    </Button>
  );

  return (
    <>
      {/* Zero-height sentinel observed by useStickyHeader: while it is
          visible the page is at the top (expanded); once it scrolls out
          of the viewport the pinned header switches to compact. */}
      {sticky && <div ref={sentinelRef} aria-hidden="true" className="h-0" data-testid="sticky-header-sentinel" />}

      <header className={cn(sticky && 'sticky top-0 z-30 bg-background', compact ? 'space-y-2 py-2' : 'space-y-5')} data-compact={compact}>
        {compact ? (
          /* Compact: path-tail title + icon-only like / edit + dotmenu.
             Breadcrumb and the meta-chip row are dropped; watch /
             bookmark / link fold into the dotmenu. */
          <>
            <div className="flex items-center gap-2">
              <h1 className="text-base md:text-lg font-semibold tracking-tight text-foreground flex-1 min-w-0 truncate">{pageTitle}</h1>
              {isPrivate && <Lock className="h-4 w-4 text-muted-foreground shrink-0" aria-label="Private page" />}
              <div className="flex items-center gap-1 shrink-0">
                {isAuthenticated && <LikeButton pageId={page._id} isLiked={isLiked} iconOnly />}
                {editIconButton}
                {showActions && <PageActionsMenu page={page} compact isAuthenticated={isAuthenticated} />}
              </div>
            </div>
            {showPresence && isAuthenticated && <LivePresenceRow pageId={page._id} size="compact" />}
          </>
        ) : (
          <>
            {/* Breadcrumb + action buttons. On mobile they stack vertically —
                side by side they overflow the viewport (the action group is
                `shrink-0`); from `md` up they share one row. */}
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-4 min-h-9">
              <Breadcrumb path={page.path} />

              <div className="flex items-center gap-1 shrink-0">
                {isAuthenticated && <LikeButton pageId={page._id} isLiked={isLiked} />}
                {/* watch / bookmark / link are hidden on mobile in the
                    expanded header — they fold into the dotmenu instead. */}
                {isAuthenticated && (
                  <span className="hidden md:inline-flex">
                    <WatchButton pageId={page._id} />
                  </span>
                )}
                <span className="hidden md:inline-flex">
                  <BookmarkButton pageId={page._id} />
                </span>
                <span className="hidden md:inline-flex">
                  <LinkSharePopover page={page} />
                </span>
                {showActions && (
                  <>
                    <span className="md:hidden">
                      <PageActionsMenu page={page} compact isAuthenticated={isAuthenticated} />
                    </span>
                    <span className="hidden md:inline-flex">
                      <PageActionsMenu page={page} isAuthenticated={isAuthenticated} />
                    </span>
                  </>
                )}
              </div>
            </div>

            {showPresence && isAuthenticated && <LivePresenceRow pageId={page._id} />}

            {showTitle ? (
              <div className="flex items-center gap-3">
                <h1 className="text-3xl md:text-[2.5rem] font-bold tracking-tight leading-[1.15] text-foreground flex-1 min-w-0">{pageTitle}</h1>
                {isPrivate && <Lock className="h-5 w-5 text-muted-foreground shrink-0" aria-label="Private page" />}
                {editButton}
              </div>
            ) : (
              (isPrivate || onEdit) && (
                <div className="flex items-center justify-end gap-3">
                  {isPrivate && <Lock className="h-5 w-5 text-muted-foreground shrink-0" aria-label="Private page" />}
                  {editButton}
                </div>
              )
            )}

            {showMeta && <MetaChipRow page={page} />}
          </>
        )}
      </header>
    </>
  );
}
