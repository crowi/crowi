'use client';

import { m } from '@paraglide/messages.js';
import { Search, Users } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Pagination } from '@/components/page-list/pagination';
import { ErrorAlert } from '@/components/ui/error-alert';
import { Input } from '@/components/ui/input';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { UserCardGrid, UserCardGridSkeleton } from '@/components/user-directory/user-card-grid';
import { usePageTitle } from '@/lib/use-page-title';
import { useUserList } from '@/lib/use-user-list';

const SEARCH_DEBOUNCE_MS = 300;
const RESULTS_PER_PAGE = 48;

function UserDirectoryPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  usePageTitle(m['user_directory.title']());

  const urlQ = searchParams.get('q') ?? '';
  const [inputValue, setInputValue] = useState(urlQ);
  // Offset is page-local (not in the URL): typing resets to the first page
  // because the previous offset is meaningless under a new query.
  const [offset, setOffset] = useState(0);

  // URL → input one-way sync on navigation (back / forward / external link).
  useEffect(() => {
    setInputValue(urlQ);
  }, [urlQ]);

  // Reset paging whenever the effective query changes — the old offset is
  // meaningless under a new query.
  useEffect(() => {
    setOffset(0);
  }, [urlQ]);

  // Input → URL with debounce so the search term is bookmarkable/shareable.
  useEffect(() => {
    if (inputValue === urlQ) return;
    const timer = setTimeout(() => {
      if (inputValue === urlQ) return;
      const next = new URLSearchParams();
      if (inputValue.length > 0) next.set('q', inputValue);
      const qs = next.toString();
      router.replace(qs.length > 0 ? `/_user?${qs}` : '/_user');
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [inputValue, urlQ, router]);

  const { data, isLoading, isFetching, error } = useUserList({ q: urlQ, limit: RESULTS_PER_PAGE, offset });

  const handlePageChange = (nextOffset: number) => {
    setOffset(nextOffset);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Users className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          {m['user_directory.title']()}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{m['user_directory.lead']()}</p>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          type="search"
          autoFocus
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder={m['user_directory.search_placeholder']()}
          aria-label={m['user_directory.search_placeholder']()}
          className="pl-9"
        />
      </div>

      {error ? (
        <ErrorAlert message={m['user_directory.failed']()} />
      ) : isLoading ? (
        <UserCardGridSkeleton count={12} />
      ) : data && data.users.length > 0 ? (
        <div aria-busy={isFetching} className="space-y-2">
          <p className="text-sm text-muted-foreground">{m['user_directory.count']({ count: data.total })}</p>
          <UserCardGrid users={data.users} />
          <Pagination pager={data.pager} limit={RESULTS_PER_PAGE} onPageChange={handlePageChange} />
        </div>
      ) : (
        <p className="rounded-md bg-muted/30 p-8 text-center text-sm text-muted-foreground">
          {urlQ.length > 0 ? m['user_directory.search_empty']({ q: urlQ }) : m['user_directory.empty']()}
        </p>
      )}
    </div>
  );
}

/**
 * `useSearchParams` requires a `<Suspense>` boundary in the App Router, so
 * the inner component is wrapped here (mirrors the `/_search` page).
 */
export default function UserDirectoryPage() {
  return (
    <Suspense fallback={<LoadingSpinner className="py-12" />}>
      <UserDirectoryPageInner />
    </Suspense>
  );
}
