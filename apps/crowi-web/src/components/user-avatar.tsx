'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

interface UserAvatarProps {
  user: {
    name?: string;
    username: string;
    image?: string | null;
  };
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeClasses = {
  sm: 'h-6 w-6',
  md: 'h-8 w-8',
  lg: 'h-20 w-20',
} as const;

const textSizeClasses = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-2xl',
} as const;

export function UserAvatar({ user, size = 'md', className }: UserAvatarProps) {
  const displayName = user.name || user.username;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <Avatar className={cn(sizeClasses[size], className)}>
      {user.image ? <AvatarImage src={user.image} alt={displayName} /> : null}
      <AvatarFallback className={cn('!bg-[#43676b] !text-white font-semibold', textSizeClasses[size])}>{initials}</AvatarFallback>
    </Avatar>
  );
}
