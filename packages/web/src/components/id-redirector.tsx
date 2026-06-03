'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { ErrorAlert } from '@/components/ui/error-alert';
import { AccessDeniedCard } from '@/components/ui/access-denied-card';
import { NotFoundCard } from '@/components/ui/not-found-card';
import { usePage } from '@/lib/use-page';
import { pagePathToHref } from '@/lib/page-path';
import { m } from '@paraglide/messages.js';

interface IdRedirectorProps {
  pageId: string;
}

export function IdRedirector({ pageId }: IdRedirectorProps) {
  const router = useRouter();
  const { page, isLoading, isError, error, notFound, notGranted } = usePage({ page_id: pageId });

  // Use replace (not push) so the id URL stays out of browser history.
  useEffect(() => {
    if (page?.path) {
      router.replace(pagePathToHref(page.path));
    }
  }, [page?.path, router]);

  if (page) {
    return <LoadingSpinner message={m['page.redirecting']({ path: page.path })} />;
  }

  if (isLoading) {
    return <LoadingSpinner message={m['page.id_redirector_looking_up']()} />;
  }

  if (notGranted) {
    return <AccessDeniedCard onGoBack={() => router.back()} />;
  }

  if (notFound) {
    return (
      <NotFoundCard
        title={m['page.not_found_title']()}
        description={
          <>
            <code className="bg-muted px-2 py-0.5 rounded">{pageId}</code>
            <span className="ml-1">{m['page.id_redirector_not_found_description']()}</span>
          </>
        }
        body={m['page.id_redirector_not_found_body']()}
        actions={
          <div className="flex gap-2">
            <Button variant="default" onClick={() => router.push('/')}>
              {m['common.go_home']()}
            </Button>
            <Button variant="outline" onClick={() => router.back()}>
              {m['common.go_back']()}
            </Button>
          </div>
        }
      />
    );
  }

  if (isError) {
    return <ErrorAlert message={m['page.id_redirector_failed']({ message: error?.message || m['common.try_again_later']() })} />;
  }

  return null;
}
