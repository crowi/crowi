'use client';

import { use } from 'react';
import Link from 'next/link';
import { ArrowLeft, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UserRecentPages } from '@/components/user-page';

interface RecentCreatePageProps {
  params: Promise<{
    username: string;
  }>;
}

export default function RecentCreatePage({ params }: RecentCreatePageProps) {
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
        <FileText className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">
          Pages by @{username}
        </h1>
      </div>

      {/* Pages List (full mode) */}
      <UserRecentPages username={username} />
    </div>
  );
}
