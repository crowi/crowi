'use client';

import { use } from 'react';
import { notFound, useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { ErrorAlert } from '@/components/ui/error-alert';
import { UserProfile, UserRecentPages, UserBookmarks } from '@/components/user-page';
import { PageHeader, PageContent } from '@/components/page-view';
import { useUserPage } from '@/lib/use-user-page';
import { usePage } from '@/lib/use-page';
import { m } from '@paraglide/messages.js';

interface UserPageProps {
  params: Promise<{
    username: string;
  }>;
}

export default function UserPage({ params }: UserPageProps) {
  const { username } = use(params);
  const router = useRouter();
  const { data, isLoading, error } = useUserPage(username);

  // Crowi convention: a wiki page may live at /user/<username>. When it
  // exists, render its content alongside the profile (the legacy app did
  // the same — the user-page route is a normal wiki page that just happens
  // to default to the profile view).
  const userPagePath = `/user/${username}`;
  const { page: userPageDoc, notFound: userPageNotFound } = usePage({ path: userPagePath });

  if (isLoading) {
    return <LoadingSpinner message={m['user_page.loading_profile']()} className="py-12" />;
  }

  if (error) {
    if (error.message === 'User not found') {
      notFound();
    }
    return <ErrorAlert message={m['user_page.failed_to_load_profile']()} />;
  }

  if (!data) {
    return null;
  }

  return (
    <div className="space-y-6">
      {/* Profile Card */}
      <UserProfile user={data.user} createdPagesCount={data.createdPagesCount} bookmarksCount={data.bookmarksCount} />

      {/* Page document at /user/<username>, if any */}
      {userPageDoc && !userPageNotFound && (
        <Card>
          <CardContent className="pt-6">
            <PageHeader page={userPageDoc} onEdit={() => router.push(`/_edit?page_id=${encodeURIComponent(userPageDoc._id)}`)} showActions />
            <PageContent page={userPageDoc} />
          </CardContent>
        </Card>
      )}

      {/* Content Tabs */}
      <Tabs defaultValue="pages" className="w-full">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="pages">{m['user_page.tab_pages']()}</TabsTrigger>
          <TabsTrigger value="bookmarks">{m['user_page.tab_bookmarks']()}</TabsTrigger>
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
