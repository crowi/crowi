'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { ErrorAlert } from '@/components/ui/error-alert';
import { AccessDeniedCard } from '@/components/ui/access-denied-card';
import { NotFoundCard } from '@/components/ui/not-found-card';
import { usePage } from '@/lib/use-page';

interface IdRedirectorProps {
  pageId: string;
}

export function IdRedirector({ pageId }: IdRedirectorProps) {
  const router = useRouter();
  const { page, isLoading, isError, error, notFound, notGranted } = usePage({ page_id: pageId });

  // Use replace (not push) so the id URL stays out of browser history.
  useEffect(() => {
    if (page?.path) {
      router.replace(page.path);
    }
  }, [page?.path, router]);

  if (page) {
    return <LoadingSpinner message={`Redirecting to ${page.path}...`} />;
  }

  if (isLoading) {
    return <LoadingSpinner message="Looking up page..." />;
  }

  if (notGranted) {
    return <AccessDeniedCard onGoBack={() => router.back()} />;
  }

  if (notFound) {
    return (
      <NotFoundCard
        title="Page Not Found"
        description={
          <>
            No page exists for id <code className="bg-muted px-2 py-0.5 rounded">{pageId}</code>.
          </>
        }
        body="The page may have been deleted or the link may be incorrect."
        actions={
          <div className="flex gap-2">
            <Button variant="default" onClick={() => router.push('/')}>
              Go Home
            </Button>
            <Button variant="outline" onClick={() => router.back()}>
              Go Back
            </Button>
          </div>
        }
      />
    );
  }

  if (isError) {
    return <ErrorAlert message={`Failed to look up page. ${error?.message || 'Please try again later.'}`} />;
  }

  return null;
}
