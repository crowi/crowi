'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Trash2, FilePlus2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { ErrorAlert } from '@/components/ui/error-alert';
import { AccessDeniedCard } from '@/components/ui/access-denied-card';
import { NotFoundCard } from '@/components/ui/not-found-card';
import { usePage } from '@/lib/use-page';
import { useRevertDeletedPage } from '@/lib/use-page-mutations';
import { useMarkSeenOnView } from '@/lib/use-seen';
import { PageHeader } from './page-header';
import { PageContent } from './page-content';
import { BacklinkList } from './backlink-list';
import { PageComments } from '@/components/page-comments';
import { m } from '@paraglide/messages.js';

interface PageViewProps {
  path: string;
}

export function PageView({ path }: PageViewProps) {
  const router = useRouter();
  const { page, isLoading, isError, error, notFound, notGranted, redirectTo, isDeleted, refetch } = usePage({ path });
  const revertMutation = useRevertDeletedPage();

  const canMarkSeen = Boolean(page?._id) && !isLoading && !isError && !notFound && !notGranted && !isDeleted && !redirectTo;
  useMarkSeenOnView(page?._id, canMarkSeen);

  useEffect(() => {
    if (redirectTo) {
      const redirectUrl = `${redirectTo}?redirectFrom=${encodeURIComponent(path)}`;
      router.replace(redirectUrl);
    }
  }, [redirectTo, path, router]);

  if (isLoading) {
    return <LoadingSpinner message={m['page.loading']()} />;
  }

  if (redirectTo) {
    return <LoadingSpinner message={m['page.redirecting']({ path: redirectTo })} />;
  }

  if (isError) {
    return <ErrorAlert message={m['page.failed_to_load']({ message: error?.message || m['common.try_again_later']() })} onRetry={() => refetch()} />;
  }

  if (notGranted) {
    return <AccessDeniedCard onGoBack={() => router.back()} />;
  }

  if (notFound) {
    return (
      <NotFoundCard
        title={m['page.not_found_title']()}
        icon={FilePlus2}
        iconClassName="text-primary"
        description={
          <>
            <code className="bg-muted px-2 py-0.5 rounded">{path}</code>
            <span className="ml-1">{m['page.not_found_description']()}</span>
          </>
        }
        body={m['page.not_found_body']()}
        actions={
          <div className="flex gap-2">
            <Button variant="default" onClick={() => router.push(`/edit?path=${encodeURIComponent(path)}`)}>
              <FilePlus2 className="h-4 w-4 mr-2" />
              {m['page.create_page']()}
            </Button>
            <Button variant="outline" onClick={() => router.back()}>
              {m['common.go_back']()}
            </Button>
          </div>
        }
      />
    );
  }

  if (page && isDeleted) {
    const handleRestore = () => {
      revertMutation.mutate(
        { page_id: page._id },
        {
          onSuccess: (restored) => {
            router.replace(restored.path);
          },
        },
      );
    };

    return (
      <div className="space-y-4">
        <Alert className="border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20">
          <Trash2 className="h-4 w-4 text-red-500" />
          <AlertTitle className="text-red-700 dark:text-red-400">{m['page.deleted_alert_title']()}</AlertTitle>
          <AlertDescription className="text-red-600 dark:text-red-300">
            {m['page.deleted_alert_description']()}
            <div className="mt-3">
              <Button
                variant="outline"
                size="sm"
                className="border-red-300 text-red-700 hover:bg-red-100 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/40"
                onClick={handleRestore}
                disabled={revertMutation.isPending}
              >
                {revertMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    {m['page.restoring']()}
                  </>
                ) : (
                  m['page.restore']()
                )}
              </Button>
              {revertMutation.isError && revertMutation.error instanceof Error && (
                <p className="mt-2 text-sm text-red-700 dark:text-red-400" role="alert">
                  {revertMutation.error.message}
                </p>
              )}
            </div>
          </AlertDescription>
        </Alert>

        <Card className="opacity-75">
          <CardContent className="pt-6">
            <PageHeader page={page} showSeenUsers={false} />
            <PageContent page={page} />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (page) {
    return (
      <Card>
        <CardContent className="pt-6">
          <PageHeader
            page={page}
            onEdit={() => {
              router.push(`/edit?page_id=${encodeURIComponent(page._id)}`);
            }}
            showActions
          />
          <PageContent page={page} />
          <BacklinkList pageId={page._id} />
          <PageComments page={page} />
        </CardContent>
      </Card>
    );
  }

  return null;
}
