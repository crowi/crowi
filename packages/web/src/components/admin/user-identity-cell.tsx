import type { UserPublic } from '@crowi/api-contract';
import { UserAvatar } from '@/components/user-avatar';

type IdentityUser = Pick<UserPublic, 'name' | 'username' | 'email' | 'image'>;

/**
 * Avatar + display name + `@username · email` block shared by the admin user
 * table and the user-approval queue, so both render a user identically.
 */
export function UserIdentityCell({ user }: { user: IdentityUser }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <UserAvatar user={{ name: user.name, username: user.username, image: user.image ?? null }} size="sm" />
      <div className="min-w-0 leading-tight">
        <div className="font-medium">{user.name || user.username}</div>
        <div className="text-muted-foreground text-xs truncate">
          @{user.username}
          {user.email && (
            <>
              <span className="mx-1.5 opacity-50">·</span>
              <span className="font-mono">{user.email}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
