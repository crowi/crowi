import type { Notification } from '@crowi/api-contract';

/**
 * Format a date string to a Japanese relative time string.
 * (e.g., "数秒前", "5 分前", "2 時間前")
 *
 * i18n is intentionally out of scope — strings are hardcoded in Japanese to
 * match the rest of the (auth) header UI for now.
 */
export function formatJaRelativeTime(dateString: string): string {
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

  if (diffSecs < 60) return '数秒前';
  if (diffMins < 60) return `${diffMins} 分前`;
  if (diffHours < 24) return `${diffHours} 時間前`;
  if (diffDays < 7) return `${diffDays} 日前`;
  if (diffWeeks < 4) return `${diffWeeks} 週間前`;
  if (diffMonths < 12) return `${diffMonths} ヶ月前`;
  return `${diffYears} 年前`;
}

/**
 * Build a human-readable notification text in Japanese.
 *
 * Templates:
 *   - 1 user:    `{user1} さんが「{pagePath}」に{action}しました`
 *   - N users:   `{user1} さん他 {N-1} 名が「{pagePath}」に{action}しました`
 *
 * Action verbs:
 *   - COMMENT: コメント
 *   - LIKE:    いいね
 */
export function buildNotificationMessage(notification: Notification): string {
  const { actionUsers, target, action } = notification;
  const firstUser = actionUsers[0];
  const userLabel = firstUser ? firstUser.name || firstUser.username : '誰か';
  const userPart = actionUsers.length > 1 ? `${userLabel} さん他 ${actionUsers.length - 1} 名` : `${userLabel} さん`;

  const actionLabel = action === 'COMMENT' ? 'コメント' : 'いいね';
  return `${userPart}が「${target.path}」に${actionLabel}しました`;
}

/**
 * Returns true when the notification has not been opened by the user yet.
 * UNREAD: never seen in any list. UNOPENED: seen in a list but not opened.
 * OPENED: viewed (target page navigated to).
 */
export function isUnopenedNotification(notification: Pick<Notification, 'status'>): boolean {
  return notification.status === 'UNREAD' || notification.status === 'UNOPENED';
}
