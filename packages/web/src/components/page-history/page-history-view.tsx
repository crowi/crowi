'use client';

import { useRouter } from 'next/navigation';
import { ArrowLeft, FilePlus2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { ErrorAlert } from '@/components/ui/error-alert';
import { AccessDeniedCard } from '@/components/ui/access-denied-card';
import { NotFoundCard } from '@/components/ui/not-found-card';
import { Breadcrumb } from '@/components/breadcrumb';
import { pagePathToHref } from '@/lib/page-path';
import { usePage } from '@/lib/use-page';
import { PageHistory } from './page-history';
import { m } from '@paraglide/messages.js';

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
    return <LoadingSpinner message={m['page_history.loading']()} />;
  }

  if (isError) {
    return <ErrorAlert message={m['page_history.failed_to_load']({ message: error?.message || m['common.try_again_later']() })} onRetry={() => refetch()} />;
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
          </>
        }
        body={m['page_history.not_found_body']()}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => router.back()}>
              {m['common.go_back']()}
            </Button>
          </div>
        }
      />
    );
  }

  if (!page) {
    return null;
  }

  // No card frame around the screen body: the history view is full-bleed
  // (`_history/layout.tsx` escapes the centred column), so a card's border +
  // px-6 only shrink the diff's usable width. The gutters come from the
  // layout instead, and the table / diff keep their own borders as the
  // frames that actually delimit content.
  return (
    <div className="space-y-4">
      <div>
        <Breadcrumb path={page.path} />
        <div className="mt-2">
          <Button variant="ghost" size="sm" onClick={() => router.push(pagePathToHref(page.path))} type="button" className="-ml-2">
            <ArrowLeft className="h-4 w-4 mr-1" />
            {m['page_history.back_to_page']()}
          </Button>
        </div>
      </div>
      <PageHistory pageId={page._id} pagePath={page.path} />
    </div>
  );
}
