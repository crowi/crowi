'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Clock, Search } from 'lucide-react';
import { useSearchPages } from '@/lib/use-search';
import { useRecentlyViewedPages } from '@/lib/use-recently-viewed';
import { useSearchFocus } from '@/lib/search-focus-context';
import { pagePathToHref } from '@/lib/page-path';
import { SearchSuggestionItem } from './search-suggestion-item';
import { m } from '@paraglide/messages.js';

const SUGGESTION_DEBOUNCE_MS = 200;
const SUGGESTION_LIMIT = 5;

const buildSearchUrl = (q: string) => `/_search?q=${encodeURIComponent(q)}`;

export function GlobalSearchInput() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlQ = searchParams.get('q') ?? '';

  const [value, setValue] = useState(urlQ);
  const [isFocused, setIsFocused] = useState(false);
  const [debouncedQ, setDebouncedQ] = useState('');

  // Publish focus state to the header so width-competing siblings (e.g.
  // the confidentiality notice) can yield while the box is expanded.
  const { setSearchFocused } = useSearchFocus();
  useEffect(() => {
    setSearchFocused(isFocused);
  }, [isFocused, setSearchFocused]);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mirror URL → input across navigations (initial useState only fires once).
  useEffect(() => {
    setValue(urlQ);
  }, [urlQ]);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(value.trim()), SUGGESTION_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [value]);

  // Don't pass `limit` — useSearchPages cache key is limit-agnostic, so
  // the dropdown's request shares cache with the /_search page (typing
  // pre-warms the eventual full-page render). Slice to 5 client-side.
  const searchQuery = useSearchPages({ q: debouncedQ });
  const recentsQuery = useRecentlyViewedPages({ enabled: isFocused && debouncedQ.length === 0 });

  // mousedown (not click) so a clicked Link still navigates: setting
  // isFocused=false on click would unmount the Link before its handler runs.
  useEffect(() => {
    if (!isFocused) return;
    const onMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsFocused(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [isFocused]);

  const closeAndBlur = () => {
    setIsFocused(false);
    inputRef.current?.blur();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    router.push(buildSearchUrl(trimmed));
    closeAndBlur();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAndBlur();
    }
  };

  const isTyping = debouncedQ.length > 0;
  const hits = searchQuery.data?.data ?? [];
  const recents = recentsQuery.data?.pages ?? [];

  return (
    <div ref={containerRef} className={`relative ${isFocused ? 'flex-1 max-w-2xl' : 'w-72'} hidden md:block transition-[width,max-width] duration-200`}>
      <form role="search" onSubmit={handleSubmit}>
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          id="global-search-input"
          name="q"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setIsFocused(true)}
          onKeyDown={handleKeyDown}
          placeholder={m['search.global.placeholder']()}
          aria-label={m['search.global.placeholder']()}
          className="h-9 w-full rounded-full border border-input bg-muted/40 pl-10 pr-3 text-sm placeholder:text-muted-foreground outline-none transition-shadow focus:bg-background focus:border-ring focus:ring-ring/50 focus:ring-[3px] focus:shadow-md"
        />
      </form>

      {isFocused && (
        <div className="absolute left-0 right-0 top-full mt-2 max-h-[28rem] overflow-y-auto rounded-2xl border bg-popover text-popover-foreground shadow-lg z-50">
          {isTyping ? (
            <ResultsSection
              isLoading={searchQuery.isLoading}
              isError={searchQuery.isError}
              hits={hits.slice(0, SUGGESTION_LIMIT)}
              total={searchQuery.data?.meta.total ?? 0}
              onItemClick={closeAndBlur}
              onShowAll={() => {
                router.push(buildSearchUrl(debouncedQ));
                closeAndBlur();
              }}
            />
          ) : recents.length > 0 ? (
            <RecentsSection pages={recents} onItemClick={closeAndBlur} />
          ) : recentsQuery.isLoading ? (
            <div className="px-3 py-3 text-sm text-muted-foreground">{m['search.global.loading_recents']()}</div>
          ) : (
            <div className="px-3 py-3 text-sm text-muted-foreground flex items-center gap-2">
              <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {m['search.global.empty_hint']()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ResultsSectionProps {
  isLoading: boolean;
  isError: boolean;
  hits: NonNullable<ReturnType<typeof useSearchPages>['data']>['data'];
  total: number;
  onItemClick: () => void;
  onShowAll: () => void;
}

function ResultsSection({ isLoading, isError, hits, total, onItemClick, onShowAll }: ResultsSectionProps) {
  if (isError) {
    return <div className="px-3 py-3 text-sm text-muted-foreground">{m['search.global.error']()}</div>;
  }
  if (hits.length === 0) {
    return <div className="px-3 py-3 text-sm text-muted-foreground">{isLoading ? m['search.global.searching']() : m['search.global.no_results']()}</div>;
  }
  return (
    <div className="p-1.5">
      <div className="px-3 py-1 text-xs font-medium text-muted-foreground">{m['search.global.results_heading']({ total: String(total) })}</div>
      <div className="space-y-0.5">
        {hits.map((hit) => (
          <SearchSuggestionItem key={hit.pageId} href={pagePathToHref(hit.path)} page={hit.page} snippet={hit.snippet} onClick={onItemClick} />
        ))}
      </div>
      <button
        type="button"
        onClick={onShowAll}
        className="mt-1 w-full rounded-md px-3 py-2 text-left text-xs font-medium text-primary hover:bg-accent transition-colors"
      >
        {m['search.global.see_all_results']()}
      </button>
    </div>
  );
}

interface RecentsSectionProps {
  pages: NonNullable<ReturnType<typeof useRecentlyViewedPages>['data']>['pages'];
  onItemClick: () => void;
}

function RecentsSection({ pages, onItemClick }: RecentsSectionProps) {
  return (
    <div className="p-1.5">
      <div className="px-3 py-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Clock className="h-3 w-3" aria-hidden="true" />
        {m['search.global.recents_heading']()}
      </div>
      <div className="space-y-0.5">
        {pages.map((page) => (
          <SearchSuggestionItem key={page._id} href={pagePathToHref(page.path)} page={page} onClick={onItemClick} />
        ))}
      </div>
    </div>
  );
}
