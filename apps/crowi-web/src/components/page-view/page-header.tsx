'use client';

import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from '@/lib/date-utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Breadcrumb } from '@/components/breadcrumb';
import { Clock, Lock, Edit2, History } from 'lucide-react';
import type { PageWithRevision } from '@crowi/api-contract';
import { PageGrantEnum } from '@crowi/api-contract';
import { useAuth } from '@/lib/use-auth';
import { BookmarkButton } from './bookmark-button';
import { LikeButton } from './like-button';
import { PageActionsMenu } from './page-actions-menu';
import { SeenUserList } from './seen-user-list';
import { WatchButton } from './watch-button';

interface PageHeaderProps {
  page: PageWithRevision;
  onEdit?: () => void;
  showActions?: boolean;
  showSeenUsers?: boolean;
}

function buildHistoryHref(pagePath: string): string {
  return `/_history?path=${encodeURIComponent(pagePath)}`;
}

function getPageTitle(path: string): string {
  if (path === '/') return 'Home';
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] || 'Untitled';
}

export function PageHeader({ page, onEdit, showActions = false, showSeenUsers = true }: PageHeaderProps) {
  const router = useRouter();
  const { user, isAuthenticated } = useAuth();
  const creator = typeof page.creator === 'object' && page.creator ? page.creator : null;
  const lastUpdateUser = typeof page.lastUpdateUser === 'object' && page.lastUpdateUser ? page.lastUpdateUser : null;
  const author = page.revision?.author ?? null;
  const isLiked = isAuthenticated && !!user && (page.liker ?? []).includes(user.id);
  const displayUser = lastUpdateUser ?? creator ?? author;
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
          <Button variant="ghost" size="sm" onClick={() => router.push(buildHistoryHref(page.path))} aria-label="View revision history" title="History">
            <History className="h-4 w-4" />
          </Button>
          {onEdit && (
            <Button variant="default" size="sm" onClick={onEdit} className="ml-1">
              <Edit2 className="h-4 w-4 mr-1" />
              Edit
            </Button>
          )}
          {showActions && <PageActionsMenu page={page} />}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <h1 className="text-3xl md:text-[2.5rem] font-bold tracking-tight leading-[1.15] text-foreground">{pageTitle}</h1>
        {isPrivate && <Lock className="h-5 w-5 text-muted-foreground shrink-0" aria-label="Private page" />}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
        {displayUser && (
          <div className="flex items-center gap-2">
            <Avatar className="h-5 w-5">
              <AvatarImage src={displayUser.image || undefined} alt={displayUser.name} />
              <AvatarFallback className="bg-primary/10 text-primary text-[10px]">{displayUser.name.charAt(0).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="text-foreground/80">{displayUser.name}</span>
          </div>
        )}

        {page.updatedAt && (
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" />
            Updated {formatDistanceToNow(page.updatedAt)}
          </span>
        )}

        {page.likerCount !== undefined && page.likerCount > 0 && <span>{page.likerCount} likes</span>}
        {page.seenUsersCount !== undefined && page.seenUsersCount > 0 && <span>{page.seenUsersCount} views</span>}
      </div>

      {showSeenUsers && <SeenUserList pageId={page._id} fallbackCount={page.seenUsersCount} />}
    </header>
  );
}
