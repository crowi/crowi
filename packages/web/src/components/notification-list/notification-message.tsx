'use client';

import type { Notification } from '@crowi/api-contract';
import { buildNotificationMessage, splitMessageSegments } from '@/lib/notification-format';

/**
 * Renders a notification's human-readable message with the page name and the
 * action verb emphasised in bold (the `**...**` runs the message templates
 * mark — see `splitMessageSegments`). Shared by the bell dropdown and the
 * full notification list so both surfaces emphasise the same parts.
 */
export function NotificationMessage({ notification }: { notification: Notification }) {
  const segments = splitMessageSegments(buildNotificationMessage(notification));
  return (
    <>
      {segments.map((segment, i) =>
        segment.bold ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are a stable render-only split of one string
          <strong key={i} className="font-semibold text-foreground">
            {segment.text}
          </strong>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are a stable render-only split of one string
          <span key={i}>{segment.text}</span>
        ),
      )}
    </>
  );
}
