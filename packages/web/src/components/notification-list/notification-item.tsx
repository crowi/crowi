'use client';

import type { Notification } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { formatRelativeTime, isUnopenedNotification } from '@/lib/notification-format';
import { cn } from '@/lib/utils';
import { NotificationAvatar } from './notification-avatar';
import { NotificationMessage } from './notification-message';

interface NotificationItemProps {
  notification: Notification;
  onOpen: (notification: Notification) => void | Promise<void>;
}

/**
 * A single row in the full notification list at /_notifications.
 *
 * Displays the action user's avatar, a Japanese description of the action,
 * the target page path, and a relative timestamp. Unopened notifications
 * (status UNREAD or UNOPENED) get a highlighted background and a small dot
 * indicator on the right side. Clicking the row delegates to onOpen which is
 * expected to mark the notification as opened and navigate to the target.
 */
export function NotificationItem({ notification, onOpen }: NotificationItemProps) {
  const isUnread = isUnopenedNotification(notification);

  return (
    <button
      type="button"
      onClick={() => {
        void onOpen(notification);
      }}
      className={cn(
        'flex w-full items-start gap-4 px-4 py-4 text-left transition-colors hover:bg-accent/60 focus:bg-accent/60 focus:outline-none',
        isUnread && 'bg-blue-50/40 dark:bg-blue-500/10',
      )}
    >
      <div className="mt-0.5">
        <NotificationAvatar user={notification.actionUsers[0]} action={notification.action} size="md" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="text-sm break-words text-muted-foreground">
          <NotificationMessage notification={notification} />
        </div>
        <div className="text-xs text-muted-foreground">{formatRelativeTime(notification.createdAt)}</div>
      </div>
      {isUnread ? <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden aria-label={m['notifications.unread_aria']()} /> : null}
    </button>
  );
}
