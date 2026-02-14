'use client';

import { use } from 'react';
import { notFound } from 'next/navigation';
import { Loader2, AlertCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UserProfile, UserRecentPages, UserBookmarks } from '@/components/user-page';
import { useUserPage } from '@/lib/use-user-page';

interface UserPageProps {
  params: Promise<{
    username: string;
  }>;
}

export default function UserPage({ params }: UserPageProps) {
  const { username } = use(params);
  const { data, isLoading, error } = useUserPage(username);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-2 text-muted-foreground">Loading user profile...</span>
      </div>
    );
  }

  if (error) {
    if (error.message === 'User not found') {
      notFound();
    }
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Failed to load user profile. Please try again later.
        </AlertDescription>
      </Alert>
    );
  }

  if (!data) {
    return null;
  }

  return (
    <div className="space-y-6">
      {/* Profile Card */}
      <UserProfile
        user={data.user}
        createdPagesCount={data.createdPagesCount}
        bookmarksCount={data.bookmarksCount}
      />

      {/* Content Tabs */}
      <Tabs defaultValue="pages" className="w-full">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="pages">Created Pages</TabsTrigger>
          <TabsTrigger value="bookmarks">Bookmarks</TabsTrigger>
        </TabsList>

        <TabsContent value="pages" className="mt-4">
          <UserRecentPages username={username} preview previewLimit={10} />
        </TabsContent>

        <TabsContent value="bookmarks" className="mt-4">
          <UserBookmarks username={username} preview previewLimit={10} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
