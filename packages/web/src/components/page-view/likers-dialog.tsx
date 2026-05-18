'use client';

import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { UserAvatar } from '@/components/user-avatar';
import { useLikers } from '@/lib/use-likers';
import { m } from '@paraglide/messages.js';

/**
 * Cap on the liker list the dialog fetches. The list is a scrollable
 * modal, not a paginated view — a generous cap keeps a pathological
 * page (thousands of likers) from loading an unbounded payload while
 * still covering every realistic case. `totalCount` in the description
 * still reflects the true total.
 */
const LIKERS_DIALOG_LIMIT = 100;

interface LikersDialogProps {
  pageId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Count from the chip, shown in the description until the query resolves. */
  fallbackCount?: number;
}

/**
 * RFC-0005 Phase 3 — "Liked by" modal opened from the like meta-chip.
 *
 * Structurally mirrors `SeenUserList`'s `SeenUsersFullList` dialog:
 * avatar + name + @username row, scrollable, loading / empty states.
 * The like list is not private — read access to the page is enough.
 */
export function LikersDialog({ pageId, open, onOpenChange, fallbackCount }: LikersDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m['page.liked_by_dialog_title']()}</DialogTitle>
          <DialogDescription>{m['page.liked_by_dialog_description']({ count: fallbackCount ?? 0 })}</DialogDescription>
        </DialogHeader>
        <LikersFullList pageId={pageId} enabled={open} />
      </DialogContent>
    </Dialog>
  );
}

function LikersFullList({ pageId, enabled }: { pageId: string; enabled: boolean }) {
  const { data, isLoading } = useLikers(pageId, { enabled, limit: LIKERS_DIALOG_LIMIT });
  const users = data?.users ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        {m['page.liked_by_loading']()}
      </div>
    );
  }

  if (users.length === 0) {
    return <p className="text-sm text-muted-foreground py-2">{m['page.liked_by_empty']()}</p>;
  }

  return (
    <ul className="max-h-80 overflow-y-auto divide-y" aria-label={m['page.liked_by_dialog_title']()}>
      {users.map((user) => (
        <li key={user.id} className="flex items-center gap-3 py-2">
          <UserAvatar user={{ username: user.username, name: user.displayName, image: user.avatarUrl }} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-sm truncate">{user.displayName || user.username}</div>
            {user.displayName && <div className="text-xs text-muted-foreground truncate">@{user.username}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}
