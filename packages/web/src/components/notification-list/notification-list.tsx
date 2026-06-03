'use client';

import { useRouter } from 'next/navigation';
import { AlertCircle, Bell, Loader2 } from 'lucide-react';
import type { Notification } from '@crowi/api-contract';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useMarkAllAsRead, useNotificationsInfinite, useOpenNotification, useUnreadCount } from '@/lib/use-notifications';
import { resolveNotificationHref } from '@/lib/notification-href';
import { scrollToSectionWhenReady, SCROLL_TARGETS } from '@/lib/scroll-to-section';
import { NotificationActionEnum } from '@crowi/api-contract';
import { usePageTitle } from '@/lib/use-page-title';
import { NotificationItem } from './notification-item';
import { m } from '@paraglide/messages.js';

const PAGE_SIZE = 20;

/**
 * Full-page notification list shown at /_notifications.
 *
 * - Uses useInfiniteQuery to accumulate pages (matches the user bookmarks UI).
 * - Header has a "すべて既読にする" button which is disabled when there are
 *   no unopened notifications.
 * - Each item, on click, transitions the notification to OPENED and navigates
 *   to the target page (mirrors the dropdown bell behavior).
 */
export function NotificationList() {
  const router = useRouter();
  usePageTitle(m['notifications.title']());
  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useNotificationsInfinite(PAGE_SIZE);
  const { data: unreadCount = 0 } = useUnreadCount();
  const markAllAsRead = useMarkAllAsRead();
  const openNotification = useOpenNotification();

  const allNotifications: Notification[] = data?.pages.flatMap((page) => page.notifications) ?? [];
  const hasUnread = unreadCount > 0;

  const handleOpenNotification = async (notification: Notification) => {
    try {
      await openNotification.mutateAsync(notification._id);
    } catch {
      // Even if marking as opened failed, still navigate to the target page so
      // the user is not blocked by a transient error (parity with bell dropdown).
    }
    // `scroll: false` so Next.js doesn't jump-to-top while the target
    // heading is still being rendered; page-content's hash-watching
    // MutationObserver does the in-page scroll once the AST lands.
    router.push(resolveNotificationHref(notification), { scroll: false });
    // Same caveat as notification-bell: hash-watch only re-runs on
    // an actual hashchange; drive the scroll manually for COMMENT
    // actions so same-pathname/same-hash clicks still land properly.
    if (notification.action === NotificationActionEnum.COMMENT) {
      scrollToSectionWhenReady(SCROLL_TARGETS.COMMENTS);
    }
  };

  const handleMarkAllAsRead = () => {
    markAllAsRead.mutate();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Bell className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold">{m['notifications.title']()}</h1>
        </div>
        <Button variant="outline" size="sm" onClick={handleMarkAllAsRead} disabled={!hasUnread || markAllAsRead.isPending}>
          {markAllAsRead.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              {m['notifications.processing']()}
            </>
          ) : (
            m['notifications.mark_all_read']()
          )}
        </Button>
      </div>

      {/* Body */}
      {isLoading ? (
        <Card className="divide-y gap-0 py-0 overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <NotificationSkeletonRow key={i} />
          ))}
        </Card>
      ) : error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{m['notifications.failed_to_load']()}</AlertDescription>
        </Alert>
      ) : allNotifications.length === 0 ? (
        <Card className="p-12 text-center">
          <Bell className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-muted-foreground">{m['notifications.empty']()}</p>
        </Card>
      ) : (
        <>
          <Card className="divide-y gap-0 py-0 overflow-hidden">
            {allNotifications.map((notification) => (
              <NotificationItem key={notification._id} notification={notification} onOpen={handleOpenNotification} />
            ))}
          </Card>

          {hasNextPage ? (
            <div className="text-center">
              <Button variant="outline" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    {m['notifications.loading_more']()}
                  </>
                ) : (
                  m['notifications.load_more']()
                )}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Lightweight inline skeleton row used while the first page is loading.
 *
 * shadcn's <Skeleton/> is not currently included in this project's ui kit,
 * so we render an equivalent shape using plain Tailwind animate-pulse blocks
 * to avoid pulling in a new dependency for this single use site.
 */
function NotificationSkeletonRow() {
  return (
    <div className="flex w-full items-start gap-4 px-4 py-4">
      <div className="mt-0.5 h-8 w-8 shrink-0 rounded-full bg-muted animate-pulse" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="h-4 w-3/4 rounded bg-muted animate-pulse" aria-hidden />
        <div className="h-3 w-24 rounded bg-muted animate-pulse" aria-hidden />
      </div>
    </div>
  );
}
