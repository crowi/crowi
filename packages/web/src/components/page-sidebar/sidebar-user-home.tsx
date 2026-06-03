'use client';

import { UserAvatar } from '@/components/user-avatar';
import { useUserPage } from '@/lib/use-user-page';
import { SidebarRow } from './sidebar-row';

/**
 * The user-home node that tops a user space in the sidebar. Shows the
 * user's avatar (uploaded image, else the boring-avatars fallback) so the
 * row reads as "this person's pages". Links to the user's my-page.
 *
 * `useUserPage` is cached by username and shared with the user-page route,
 * so this rarely costs an extra request; until it resolves (or if the user
 * can't be loaded) the avatar falls back to the username-seeded boring
 * avatar.
 */
export function SidebarUserHome({ username, isCurrent, isOpen }: { username: string; isCurrent?: boolean; isOpen?: boolean }) {
  const { data } = useUserPage(username);
  const user = data?.user ?? { username };

  return (
    <SidebarRow
      href={`/user/${username}`}
      label={`${username}/`}
      leading={<UserAvatar user={user} size="xs" className="shrink-0" />}
      depth={0}
      isCurrent={isCurrent}
      isOpen={isOpen}
    />
  );
}
