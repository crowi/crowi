'use client';

import { FileText, Bookmark } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { UserAvatar } from '@/components/user-avatar';
import type { UserPublic } from '@crowi/api-contract';

interface UserProfileProps {
  user: UserPublic;
  createdPagesCount: number;
  bookmarksCount: number;
}

export function UserProfile({ user, createdPagesCount, bookmarksCount }: UserProfileProps) {
  const displayName = user.name || user.username;

  return (
    <Card className="py-4">
      <CardContent>
        <div className="flex items-start gap-6">
          {/* Avatar */}
          <UserAvatar user={user} size="lg" className="flex-shrink-0" />

          {/* User Info */}
          <div className="flex-1 min-w-0">
            {/* Name and Username */}
            <h1 className="text-2xl font-bold text-foreground truncate">
              {displayName}
            </h1>
            <p className="text-muted-foreground">
              @{user.username}
            </p>

            {/* Introduction */}
            {user.introduction && (
              <p className="mt-3 text-foreground whitespace-pre-wrap">
                {user.introduction}
              </p>
            )}

            {/* Statistics */}
            <div className="flex items-center gap-6 mt-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <FileText className="h-4 w-4" />
                <span>
                  <span className="font-semibold text-foreground">{createdPagesCount}</span>
                  {' pages'}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Bookmark className="h-4 w-4" />
                <span>
                  <span className="font-semibold text-foreground">{bookmarksCount}</span>
                  {' bookmarks'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
