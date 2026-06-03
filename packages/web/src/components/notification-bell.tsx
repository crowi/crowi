'use client';

import type { Notification } from '@crowi/api-contract';
import { NotificationActionEnum } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { Bell } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { NotificationAvatar } from '@/components/notification-list/notification-avatar';
import { NotificationMessage } from '@/components/notification-list/notification-message';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { formatRelativeTime, isUnopenedNotification } from '@/lib/notification-format';
import { resolveNotificationHref } from '@/lib/notification-href';
import { SCROLL_TARGETS, scrollToSectionWhenReady } from '@/lib/scroll-to-section';
import { useMarkAllAsRead, useNotifications, useOpenNotification, useUnreadCount } from '@/lib/use-notifications';
import { cn } from '@/lib/utils';

interface NotificationRowProps {
  notification: Notification;
  onOpen: (notification: Notification) => void | Promise<void>;
}

function NotificationRow({ notification, onOpen }: NotificationRowProps) {
  const isUnread = isUnopenedNotification(notification);
  const firstUser = notification.actionUsers[0];

  return (
    <button
      type="button"
      onClick={() => {
        void onOpen(notification);
      }}
      className={cn(
        'flex w-full items-start gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus:bg-accent focus:outline-none',
        isUnread && 'bg-accent/40',
      )}
    >
      <NotificationAvatar user={firstUser} action={notification.action} size="sm" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="line-clamp-2 break-words text-muted-foreground">
          <NotificationMessage notification={notification} />
        </div>
        <div className="text-xs text-muted-foreground">{formatRelativeTime(notification.createdAt)}</div>
      </div>
      {isUnread ? <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden /> : null}
    </button>
  );
}

/**
 * Header notification bell with unread count badge and a dropdown showing
 * the latest notifications. The unread count refreshes from
 * server-pushed `changed` ticks (via the `useNotificationsSocket` hook
 * mounted in `(auth)/layout.tsx`) — the 30-second polling loop that
 * used to back it was removed when the realtime invalidation channel
 * landed. The notification list query is only triggered when the
 * dropdown is opened.
 */
export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const { data: unreadCount = 0 } = useUnreadCount();
  const { data: listData, isLoading } = useNotifications({ limit: 10, enabled: open });
  const markAllAsRead = useMarkAllAsRead();
  const openNotification = useOpenNotification();

  const notifications = listData?.notifications ?? [];
  const hasUnread = unreadCount > 0;
  const badgeLabel = unreadCount > 99 ? '99+' : String(unreadCount);

  const handleOpenNotification = async (notification: Notification) => {
    try {
      await openNotification.mutateAsync(notification._id);
    } catch {
      // Even if marking as opened failed, still navigate to the target page so
      // the user is not blocked by a transient error.
    }
    setOpen(false);
    // `scroll: false` so Next.js doesn't jump-to-top while the target
    // heading is still being rendered; page-content's hash-watching
    // MutationObserver does the in-page scroll once the AST lands.
    router.push(resolveNotificationHref(notification), { scroll: false });
    // page-content's hash-watch effect only re-runs when the URL hash
    // actually changes — same-pathname/same-hash navigations (e.g.
    // re-clicking the same notification, or opening a comment
    // notification on the page already in view) wouldn't trigger it.
    // Drive the scroll manually for COMMENT actions so those cases
    // still land on the comments section. Idempotent with the
    // page-content path for cross-page navigations.
    if (notification.action === NotificationActionEnum.COMMENT) {
      scrollToSectionWhenReady(SCROLL_TARGETS.COMMENTS);
    }
  };

  const handleMarkAllAsRead = () => {
    markAllAsRead.mutate();
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={m['header.notifications_aria']()} className="relative text-muted-foreground hover:text-foreground">
          <Bell className="h-4 w-4" />
          {hasUnread ? (
            <span
              aria-live="polite"
              className="absolute -top-0.5 -right-0.5 flex h-[1.1rem] min-w-[1.1rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white"
            >
              {badgeLabel}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      {/*
        `max-w-[calc(100vw-1.5rem)]` caps the panel at the viewport on
        mobile (the fixed `w-96` = 384px otherwise nearly fills a phone
        screen, and Radix's collision avoidance clamps it flush to the
        left edge). `collisionPadding={12}` then keeps an equal 0.75rem
        gap on both sides — the panel is sized to `viewport - 24px` and
        collision aligns it to `edge + padding`, so left and right
        margins match and it reads as centred. On desktop the 384px
        panel is well under the cap and still hangs under the bell.
      */}
      <DropdownMenuContent align="end" collisionPadding={12} className="w-96 max-w-[calc(100vw-1.5rem)] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">{m['notifications.title']()}</span>
          <button
            type="button"
            onClick={handleMarkAllAsRead}
            disabled={!hasUnread || markAllAsRead.isPending}
            className="text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            {m['notifications.mark_all_read']()}
          </button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {isLoading ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">{m['common.loading']()}</div>
          ) : notifications.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">{m['notifications.empty']()}</div>
          ) : (
            notifications.map((n) => <NotificationRow key={n._id} notification={n} onOpen={handleOpenNotification} />)
          )}
        </div>
        <div className="border-t px-3 py-2 text-center">
          <Link href="/_notifications" onClick={() => setOpen(false)} className="text-xs text-muted-foreground hover:text-foreground">
            {m['notifications.see_all']()}
          </Link>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
