'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Clock, Search } from 'lucide-react';
import { useSearchPages } from '@/lib/use-search';
import { useRecentlyViewedPages } from '@/lib/use-recently-viewed';
import { SearchSuggestionItem } from './search-suggestion-item';
import { m } from '@paraglide/messages.js';

const SUGGESTION_DEBOUNCE_MS = 200;
const SUGGESTION_LIMIT = 5;

/**
 * Global search box embedded in the (auth) header, sits right next to
 * the SiteBrand. Behaviours:
 *
 * - **Empty + focused** → dropdown shows "最近見たページ" (server-side
 *   list backed by `crowi.lru` Redis sorted set; soft-fails to empty
 *   array and we hide the section in that case).
 * - **Typing** → debounced inline search. The dropdown lists the top N
 *   hits with snippets; pressing Enter (or clicking "全結果を表示")
 *   navigates to `/_search?q=<encoded>`.
 * - **Enter on empty** → no-op (don't wipe the user's query when they
 *   tab to the box and accidentally hit Enter).
 * - **Click an item** → navigate to that page; close the dropdown.
 * - **Click outside / Escape** → close.
 *
 * The input is **rounded-full** and **expands on focus** (272px → as
 * wide as the parent flex slot allows, capped by max-w-xl). The
 * dropdown is absolute-positioned so it doesn't reflow the header bar.
 *
 * URL `?q` sync: while on `/_search` the header value mirrors the
 * in-page input via `searchParams`. Off `/_search` the URL has no `q`
 * so the box reads as empty, which is what we want (a fresh search
 * starts blank).
 */
export function GlobalSearchInput() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlQ = searchParams.get('q') ?? '';

  const [value, setValue] = useState(urlQ);
  const [isFocused, setIsFocused] = useState(false);
  const [debouncedQ, setDebouncedQ] = useState('');

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the input in sync with the URL across navigations. `useState(urlQ)`
  // only captures the initial value, so without this effect a fresh
  // /_search?q=foo navigation would leave stale text in the box.
  useEffect(() => {
    setValue(urlQ);
  }, [urlQ]);

  // Debounce the user's typing. Search-as-you-type fires only after the
  // input has been still for SUGGESTION_DEBOUNCE_MS — keeps us from
  // hammering ES on every keystroke.
  useEffect(() => {
    const trimmed = value.trim();
    const id = setTimeout(() => setDebouncedQ(trimmed), SUGGESTION_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [value]);

  // Search hook only fires while the dropdown is open + the user has
  // typed something. `enabled` is the gate — we don't want to prefetch
  // when the box isn't visible.
  const isTyping = debouncedQ.length > 0;
  const showDropdown = isFocused;
  const showResults = showDropdown && isTyping;
  const showRecents = showDropdown && !isTyping;

  const searchQuery = useSearchPages({ q: debouncedQ, limit: SUGGESTION_LIMIT });
  const recentsQuery = useRecentlyViewedPages({ enabled: showRecents });

  // Close on outside click. We use mousedown (not click) so that
  // clicking a result Link still navigates — Link's click runs after
  // mousedown, which sets isFocused=false; the Link's own click fires
  // afterward and the navigation succeeds.
  useEffect(() => {
    if (!showDropdown) return;
    const onMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsFocused(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [showDropdown]);

  const closeAndBlur = () => {
    setIsFocused(false);
    inputRef.current?.blur();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    router.push(`/_search?q=${encodeURIComponent(trimmed)}`);
    closeAndBlur();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAndBlur();
    }
  };

  // Visual: rounded-full pill, expands on focus. The unfocused width
  // (`w-72` = 18rem) matches the surrounding header rhythm; on focus
  // we stretch to fill the parent flex slot, bounded by `max-w-2xl` so
  // very wide windows don't end up with a stretched input that looks
  // detached from the rest of the header.
  return (
    <div ref={containerRef} className={`relative ${isFocused ? 'flex-1 max-w-2xl' : 'w-72'} hidden md:block transition-[width,max-width] duration-200`}>
      <form role="search" onSubmit={handleSubmit}>
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setIsFocused(true)}
          onKeyDown={handleKeyDown}
          placeholder={m['search.global.placeholder']()}
          aria-label={m['search.global.placeholder']()}
          className="h-9 w-full rounded-full border border-input bg-muted/40 pl-10 pr-3 text-sm placeholder:text-muted-foreground outline-none transition-shadow focus:bg-background focus:border-ring focus:ring-ring/50 focus:ring-[3px] focus:shadow-md"
        />
      </form>

      {showDropdown && (
        <div className="absolute left-0 right-0 top-full mt-2 max-h-[28rem] overflow-y-auto rounded-2xl border bg-popover text-popover-foreground shadow-lg z-50">
          {showResults && (
            <ResultsSection
              isLoading={searchQuery.isLoading}
              isError={searchQuery.isError}
              hits={searchQuery.data?.data ?? []}
              total={searchQuery.data?.meta.total ?? 0}
              onItemClick={closeAndBlur}
              onShowAll={() => {
                router.push(`/_search?q=${encodeURIComponent(debouncedQ)}`);
                closeAndBlur();
              }}
            />
          )}
          {showRecents && <RecentsSection isLoading={recentsQuery.isLoading} pages={recentsQuery.data?.pages ?? []} onItemClick={closeAndBlur} />}
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
  if (isLoading && hits.length === 0) {
    return <div className="px-3 py-3 text-sm text-muted-foreground">{m['search.global.searching']()}</div>;
  }
  if (hits.length === 0) {
    return <div className="px-3 py-3 text-sm text-muted-foreground">{m['search.global.no_results']()}</div>;
  }
  return (
    <div className="p-1.5">
      <div className="px-3 py-1 text-xs font-medium text-muted-foreground">{m['search.global.results_heading']({ total: String(total) })}</div>
      <div className="space-y-0.5">
        {hits.map((hit) => (
          <SearchSuggestionItem key={hit.pageId} href={hit.path} page={hit.page} snippet={hit.snippet} onClick={onItemClick} />
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
  isLoading: boolean;
  pages: NonNullable<ReturnType<typeof useRecentlyViewedPages>['data']>['pages'];
  onItemClick: () => void;
}

function RecentsSection({ isLoading, pages, onItemClick }: RecentsSectionProps) {
  if (isLoading && pages.length === 0) {
    return <div className="px-3 py-3 text-sm text-muted-foreground">{m['search.global.loading_recents']()}</div>;
  }
  if (pages.length === 0) {
    // Soft-fail: redis cold / disabled / first session. Hide the
    // section header and show a generic hint so the dropdown isn't
    // empty-looking.
    return (
      <div className="px-3 py-3 text-sm text-muted-foreground flex items-center gap-2">
        <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {m['search.global.empty_hint']()}
      </div>
    );
  }
  return (
    <div className="p-1.5">
      <div className="px-3 py-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Clock className="h-3 w-3" aria-hidden="true" />
        {m['search.global.recents_heading']()}
      </div>
      <div className="space-y-0.5">
        {pages.map((page) => (
          <SearchSuggestionItem key={page._id} href={page.path} page={page} onClick={onItemClick} />
        ))}
      </div>
    </div>
  );
}
