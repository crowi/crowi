'use client';

import Link from 'next/link';
import { FileText, Lock } from 'lucide-react';
import type { Page, SearchHit } from '@crowi/api-contract';
import { PageGrantEnum } from '@crowi/api-contract';
import { SearchHitSnippet } from './search-hit-snippet';

interface SearchSuggestionItemProps {
  /** Path to navigate to. Page paths render via the existing slug route. */
  href: string;
  page: Page | SearchHit['page'];
  /** Optional snippet (search hits only). When present, rendered below the path. */
  snippet?: string;
  /** Click handler — used by the dropdown to close itself before navigation. */
  onClick?: () => void;
}

/**
 * Compact one-line entry used inside the global search dropdown — both
 * for recently-viewed pages (no snippet) and inline search results
 * (snippet shown). Trades the rich `SearchHitItem` (avatar + meta row +
 * full snippet) for a denser layout: the dropdown tops out around 5
 * recents or 5 hits, and a row that scrolls is more useful than a row
 * that summarizes.
 *
 * The portal indicator (FileText) and the private indicator (Lock) are
 * the same iconography as `SearchHitItem` so users carry the same
 * visual vocabulary between the two views.
 */
export function SearchSuggestionItem({ href, page, snippet, onClick }: SearchSuggestionItemProps) {
  const isPortal = page.path.endsWith('/');
  const isPrivate = page.grant === PageGrantEnum.OWNER || page.grant === PageGrantEnum.SPECIFIED;

  return (
    <Link href={href} onClick={onClick} className="block rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors">
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-medium text-foreground truncate">{page.path}</span>
        {isPortal && <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-label="Portal page" />}
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
