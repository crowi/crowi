'use client';

import { memo } from 'react';
import Link from 'next/link';
import { Bookmark, FileText, Lock } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import type { SearchHit } from '@crowi/api-contract';
import { PageGrantEnum } from '@crowi/api-contract';
import { formatRelativeDate } from '@/lib/format-relative-date';
import { SearchHitSnippet } from './search-hit-snippet';

interface SearchHitItemProps {
  hit: SearchHit;
}

/**
 * One row in the search results list. Mirrors the layout of `PageListItem`
 * (avatar / path / metadata) but adds a snippet line below the path when the
 * driver returned highlights.
 *
 * We don't reuse `PageListItem` directly because the search shape carries
 * `bookmarkCount` and `snippet` next to (not inside) the `Page`, and the
 * snippet rendering needs the dedicated `SearchHitSnippet` sanitiser.
 *
 * `memo`-wrapped because this row re-renders cheaply for the parent list but
 * each instance does multiple type-narrowings + a memoised sanitise pass; the
 * `hit` prop is referentially stable across re-renders that don't change the
 * page (react-query keeps result objects identity-stable until invalidation).
 */
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
            <time dateTime={page.updatedAt || page.createdAt}>{formatRelativeDate(page.updatedAt || page.createdAt)}</time>
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
