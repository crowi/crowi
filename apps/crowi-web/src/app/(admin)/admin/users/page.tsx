'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { UsersTable } from '@/components/admin/users-table';
import { useAdminUsers } from '@/lib/use-admin-users';
import { m } from '@paraglide/messages.js';

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Coerce ?page=N into a 1-based positive integer; falls back to 1 when the
 * param is missing or malformed. Mirrors the server-side default to keep
 * client / server in sync without a guard.
 */
function parsePage(value: string | null): number {
  if (!value) return 1;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
}

/**
 * /admin/users
 *
 * Searchable, paginated user list. Authorization is delegated to the
 * surrounding (admin) layout — this page assumes the current user is admin
 * and only handles fetch / search / pagination state.
 *
 * URL state model:
 *   ?q=<query>&page=<n>
 * The search input is debounced (300ms) and resets the page to 1 on change
 * so the table doesn't end up on a non-existent page after filtering.
 */
export default function AdminUsersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const urlQuery = searchParams.get('q') ?? '';
  const urlPage = parsePage(searchParams.get('page'));

  // Local input mirrors the URL on mount and is otherwise driven by the
  // controlled <input>. Debounce flushes back to the URL.
  const [inputValue, setInputValue] = useState(urlQuery);

  /**
   * When the URL query changes from another source (back/forward navigation,
   * external link), pull it back into the input so the field reflects the
   * active search.
   */
  useEffect(() => {
    setInputValue(urlQuery);
  }, [urlQuery]);

  /**
   * Debounce: flush the typed value into the URL after 300ms of inactivity.
   * Resets the page to 1 so the user lands on the first page of new results.
   */
  useEffect(() => {
    if (inputValue === urlQuery) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams();
      if (inputValue.length > 0) next.set('q', inputValue);
      // Always reset to page 1 on a query change.
      startTransition(() => {
        router.replace(next.toString().length > 0 ? `/admin/users?${next.toString()}` : '/admin/users');
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [inputValue, urlQuery, router]);

  const queryParams = useMemo(() => ({ q: urlQuery || undefined, page: urlPage }), [urlQuery, urlPage]);
  const { data, isLoading, error, isFetching } = useAdminUsers(queryParams);

  const handlePageChange = (page: number) => {
    const next = new URLSearchParams();
    if (urlQuery.length > 0) next.set('q', urlQuery);
    if (page > 1) next.set('page', String(page));
    startTransition(() => {
      router.replace(next.toString().length > 0 ? `/admin/users?${next.toString()}` : '/admin/users');
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{m['admin.users.heading']()}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{m['admin.users.lead']()}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{m['admin.users.heading']()}</CardTitle>
          <CardDescription>{m['admin.users.lead']()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            type="search"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={m['admin.users.search_placeholder']()}
            aria-label={m['admin.users.search_placeholder']()}
            className="max-w-md"
          />

          {isLoading && <LoadingSpinner />}

          {!isLoading && error && (
            <Alert variant="destructive">
              <AlertDescription>{error instanceof Error ? error.message : m['admin.users.failed_to_load']()}</AlertDescription>
            </Alert>
          )}

          {!isLoading && !error && data && (
            <div aria-busy={isFetching}>
              <UsersTable users={data.users} pager={data.pager} onPageChange={handlePageChange} />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
