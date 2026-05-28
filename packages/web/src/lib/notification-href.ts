import type { Notification } from '@crowi/api-contract';
import { NotificationActionEnum } from '@crowi/api-contract';
import { SCROLL_TARGETS } from './scroll-to-section';

/**
 * Build the in-app href to navigate to when a notification is opened.
 * COMMENT notifications append the comments-section hash so the page
 * scrolls straight to the discussion that triggered the notification;
 * other actions land on the page top as before. The hash uses the same
 * `SCROLL_TARGETS.COMMENTS` id the comments heading renders with, so
 * page-content's hash-watching MutationObserver picks it up once the
 * AST has rendered.
 */
export function resolveNotificationHref(notification: Pick<Notification, 'action' | 'target'>): string {
  const path = notification.target.path;
  if (notification.action === NotificationActionEnum.COMMENT) {
    return `${path}#${SCROLL_TARGETS.COMMENTS}`;
  }
  return path;
}
