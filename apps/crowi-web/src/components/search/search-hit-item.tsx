'use client';

import { memo } from 'react';
import Link from 'next/link';
import { Bookmark, FileText, Lock } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import type { SearchHit } from '@crowi/api-contract';
import { PageGrantEnum } from '@crowi/api-contract';
import { formatDistanceToNow } from '@/lib/date-utils';
import { SearchHitSnippet } from './search-hit-snippet';

interface SearchHitItemProps {
  hit: SearchHit;
}

export const SearchHitItem = memo(function SearchHitItem({ hit }: SearchHitItemProps) {
  const page = hit.page;
  const creator = typeof page.creator === 'object' && page.creator ? page.creator : null;
  const lastUpdateUser = typeof page.lastUpdateUser === 'object' && page.lastUpdateUser ? page.lastUpdateUser : null;
  const displayUser = lastUpdateUser || creator;
  const displayName = displayUser?.name || displayUser?.username || '?';

  const isPortal = page.path.endsWith('/');
  const isPrivate = page.grant === PageGrantEnum.OWNER || page.grant === PageGrantEnum.SPECIFIED;

  return (
    <div className="flex items-start gap-4 p-4 hover:bg-accent/50 transition-colors rounded-lg border-b last:border-0">
      {displayUser && (
        <Avatar className="h-10 w-10 flex-shrink-0">
          <AvatarImage src={displayUser.image || undefined} alt={displayName} />
          <AvatarFallback className="bg-primary/10 text-primary">{displayName.charAt(0).toUpperCase()}</AvatarFallback>
        </Avatar>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <Link href={page.path} className="font-medium text-foreground hover:text-primary transition-colors truncate">
            {page.path}
          </Link>
          {isPortal && <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" aria-label="Portal page" />}
          {isPrivate && <Lock className="h-4 w-4 text-muted-foreground flex-shrink-0" aria-label="Private page" />}
        </div>

        {hit.snippet && <SearchHitSnippet snippet={hit.snippet} />}

        {displayUser && (
          <div className="text-sm text-muted-foreground mt-2">
            <span className="font-medium">{displayName}</span>
            {' · '}
            <time dateTime={page.updatedAt || page.createdAt}>{formatDistanceToNow(page.updatedAt || page.createdAt)}</time>
          </div>
        )}

        {hit.bookmarkCount > 0 && (
          <div className="flex items-center gap-1 mt-2 text-sm text-muted-foreground">
            <Bookmark className="h-4 w-4" />
            <span>{hit.bookmarkCount}</span>
          </div>
        )}
      </div>
    </div>
  );
});
