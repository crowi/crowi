'use client';

import { Button } from '@/components/ui/button';
import { Breadcrumb } from '@/components/breadcrumb';
import { Lock, Edit2 } from 'lucide-react';
import type { PageWithRevision } from '@crowi/api-contract';
import { PageGrantEnum } from '@crowi/api-contract';
import { useAuth } from '@/lib/use-auth';
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
}

function getPageTitle(path: string): string {
  if (path === '/') return 'Home';
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] || 'Untitled';
}

export function PageHeader({ page, onEdit, showActions = false, showMeta = true, showTitle = true, showPresence = false }: PageHeaderProps) {
  const { user, isAuthenticated } = useAuth();
  const isLiked = isAuthenticated && !!user && (page.liker ?? []).includes(user.id);
  const isPrivate = page.grant === PageGrantEnum.OWNER || page.grant === PageGrantEnum.SPECIFIED;
  const pageTitle = getPageTitle(page.path);

  return (
    <header className="space-y-5">
      <div className="flex items-center justify-between gap-4 min-h-9">
        <Breadcrumb path={page.path} />

        <div className="flex items-center gap-1 shrink-0">
          {isAuthenticated && <LikeButton pageId={page._id} isLiked={isLiked} />}
          {isAuthenticated && <WatchButton pageId={page._id} />}
          <BookmarkButton pageId={page._id} />
          <LinkSharePopover page={page} />
          {showActions && <PageActionsMenu page={page} />}
        </div>
      </div>

      {showPresence && isAuthenticated && <LivePresenceRow pageId={page._id} />}

      {showTitle ? (
        <div className="flex items-center gap-3">
          <h1 className="text-3xl md:text-[2.5rem] font-bold tracking-tight leading-[1.15] text-foreground flex-1 min-w-0">{pageTitle}</h1>
          {isPrivate && <Lock className="h-5 w-5 text-muted-foreground shrink-0" aria-label="Private page" />}
          {onEdit && (
            <Button variant="ghost" size="sm" onClick={onEdit} className="shrink-0 text-muted-foreground hover:text-foreground">
              <Edit2 className="h-4 w-4 mr-1" />
              {m['page.action_edit']()}
            </Button>
          )}
        </div>
      ) : (
        (isPrivate || onEdit) && (
          <div className="flex items-center justify-end gap-3">
            {isPrivate && <Lock className="h-5 w-5 text-muted-foreground shrink-0" aria-label="Private page" />}
            {onEdit && (
              <Button variant="ghost" size="sm" onClick={onEdit} className="shrink-0 text-muted-foreground hover:text-foreground">
                <Edit2 className="h-4 w-4 mr-1" />
                {m['page.action_edit']()}
              </Button>
            )}
          </div>
        )
      )}

      {showMeta && <MetaChipRow page={page} />}
    </header>
  );
}
