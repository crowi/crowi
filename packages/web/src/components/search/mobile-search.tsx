'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Clock, Search } from 'lucide-react';
import { useSearchPages } from '@/lib/use-search';
import { useRecentlyViewedPages } from '@/lib/use-recently-viewed';
import { pagePathToHref } from '@/lib/page-path';
import { SearchSuggestionItem } from './search-suggestion-item';
import { m } from '@paraglide/messages.js';

const SUGGESTION_DEBOUNCE_MS = 200;
const MOBILE_SUGGESTION_LIMIT = 12;

const buildSearchUrl = (q: string) => `/_search?q=${encodeURIComponent(q)}`;

/**
 * Mobile (< md) search. The desktop `GlobalSearchInput` is hidden below
 * 768px, so a phone / narrow tablet would have no way to search. This
 * adds a search icon next to the logo that opens a full-screen search
 * surface: a search bar pinned at the top (auto-focused) with a results
 * area filling the rest of the viewport. `md:hidden` so it never shows
 * alongside the desktop input.
 */
export function MobileSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(value.trim()), SUGGESTION_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [value]);

  // Focus the input as soon as the surface opens; lock background scroll
  // so the full-screen results don't scroll the page behind them.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const searchQuery = useSearchPages({ q: debouncedQ });
  const recentsQuery = useRecentlyViewedPages({ enabled: open && debouncedQ.length === 0 });

  const close = () => {
    setOpen(false);
    setValue('');
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    router.push(buildSearchUrl(trimmed));
    close();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  const isTyping = debouncedQ.length > 0;
  const hits = searchQuery.data?.data ?? [];
  const total = searchQuery.data?.meta.total ?? 0;
  const recents = recentsQuery.data?.pages ?? [];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={m['search.global.placeholder']()}
        className="md:hidden flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Search className="h-5 w-5" />
      </button>

      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 flex flex-col bg-background md:hidden">
            {/* Top search bar — sits where the header is, replacing it
                while searching. Back arrow + auto-focused input. */}
            <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
              <button
                type="button"
                onClick={close}
                aria-label={m['common.go_back']()}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
              <form role="search" onSubmit={handleSubmit} className="relative flex-1">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <input
                  ref={inputRef}
                  type="search"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={m['search.global.placeholder']()}
                  aria-label={m['search.global.placeholder']()}
                  className="h-9 w-full rounded-full border border-input bg-muted/40 pl-10 pr-3 text-sm placeholder:text-muted-foreground outline-none transition-shadow focus:border-ring focus:bg-background focus:shadow-md focus:ring-[3px] focus:ring-ring/50"
                />
              </form>
            </div>

            {/* Results — full-screen, scrollable. */}
            <div className="flex-1 overflow-y-auto overscroll-contain">
              {isTyping ? (
                searchQuery.isError ? (
                  <p className="px-4 py-4 text-sm text-muted-foreground">{m['search.global.error']()}</p>
                ) : hits.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-muted-foreground">
                    {searchQuery.isLoading ? m['search.global.searching']() : m['search.global.no_results']()}
                  </p>
                ) : (
                  <div className="p-2">
                    <div className="px-3 py-1 text-xs font-medium text-muted-foreground">{m['search.global.results_heading']({ total: String(total) })}</div>
                    <div className="space-y-0.5">
                      {hits.slice(0, MOBILE_SUGGESTION_LIMIT).map((hit) => (
                        <SearchSuggestionItem key={hit.pageId} href={pagePathToHref(hit.path)} page={hit.page} snippet={hit.snippet} onClick={close} />
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        router.push(buildSearchUrl(debouncedQ));
                        close();
                      }}
                      className="mt-1 w-full rounded-md px-3 py-2 text-left text-sm font-medium text-primary transition-colors hover:bg-accent"
                    >
                      {m['search.global.see_all_results']()}
                    </button>
                  </div>
                )
              ) : recents.length > 0 ? (
                <div className="p-2">
                  <div className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-muted-foreground">
                    <Clock className="h-3 w-3" aria-hidden="true" />
                    {m['search.global.recents_heading']()}
                  </div>
                  <div className="space-y-0.5">
                    {recents.map((page) => (
                      <SearchSuggestionItem key={page._id} href={pagePathToHref(page.path)} page={page} onClick={close} />
                    ))}
                  </div>
                </div>
              ) : recentsQuery.isLoading ? (
                <p className="px-4 py-4 text-sm text-muted-foreground">{m['search.global.loading_recents']()}</p>
              ) : (
                <p className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
                  <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {m['search.global.empty_hint']()}
                </p>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
