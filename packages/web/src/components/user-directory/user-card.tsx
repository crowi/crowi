'use client';

import type { UserListItem } from '@crowi/api-contract';
import Link from 'next/link';
import { UserAvatar } from '@/components/user-avatar';

/**
 * A single member-directory card: avatar + display name + @username,
 * linking to the user's page (`/user/<username>`). The whole card is the
 * link target so it presents a comfortable tap area.
 */
export function UserCard({ user }: { user: UserListItem }) {
  const displayName = user.name || user.username;

  return (
    <Link
      href={`/user/${encodeURIComponent(user.username)}`}
      className="flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <UserAvatar user={user} size="md" className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{displayName}</div>
        <div className="truncate text-xs text-muted-foreground">@{user.username}</div>
      </div>
    </Link>
  );
}
