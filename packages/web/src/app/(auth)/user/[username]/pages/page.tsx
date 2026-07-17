'use client';

import { use } from 'react';
import Link from 'next/link';
import { ArrowLeft, FolderTree } from 'lucide-react';
import { m } from '@paraglide/messages.js';
import { Button } from '@/components/ui/button';
import { UserSubpages } from '@/components/user-page';
import { usePageTitle } from '@/lib/use-page-title';

interface SubpagesPageProps {
  params: Promise<{
    username: string;
  }>;
}

export default function SubpagesPage({ params }: SubpagesPageProps) {
  const { username } = use(params);

  usePageTitle(username);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/user/${username}`}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {m['user_page.back_to_profile']()}
          </Link>
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <FolderTree className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">
          {m['user_page.tab_subpages']()} — @{username}
        </h1>
      </div>

      {/* Subpages List (full mode) */}
      <UserSubpages username={username} />
    </div>
  );
}
