'use client';

import { Suspense, useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';
import type { SearchPageType } from '@crowi/api-contract';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorAlert } from '@/components/ui/error-alert';
import { Input } from '@/components/ui/input';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { Button } from '@/components/ui/button';
import { SearchHitItem } from '@/components/search/search-hit-item';
import { SearchPager } from '@/components/search/search-pager';
import { ALL_TAB, type SearchTypeTabValue, SearchTypeTabs, isSearchTypeTabValue } from '@/components/search/search-type-tabs';
import { SearchDisabledError, useSearchPages } from '@/lib/use-search';
import { usePageTitle } from '@/lib/use-page-title';
import { m } from '@paraglide/messages.js';

const SEARCH_DEBOUNCE_MS = 300;
const RESULTS_PER_PAGE = 50;

function parsePage(value: string | null): number {
  if (!value) return 1;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
}

function parseType(value: string | null): SearchTypeTabValue {
  return isSearchTypeTabValue(value) ? value : ALL_TAB;
}

/**
 * Build a `/search` URL with the supplied params, omitting empties so the
 * URL stays clean (`/search?q=foo` rather than `/search?q=foo&type=&page=1`).
 */
function buildSearchUrl(params: { q: string; type: SearchTypeTabValue; tree: string; page: number }): string {
  const next = new URLSearchParams();
  if (params.q.length > 0) next.set('q', params.q);
  if (params.type !== ALL_TAB) next.set('type', params.type);
  if (params.tree.length > 0) next.set('tree', params.tree);
  if (params.page > 1) next.set('page', String(params.page));
  const qs = next.toString();
  return qs.length > 0 ? `/_search?${qs}` : '/_search';
}

function SearchPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  usePageTitle(m['search.title']());

  const urlQ = searchParams.get('q') ?? '';
  const urlType = parseType(searchParams.get('type'));
  const urlTree = searchParams.get('tree') ?? '';
  const urlPage = parsePage(searchParams.get('page'));

  const [inputValue, setInputValue] = useState(urlQ);

  // Latest non-q URL state, read inside the debounce timer callback. Using a
  // ref keeps the debounce effect's dependency array narrow (`[inputValue,
  // urlQ]`) so a tab/tree click that changes `urlType`/`urlTree` mid-typing
  // doesn't reset the timer and lose the user's keystrokes. The ref is
  // refreshed via a separate effect so the timer callback always sees the
  // latest values when it eventually fires.
  const latestRef = useRef({ urlType, urlTree });
  useEffect(() => {
    latestRef.current = { urlType, urlTree };
  }, [urlType, urlTree]);

  // URL → input one-way sync on navigation (back / forward / external link).
  useEffect(() => {
    setInputValue(urlQ);
  }, [urlQ]);

  // Input → URL with 300ms debounce. Typing resets `page` to 1 implicitly
  // because the query change invalidates the previous offset. (The same
  // reset rule applies to type / tree changes — handled in their dedicated
  // setters below.)
  useEffect(() => {
    if (inputValue === urlQ) return;
    const timer = setTimeout(() => {
      // Re-check equality at fire time: a navigation may have synced `urlQ`
      // to match `inputValue` between scheduling and firing.
      if (inputValue === urlQ) return;
      const { urlType: latestType, urlTree: latestTree } = latestRef.current;
      startTransition(() => {
        router.replace(buildSearchUrl({ q: inputValue, type: latestType, tree: latestTree, page: 1 }));
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [inputValue, urlQ, router]);

  const handleTypeChange = (next: SearchTypeTabValue) => {
    if (next === urlType) return;
    startTransition(() => {
      router.replace(buildSearchUrl({ q: urlQ, type: next, tree: urlTree, page: 1 }));
    });
  };

  const handlePageChange = (nextPage: number) => {
    if (nextPage === urlPage) return;
    startTransition(() => {
      router.replace(buildSearchUrl({ q: urlQ, type: urlType, tree: urlTree, page: nextPage }));
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const apiType: SearchPageType | undefined = urlType === ALL_TAB ? undefined : urlType;

  const { data, isLoading, isFetching, error } = useSearchPages({
    q: urlQ,
    type: apiType,
    tree: urlTree.length > 0 ? urlTree : undefined,
    page: urlPage,
    limit: RESULTS_PER_PAGE,
  });

  const isSearchDisabled = error instanceof SearchDisabledError;
  const hasOtherError = !!error && !isSearchDisabled;
  const hasQuery = urlQ.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{m['search.title']()}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{m['search.lead']()}</p>
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              type="search"
              autoFocus
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={m['search.input.placeholder']()}
              aria-label={m['search.input.placeholder']()}
              className="pl-9"
            />
          </div>

          <SearchTypeTabs value={urlType} onChange={handleTypeChange} />

          {urlTree.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {m['search.tree_filter_active']({ tree: urlTree })}
              {' · '}
              <Link replace className="underline hover:text-foreground" href={buildSearchUrl({ q: urlQ, type: urlType, tree: '', page: 1 })}>
                {m['search.tree_filter_clear']()}
              </Link>
            </p>
          )}

          {!hasQuery && (
            <div className="rounded-md bg-muted/30 p-8 text-center">
              <p className="text-muted-foreground">{m['search.empty_query']()}</p>
            </div>
          )}

          {hasQuery && isSearchDisabled && (
            <>
              <ErrorAlert title={m['search.disabled_title']()} message={m['search.disabled_body']()} />
              <div className="flex justify-end">
                <Button asChild variant="outline" size="sm">
                  <Link href="/admin/plugins">{m['search.disabled_admin_link']()}</Link>
                </Button>
              </div>
            </>
          )}

          {hasQuery && hasOtherError && (
            <ErrorAlert title={m['search.error_title']()} message={error instanceof Error ? error.message : m['search.error_body']()} />
          )}

          {hasQuery && !error && isLoading && <LoadingSpinner message={m['search.loading']()} className="py-8" />}

          {hasQuery && !error && !isLoading && data && (
            <div aria-busy={isFetching} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {data.meta.total === 0 ? m['search.results.none']() : m['search.results.summary']({ total: data.meta.total, q: urlQ })}
              </p>

              {data.data.length > 0 ? (
                <div className="rounded-md border bg-card divide-y">
                  {data.data.map((hit) => (
                    <SearchHitItem key={hit.pageId} hit={hit} />
                  ))}
                </div>
              ) : (
                <div className="rounded-md bg-muted/30 p-8 text-center">
                  <p className="text-muted-foreground">{m['search.results.empty_for_query']({ q: urlQ })}</p>
                </div>
              )}

              <SearchPager page={urlPage} total={data.meta.total} limit={RESULTS_PER_PAGE} onPageChange={handlePageChange} />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * `useSearchParams` requires a `<Suspense>` boundary in the App Router, so
 * the page-level component is split: the outer file-default export wraps
 * `<SearchPageInner>` in Suspense to satisfy that requirement.
 */
export default function SearchPage() {
  return (
    <Suspense fallback={<LoadingSpinner className="py-12" />}>
      <SearchPageInner />
    </Suspense>
  );
}
