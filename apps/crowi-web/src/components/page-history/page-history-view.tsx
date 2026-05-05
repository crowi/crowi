'use client';

import { useRouter } from 'next/navigation';
import { ArrowLeft, FilePlus2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { ErrorAlert } from '@/components/ui/error-alert';
import { AccessDeniedCard } from '@/components/ui/access-denied-card';
import { NotFoundCard } from '@/components/ui/not-found-card';
import { Breadcrumb } from '@/components/breadcrumb';
import { usePage } from '@/lib/use-page';
import { PageHistory } from './page-history';

interface PageHistoryViewProps {
  // page を特定するためのオリジナルパス (URL 末尾の '/history' を除いたもの)
  path: string;
}

/**
 * Container for the revision-history screen. Loads the page metadata via
 * usePage so we get the same not-found / not-granted / loading UX as PageView.
 */
export function PageHistoryView({ path }: PageHistoryViewProps) {
  const router = useRouter();
  const { page, isLoading, isError, error, notFound, notGranted, refetch } = usePage({ path });

  if (isLoading) {
    return <LoadingSpinner message="Loading page..." />;
  }

  if (isError) {
    return <ErrorAlert message={`Failed to load page. ${error?.message || 'Please try again later.'}`} onRetry={() => refetch()} />;
  }

  if (notGranted) {
    return <AccessDeniedCard onGoBack={() => router.back()} />;
  }

  if (notFound) {
    return (
      <NotFoundCard
        title="Page Not Found"
        icon={FilePlus2}
        iconClassName="text-primary"
        description={
          <>
            The page <code className="bg-muted px-2 py-0.5 rounded">{path}</code> does not exist.
          </>
        }
        body="履歴を表示するページが見つかりませんでした。"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => router.back()}>
              Go Back
            </Button>
          </div>
        }
      />
    );
  }

  if (!page) {
    return null;
  }

  return (
    <Card>
      <CardContent className="pt-6 space-y-4">
        <div>
          <Breadcrumb path={page.path} />
          <div className="mt-2">
            <Button variant="ghost" size="sm" onClick={() => router.push(page.path)} type="button" className="-ml-2">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back to page
            </Button>
          </div>
        </div>
        <PageHistory pageId={page._id} pagePath={page.path} />
      </CardContent>
    </Card>
  );
}
