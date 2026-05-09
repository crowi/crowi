import type { Notification } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { formatDistanceToNow } from './date-utils';

export const formatRelativeTime = formatDistanceToNow;

/**
 * Build a human-readable notification text. The two templates differ in
 * arity (single user vs many) so both keys exist as separate messages — the
 * pluralisation rules (in JA there's nothing to do; in EN "others" carries
 * count) live inside the message strings.
 */
export function buildNotificationMessage(notification: Notification): string {
  const { actionUsers, target, action } = notification;
  const firstUser = actionUsers[0];
  const user = firstUser ? firstUser.name || firstUser.username : m['notifications.unknown_user']();
  const actionLabel = action === 'COMMENT' ? m['notifications.action_comment']() : m['notifications.action_like']();

  if (actionUsers.length > 1) {
    return m['notifications.message_multi_users']({ user, others: actionUsers.length - 1, path: target.path, action: actionLabel });
  }
  return m['notifications.message_one_user']({ user, path: target.path, action: actionLabel });
}

/**
 * Returns true when the notification has not been opened by the user yet.
 * UNREAD: never seen in any list. UNOPENED: seen in a list but not opened.
 * OPENED: viewed (target page navigated to).
 */
export function isUnopenedNotification(notification: Pick<Notification, 'status'>): boolean {
  return notification.status === 'UNREAD' || notification.status === 'UNOPENED';
}
