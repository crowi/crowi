import type { Notification } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { formatDistanceToNow } from './date-utils';
import { pageDisplayName } from './page-path';

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
  // Show the page's short name (trailing path segment, date-run aware) like
  // the page list does — the full path overflowed the bell popover and hid
  // the action verb. Fall back to the raw path for the root page ('/').
  const path = pageDisplayName(target.path) || target.path;

  // UPDATE uses a dedicated template: the shared "...「{path}」に{action}します"
  // (JA) reads unnaturally as "に更新しました". The verb is baked into the
  // UPDATE template instead ("「{path}」を更新しました" / "updated \"{path}\"").
  if (action === 'UPDATE') {
    if (actionUsers.length > 1) {
      return m['notifications.message_multi_users_update']({ user, others: actionUsers.length - 1, path });
    }
    return m['notifications.message_one_user_update']({ user, path });
  }

  const actionLabel = resolveActionLabel(action);
  if (actionUsers.length > 1) {
    return m['notifications.message_multi_users']({ user, others: actionUsers.length - 1, path, action: actionLabel });
  }
  return m['notifications.message_one_user']({ user, path, action: actionLabel });
}

/**
 * A run of notification-message text, flagged for bold emphasis. The
 * message templates wrap the page name and the action verb in `**...**`
 * markers (a markdown-bold convention the translators control per locale);
 * this splits the rendered string into alternating plain / bold runs so the
 * UI can render the emphasised parts as `<strong>`. Odd-indexed split
 * results are the marked (bold) runs.
 */
export interface MessageSegment {
  text: string;
  bold: boolean;
}

export function splitMessageSegments(message: string): MessageSegment[] {
  return message
    .split('**')
    .map((text, i) => ({ text, bold: i % 2 === 1 }))
    .filter((segment) => segment.text.length > 0);
}

function resolveActionLabel(action: Notification['action']): string {
  switch (action) {
    case 'COMMENT':
      return m['notifications.action_comment']();
    case 'LIKE':
      return m['notifications.action_like']();
    case 'MENTION':
      return m['notifications.action_mention']();
    case 'UPDATE':
      return m['notifications.action_update']();
    default: {
      // Exhaustiveness check — if a new NotificationAction is added to
      // the contract but this switch isn't updated, TS will fail to
      // narrow `_unreachable` to `never` and flag the missing case.
      const _unreachable: never = action;
      return _unreachable;
    }
  }
}

/**
 * Returns true when the notification has not been opened by the user yet.
 * UNREAD: never seen in any list. UNOPENED: seen in a list but not opened.
 * OPENED: viewed (target page navigated to).
 */
export function isUnopenedNotification(notification: Pick<Notification, 'status'>): boolean {
  return notification.status === 'UNREAD' || notification.status === 'UNOPENED';
}
