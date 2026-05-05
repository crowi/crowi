'use client';

import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowLeft, FilePlus2, Loader2, Lock } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-3 text-muted-foreground">Loading page...</span>
      </div>
    );
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>
          Failed to load page. {error?.message || 'Please try again later.'}
          <Button variant="outline" size="sm" className="ml-4" onClick={() => refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (notGranted) {
    return (
      <Card className="border-amber-200 dark:border-amber-800">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Lock className="h-5 w-5 text-amber-500" />
            <CardTitle>Access Denied</CardTitle>
          </div>
          <CardDescription>You do not have permission to view this page.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">This page is private or you need to be granted access by the owner.</p>
          <div className="mt-4">
            <Button variant="outline" onClick={() => router.back()}>
              Go Back
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (notFound) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <FilePlus2 className="h-5 w-5 text-primary" />
            <CardTitle>Page Not Found</CardTitle>
          </div>
          <CardDescription>
            The page <code className="bg-muted px-2 py-0.5 rounded">{path}</code> does not exist.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground mb-4">履歴を表示するページが見つかりませんでした。</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => router.back()}>
              Go Back
            </Button>
          </div>
        </CardContent>
      </Card>
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
