'use client';

import { m } from '@paraglide/messages.js';
import { ArrowRight, Users } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ErrorAlert } from '@/components/ui/error-alert';
import { useUserList } from '@/lib/use-user-list';
import { UserCardGrid, UserCardGridSkeleton } from './user-card-grid';

// 4 columns × 5 rows on a wide screen. The full roster lives at `/_user`.
const PREVIEW_LIMIT = 20;

/**
 * Member-directory preview rendered at the top of the special `/user/`
 * portal. Shows the first {PREVIEW_LIMIT} members (name-ascending) as a
 * card grid, with a "show all" link into the dedicated `/_user` directory
 * when there are more. Below this preview the page renders the normal
 * page list of pages under `/user/`.
 */
export function UserDirectoryPreview() {
  const { data, isLoading, error } = useUserList({ limit: PREVIEW_LIMIT, offset: 0 });

  if (error) {
    return <ErrorAlert message={m['user_directory.failed']()} />;
  }

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <Users className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            {m['user_directory.title']()}
          </h2>
          {data && <p className="mt-0.5 text-sm text-muted-foreground">{m['user_directory.count']({ count: data.total })}</p>}
        </div>
        <Button asChild variant="ghost" size="sm" className="shrink-0">
          <Link href="/_user">
            {m['user_directory.show_all']()}
            <ArrowRight className="ml-1 h-4 w-4" />
          </Link>
        </Button>
      </div>

      {isLoading ? (
        <UserCardGridSkeleton />
      ) : data && data.users.length > 0 ? (
        <UserCardGrid users={data.users} />
      ) : (
        <p className="rounded-md bg-muted/30 p-6 text-center text-sm text-muted-foreground">{m['user_directory.empty']()}</p>
      )}
    </section>
  );
}
