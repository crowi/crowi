'use client';

import BoringAvatar from 'boring-avatars';
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

const sizePx = {
  sm: 24,
  md: 32,
  lg: 80,
} as const;

const beamColors = ['#43676b', '#8eb39b', '#f0d264', '#e89a4d', '#d96d68'];

export function UserAvatar({ user, size = 'md', className }: UserAvatarProps) {
  const displayName = user.name || user.username;
  const seed = user.username || displayName;

  return (
    <Avatar className={cn(sizeClasses[size], className)}>
      {user.image ? <AvatarImage src={user.image} alt={displayName} /> : null}
      <AvatarFallback className="bg-transparent p-0" aria-label={displayName}>
        <BoringAvatar size={sizePx[size]} name={seed} variant="beam" colors={beamColors} />
      </AvatarFallback>
    </Avatar>
  );
}
