'use client';

import type { UserListItem } from '@crowi/api-contract';
import { UserCard } from './user-card';

/**
 * Responsive member grid — 2 columns on mobile, 3 on tablet, 4 on
 * desktop. With the preview limit of 20 that lands as ~5 rows on a wide
 * screen, matching the "3〜4 列 × 5 行" directory layout.
 */
export function UserCardGrid({ users }: { users: UserListItem[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {users.map((user) => (
        <UserCard key={user._id} user={user} />
      ))}
    </div>
  );
}

export function UserCardGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
        <div key={i} className="flex items-center gap-3 rounded-lg border bg-card p-3">
          <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-muted" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}
