'use client';

import Link from 'next/link';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { UserAvatar } from '@/components/user-avatar';
import { useUserPage } from '@/lib/use-user-page';
import { cn } from '@/lib/utils';

const MENTION_CLASS = 'text-primary font-medium underline-offset-[3px] transition-colors';

/**
 * View-time rendering of an `@username` mention (the RFC-0002 mention
 * transform stamps `className="mention"` on a `/user/<username>` link).
 *
 * Renders the user's avatar + `@username`, with the display name shown
 * in a hover tooltip. The stored AST carries only the username, so the
 * avatar + name are hydrated client-side via `useUserPage` — react-query
 * caches and de-dupes the lookup per username, so a page that mentions
 * the same person many times still fetches them once.
 *
 * When the username has no account (`useUserPage` 404s) — or while it is
 * still resolving — it renders as plain `@username` text, NOT a link, so a
 * non-mention like `@2000円` never points at a non-existent `/user/2000`.
 */
export function MentionLink({ username }: { username: string }) {
  const { data } = useUserPage(username);
  const user = data?.user;
  const href = `/user/${username}`;

  if (!user) {
    return <span className="font-medium">@{username}</span>;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link href={href} className={cn(MENTION_CLASS, 'inline-flex items-center gap-1 align-middle no-underline hover:underline')}>
          <UserAvatar user={user} size="xs" className="shrink-0" />@{username}
        </Link>
      </TooltipTrigger>
      <TooltipContent>{user.name || username}</TooltipContent>
    </Tooltip>
  );
}
