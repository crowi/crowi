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
        'relative flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent/60 focus:bg-accent/60 focus:outline-none',
        isUnread && 'bg-accent/40',
      )}
    >
      {/* Unread affordance: a brand-coloured left accent bar (replaces the
          old off-brand blue tint + red dot) — cleaner and on-theme. */}
      {isUnread ? <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" aria-label={m['notifications.unread_aria']()} /> : null}
      <NotificationAvatar user={notification.actionUsers[0]} action={notification.action} size="md" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-sm break-words text-foreground/80">
          <NotificationMessage notification={notification} />
        </div>
        <div className="text-xs text-muted-foreground">{formatRelativeTime(notification.createdAt)}</div>
      </div>
    </button>
  );
}
