'use client';

import { use } from 'react';
import Link from 'next/link';
import { ArrowLeft, Bookmark } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UserBookmarks } from '@/components/user-page';

interface BookmarksPageProps {
  params: Promise<{
    username: string;
  }>;
}

export default function BookmarksPage({ params }: BookmarksPageProps) {
  const { username } = use(params);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/user/${username}`}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to profile
          </Link>
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <Bookmark className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">
          Bookmarks by @{username}
        </h1>
      </div>

      {/* Bookmarks List (full mode) */}
      <UserBookmarks username={username} />
    </div>
  );
}
