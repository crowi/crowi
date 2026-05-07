import type { Notification } from '@crowi/api-contract';
import { m } from '@/paraglide/messages.js';

/**
 * Format a date string to a localized relative-time string.
 * Driven by paraglide messages so it switches to English when the active
 * locale is `en` (e.g. "5 min ago" instead of "5 分前").
 */
export function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = Math.max(0, now.getTime() - date.getTime());

  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffSecs < 60) return m['notifications.relative_seconds']();
  if (diffMins < 60) return m['notifications.relative_minutes']({ count: diffMins });
  if (diffHours < 24) return m['notifications.relative_hours']({ count: diffHours });
  if (diffDays < 7) return m['notifications.relative_days']({ count: diffDays });
  if (diffWeeks < 4) return m['notifications.relative_weeks']({ count: diffWeeks });
  if (diffMonths < 12) return m['notifications.relative_months']({ count: diffMonths });
  return m['notifications.relative_years']({ count: diffYears });
}

/**
 * Backwards-compat alias. Existing callers used `formatJaRelativeTime`; the
 * implementation is now locale-aware so the JA-specific name is misleading.
 * Re-exported only to avoid a sweeping rename in this commit.
 */
export const formatJaRelativeTime = formatRelativeTime;

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
