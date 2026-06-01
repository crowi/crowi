'use client';

import Link from 'next/link';
import { Compass, Lock } from 'lucide-react';
import type { Page } from '@crowi/api-contract';
import { isPrivateGrant } from '@/lib/page-grant';
import { SearchHitSnippet } from './search-hit-snippet';

interface SearchSuggestionItemProps {
  href: string;
  page: Page;
  snippet?: string;
  onClick?: () => void;
}

/**
 * Compact one-line entry used inside the global search dropdown — for
 * both recently-viewed pages (no snippet) and inline search results
 * (snippet rendered below the path). The portal / private icons match
 * `SearchHitItem` so the dropdown and the full results page share the
 * same visual vocabulary.
 */
export function SearchSuggestionItem({ href, page, snippet, onClick }: SearchSuggestionItemProps) {
  const isPortal = page.path.endsWith('/');
  const isPrivate = isPrivateGrant(page.grant);

  return (
    <Link href={href} onClick={onClick} className="block rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors">
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-medium text-foreground truncate">{page.path}</span>
        {isPortal && <Compass className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-label="Portal page" />}
        {isPrivate && <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-label="Private page" />}
      </div>
      {snippet && (
        <div className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
          <SearchHitSnippet snippet={snippet} />
        </div>
      )}
    </Link>
  );
}
