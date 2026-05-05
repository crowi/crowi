'use client';

import { Eye } from 'lucide-react';
import { UserAvatar } from '@/components/user-avatar';
import { useSeenUsers } from '@/lib/use-seen';

interface SeenUserListProps {
  pageId: string;
  // Initial count from the page payload, used until the query resolves.
  fallbackCount?: number;
}

export function SeenUserList({ pageId, fallbackCount }: SeenUserListProps) {
  const { data } = useSeenUsers(pageId);

  const seenUsers = data?.seenUsers ?? [];
  const seenUsersCount = data?.seenUsersCount ?? fallbackCount ?? 0;

  if (seenUsersCount === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 mt-3 text-sm text-muted-foreground">
      <Eye className="h-4 w-4" aria-hidden="true" />
      <span>Seen by</span>
      {seenUsers.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-1" aria-label="Users who have seen this page">
          {seenUsers.map((user) => {
            const tooltip = user.name ? `${user.name} (@${user.username})` : `@${user.username}`;
            return (
              <li key={user._id} title={tooltip}>
                <UserAvatar user={user} size="sm" />
              </li>
            );
          })}
        </ul>
      ) : (
        <span>{seenUsersCount}</span>
      )}
    </div>
  );
}
