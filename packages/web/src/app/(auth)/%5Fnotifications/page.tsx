import { NotificationList } from '@/components/notification-list/notification-list';

/**
 * /_notifications — full notification list for the current user.
 *
 * The list itself is a client component (uses TanStack Query / router hooks),
 * so this page wrapper is intentionally minimal.
 */
export default function NotificationsPage() {
  return <NotificationList />;
}
