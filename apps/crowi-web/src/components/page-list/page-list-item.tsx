'use client';

import Link from 'next/link';
import { MessageSquare, ThumbsUp, Lock, FileText } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import type { Page } from '@crowi/api-contract';
import { PageGrantEnum } from '@crowi/api-contract';

interface PageListItemProps {
  page: Page;
}

export function PageListItem({ page }: PageListItemProps) {
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

  // Format date
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

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
          <Link href={page.path} className="font-medium text-foreground hover:text-primary transition-colors truncate">
            {page.path}
          </Link>
          {isPortal && <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" aria-label="Portal page" />}
          {isPrivate && <Lock className="h-4 w-4 text-muted-foreground flex-shrink-0" aria-label="Private page" />}
        </div>

        {/* User and date info */}
        {displayUser && (
          <div className="text-sm text-muted-foreground">
            <span className="font-medium">{displayName}</span>
            {' · '}
            <time dateTime={page.updatedAt || page.createdAt}>{formatDate(page.updatedAt || page.createdAt)}</time>
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
    </div>
  );
}
