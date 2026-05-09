'use client';

import { Mail } from 'lucide-react';
import { UserAvatar } from '@/components/user-avatar';

interface UserDropdownIdentityProps {
  user: {
    name?: string;
    username: string;
    email?: string;
    image?: string | null;
  };
}

export function UserDropdownIdentity({ user }: UserDropdownIdentityProps) {
  const displayName = user.name || user.username;
  return (
    <div className="flex flex-col items-center gap-1 px-3 pt-3 pb-2">
      <UserAvatar user={user} size="xl" className="mb-1" />
      <div className="text-primary font-semibold text-sm">{displayName}</div>
      {user.username && <div className="text-muted-foreground text-xs">@{user.username}</div>}
      {user.email && (
        <div className="text-muted-foreground text-xs flex items-center gap-1">
          <Mail className="h-3 w-3" />
          <span className="truncate max-w-[200px]">{user.email}</span>
        </div>
      )}
    </div>
  );
}
