'use client';

import { useState } from 'react';
import { Eye, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { UserAvatar } from '@/components/user-avatar';
import { useSeenUsers } from '@/lib/use-seen';

const SEEN_USERS_PREVIEW_LIMIT = 10;

interface SeenUserListProps {
  pageId: string;
  // Initial count from the page payload, used until the query resolves.
  fallbackCount?: number;
}

export function SeenUserList({ pageId, fallbackCount }: SeenUserListProps) {
  const { data } = useSeenUsers(pageId, { limit: SEEN_USERS_PREVIEW_LIMIT });
  const [dialogOpen, setDialogOpen] = useState(false);

  const previewUsers = data?.seenUsers ?? [];
  const seenUsersCount = data?.seenUsersCount ?? fallbackCount ?? 0;

  if (seenUsersCount === 0) {
    return null;
  }

  const hiddenCount = Math.max(0, seenUsersCount - previewUsers.length);

  return (
    <div className="flex items-center gap-2 mt-3 text-sm text-muted-foreground">
      <Eye className="h-4 w-4" aria-hidden="true" />
      <span>Seen by</span>
      {previewUsers.length > 0 ? (
        <ul className="flex items-center -space-x-2" aria-label="Users who have seen this page">
          {previewUsers.map((user) => {
            const tooltip = user.name ? `${user.name} (@${user.username})` : `@${user.username}`;
            return (
              <li key={user._id} title={tooltip} className="rounded-full ring-2 ring-background">
                <UserAvatar user={user} size="sm" />
              </li>
            );
          })}
        </ul>
      ) : (
        <span>{seenUsersCount}</span>
      )}
      {hiddenCount > 0 && (
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setDialogOpen(true)}>
          +{hiddenCount} more
        </Button>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Seen by</DialogTitle>
            <DialogDescription>{seenUsersCount} users have seen this page.</DialogDescription>
          </DialogHeader>
          <SeenUsersFullList pageId={pageId} enabled={dialogOpen} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SeenUsersFullList({ pageId, enabled }: { pageId: string; enabled: boolean }) {
  const { data, isLoading } = useSeenUsers(pageId, { enabled });
  const users = data?.seenUsers ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading users...
      </div>
    );
  }

  if (users.length === 0) {
    return <p className="text-sm text-muted-foreground py-2">No users to show.</p>;
  }

  return (
    <ul className="max-h-80 overflow-y-auto divide-y" aria-label="All users who have seen this page">
      {users.map((user) => (
        <li key={user._id} className="flex items-center gap-3 py-2">
          <UserAvatar user={user} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-sm truncate">{user.name || user.username}</div>
            {user.name && <div className="text-xs text-muted-foreground truncate">@{user.username}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}
