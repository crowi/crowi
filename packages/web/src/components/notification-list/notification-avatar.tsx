'use client';

import type { Notification } from '@crowi/api-contract';
import type { LucideIcon } from 'lucide-react';
import { AtSign, MessageSquare, Pencil, ThumbsUp } from 'lucide-react';
import { UserAvatar } from '@/components/user-avatar';
import { cn } from '@/lib/utils';

/**
 * The action verb behind a notification, expressed as a small glyph: a
 * comment bubble, thumbs-up, @-mention, or edit pencil. Rendered as a badge
 * over the action user's avatar so the row is scannable by event type at a
 * glance (the avatar says *who*, the badge says *what*).
 */
const ACTION_ICONS: Record<Notification['action'], LucideIcon> = {
  COMMENT: MessageSquare,
  LIKE: ThumbsUp,
  MENTION: AtSign,
  UPDATE: Pencil,
};

interface NotificationAvatarProps {
  user: Notification['actionUsers'][number] | undefined;
  action: Notification['action'];
  size: 'sm' | 'md';
}

const AVATAR_PLACEHOLDER = {
  sm: 'h-6 w-6',
  md: 'h-8 w-8',
} as const;

const BADGE = {
  sm: 'h-3.5 w-3.5 -right-1 -bottom-1',
  md: 'h-4 w-4 -right-1 -bottom-1',
} as const;

const BADGE_ICON = {
  sm: 'h-2 w-2',
  md: 'h-2.5 w-2.5',
} as const;

export function NotificationAvatar({ user, action, size }: NotificationAvatarProps) {
  const Icon = ACTION_ICONS[action];

  return (
    <div className="relative shrink-0">
      {user ? <UserAvatar user={user} size={size} /> : <div className={cn('rounded-full bg-muted', AVATAR_PLACEHOLDER[size])} aria-hidden />}
      <span
        className={cn('absolute flex items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border', BADGE[size])}
        aria-hidden
      >
        <Icon className={BADGE_ICON[size]} />
      </span>
    </div>
  );
}
