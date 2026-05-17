'use client';

import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { UserAvatar } from '@/components/user-avatar';
import { useSeenUsers } from '@/lib/use-seen';
import { m } from '@paraglide/messages.js';

interface SeenUsersDialogProps {
  pageId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Count from the chip, shown in the description until the query resolves. */
  fallbackCount?: number;
}

/**
 * RFC-0005 Phase 3 — "Seen by" modal.
 *
 * The dialog body (`SeenUsersFullList`) is unchanged from v1.x — it is
 * just no longer reached via an avatar-stack overflow button. The
 * historical seen-users avatar stack below the page title has been
 * removed; the modal is now opened from the `[👁 N] 閲覧` meta-chip
 * (`MetaChipRow`).
 */
export function SeenUsersDialog({ pageId, open, onOpenChange, fallbackCount }: SeenUsersDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m['page.seen_by_dialog_title']()}</DialogTitle>
          <DialogDescription>{m['page.seen_by_dialog_description']({ count: fallbackCount ?? 0 })}</DialogDescription>
        </DialogHeader>
        <SeenUsersFullList pageId={pageId} enabled={open} />
      </DialogContent>
    </Dialog>
  );
}

function SeenUsersFullList({ pageId, enabled }: { pageId: string; enabled: boolean }) {
  const { data, isLoading } = useSeenUsers(pageId, { enabled });
  const users = data?.seenUsers ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        {m['page.seen_by_loading']()}
      </div>
    );
  }

  if (users.length === 0) {
    return <p className="text-sm text-muted-foreground py-2">{m['page.seen_by_empty']()}</p>;
  }

  return (
    <ul className="max-h-80 overflow-y-auto divide-y" aria-label={m['page.seen_by_dialog_title']()}>
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
