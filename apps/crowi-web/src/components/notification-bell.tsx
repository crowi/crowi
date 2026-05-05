'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import type { Notification } from '@crowi/api-contract';

import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { UserAvatar } from '@/components/user-avatar';
import { cn } from '@/lib/utils';
import { useUnreadCount, useNotifications, useMarkAllAsRead, useOpenNotification } from '@/lib/use-notifications';
import { formatJaRelativeTime, buildNotificationMessage, isUnopenedNotification } from '@/lib/notification-format';

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
      {firstUser ? (
        <UserAvatar user={firstUser} size="sm" className="mt-0.5 shrink-0" />
      ) : (
        <div className="mt-0.5 h-6 w-6 shrink-0 rounded-full bg-muted" aria-hidden />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="line-clamp-2 break-all text-foreground">{buildNotificationMessage(notification)}</div>
        <div className="text-xs text-muted-foreground">{formatJaRelativeTime(notification.createdAt)}</div>
      </div>
      {isUnread ? <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden /> : null}
    </button>
  );
}

/**
 * Header notification bell with unread count badge and a dropdown showing the
 * latest notifications. Polls the unread count every 30s while the tab is
 * active. The notification list query is only triggered when the dropdown is
 * opened.
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
    router.push(notification.target.path);
  };

  const handleMarkAllAsRead = () => {
    markAllAsRead.mutate();
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="通知" className="relative text-white hover:bg-white/10">
          <Bell className="h-5 w-5" />
          {hasUnread ? (
            <span
              aria-live="polite"
              className="absolute -top-0.5 -right-0.5 flex min-w-[1.1rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white"
            >
              {badgeLabel}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">通知</span>
          <button
            type="button"
            onClick={handleMarkAllAsRead}
            disabled={!hasUnread || markAllAsRead.isPending}
            className="text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            すべて既読にする
          </button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {isLoading ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">読み込み中...</div>
          ) : notifications.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">通知はありません</div>
          ) : (
            notifications.map((n) => <NotificationRow key={n._id} notification={n} onOpen={handleOpenNotification} />)
          )}
        </div>
        <div className="border-t px-3 py-2 text-center">
          <Link href="/notifications" onClick={() => setOpen(false)} className="text-xs text-muted-foreground hover:text-foreground">
            すべて表示
          </Link>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
