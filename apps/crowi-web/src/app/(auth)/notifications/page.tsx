import { NotificationList } from '@/components/notification-list/notification-list';

/**
 * /notifications — full notification list for the current user.
 *
 * The list itself is a client component (uses TanStack Query / router hooks),
 * so this page wrapper is intentionally minimal.
 */
export default function NotificationsPage() {
  return <NotificationList />;
}
