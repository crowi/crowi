import Link from 'next/link';
import { UserAvatar } from '@/components/user-avatar';
import type { resolveDisplayUser } from '@/lib/page-display-user';

type DisplayUser = NonNullable<ReturnType<typeof resolveDisplayUser>>;

/**
 * Avatar + (optionally `/user/<username>`-linked) display name for the user
 * credited on a page. Shared by the page meta-chip row and the portal header
 * so both render the provenance line identically. The name links to the user
 * page only when the resolved user carries a `username`; a bare id renders as
 * plain text.
 */
export function PageDisplayUserBadge({ user }: { user: DisplayUser }) {
  const username = 'username' in user ? user.username : null;
  return (
    <>
      <UserAvatar user={user} size="xs" />
      {username ? (
        <Link href={`/user/${username}`} className="text-foreground/80 hover:text-foreground hover:underline">
          {user.name}
        </Link>
      ) : (
        <span className="text-foreground/80">{user.name}</span>
      )}
    </>
  );
}
