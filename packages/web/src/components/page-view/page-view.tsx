'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { TocEntryResponse } from '@crowi/api-contract';
import { PageStatusEnum } from '@crowi/api-contract';
import { Edit2, FilePlus2, Info, Loader2, Trash2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { ErrorAlert } from '@/components/ui/error-alert';
import { AccessDeniedCard } from '@/components/ui/access-denied-card';
import { NotFoundCard } from '@/components/ui/not-found-card';
import { usePage } from '@/lib/use-page';
import { pagePathToHref } from '@/lib/page-path';
import { usePageGrantAccent } from '@/lib/use-page-grant-accent';
import { isStalePageRevision } from '@/lib/page-revision';
import { useRevertDeletedPage } from '@/lib/use-page-mutations';
import { useMarkSeenOnView } from '@/lib/use-seen';
import { PageHeader } from './page-header';
import { PageContent } from './page-content';
import { PageToc, useTocScrollSpy } from './page-toc';
import { cn } from '@/lib/utils';
import { StaleRevisionBanner } from './stale-revision-banner';
import { BacklinkList } from './backlink-list';
import { AttachmentList } from './attachment-list';
import { PageComments } from '@/components/page-comments';
import { m } from '@paraglide/messages.js';

// Stable empty array so PageToc's effect dep doesn't churn when meta.toc is absent.
const EMPTY_TOC: TocEntryResponse[] = [];

interface PageViewProps {
  path: string;
  /**
   * When set, fetch this specific revision and render the stale-revision
   * banner if it isn't the page's current latest. Driven by the
   * `?revision_id=...` query param on the catch-all route.
   */
  revisionId?: string;
}

export function PageView({ path, revisionId }: PageViewProps) {
  const router = useRouter();
  const { page, isLoading, isError, error, notFound, notGranted, redirectTo, isDeleted, refetch } = usePage({ path, revision_id: revisionId });
  const revertMutation = useRevertDeletedPage();

  const canMarkSeen = Boolean(page?._id) && !isLoading && !isError && !notFound && !notGranted && !isDeleted && !redirectTo;
  useMarkSeenOnView(page?._id, canMarkSeen);

  // TOC + its scroll-spy are computed here (before the early returns, so the
  // hook order stays stable) and shared by the right-rail `PageToc` and the
  // header `PageTocMenu`. `toc` is derived from the possibly-null page; the
  // hook no-ops for an empty list.
  const toc = page?.revision?.meta?.toc ?? EMPTY_TOC;
  const activeTocId = useTocScrollSpy(toc);

  useEffect(() => {
    if (redirectTo) {
      const redirectUrl = `${redirectTo}?redirectFrom=${encodeURIComponent(path)}`;
      router.replace(redirectUrl);
    }
  }, [redirectTo, path, router]);

  // Mirror the page's `grant` onto `<html data-page-grant=...>` so CSS
  // (`--page-grant-accent`) tints the header strip / chip / icons.
  usePageGrantAccent(page?.grant);

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
            <Button variant="default" onClick={() => router.push(`/_edit?path=${encodeURIComponent(path)}`)}>
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
            router.replace(pagePathToHref(restored.path));
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
            <PageHeader page={page} />
            <PageContent page={page} />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (page) {
    const hasToc = toc.length >= 2;
    const isStaleRevision = isStalePageRevision(page);
    // Drafts are creator-only and unpublished — strip the "social" affordances
    // (presence, comments) and swap the comments slot for an info notice that
    // tells the author the page isn't published yet. PageHeader / PageActionsMenu
    // independently hide like / watch / bookmark / link-share for the same reason.
    const isDraft = page.status === PageStatusEnum.DRAFT;
    const handleEdit = () => {
      router.push(`/_edit?page_id=${encodeURIComponent(page._id)}`);
    };
    return (
      // Escape the shared `max-w-4xl` main and center a
      // `[left spacer | content | TOC]` group on the full viewport. The
      // left spacer (≥1440) reserves the fixed nav rail's width so the
      // content stays dead-centre and symmetric at the 3-column width;
      // below 1440 it collapses and content + TOC re-centre as a pair;
      // below 1280 the TOC column hides (the header `PageTocMenu` takes
      // over). The right column stays reserved at ≥1440 even with no TOC
      // so a heading-light page is still symmetric. Margins/flex (no
      // transform) keep the `position: fixed` compact header viewport-
      // relative.
      <div className="mx-[calc(50%-50vw)] flex w-screen justify-center gap-6 px-4">
        <div aria-hidden className="hidden w-56 shrink-0 min-[1440px]:block" />
        <article className="w-full min-w-0 max-w-4xl space-y-12">
          {isStaleRevision && page.revision?._id && <StaleRevisionBanner pagePath={page.path} pageId={page._id} revisionId={page.revision._id} />}
          <PageHeader
            page={page}
            onEdit={handleEdit}
            showActions={!isStaleRevision}
            showPresence={!isStaleRevision && !isDraft}
            sticky={!isStaleRevision}
            toc={toc}
            activeTocId={activeTocId}
          />
          <PageContent page={page} />
          {!isStaleRevision && (
            <>
              <BacklinkList pageId={page._id} />
              <AttachmentList pageId={page._id} />
              {isDraft ? (
                <Alert className="items-center [&>svg]:translate-y-0">
                  <Info className="h-4 w-4" />
                  <div className="col-start-2 flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <AlertTitle>{m['page.draft_notice_title']()}</AlertTitle>
                      <AlertDescription>{m['page.draft_notice_body']()}</AlertDescription>
                    </div>
                    <Button variant="default" size="sm" onClick={handleEdit} className="shrink-0">
                      <Edit2 className="h-4 w-4 mr-1" />
                      {m['page.action_edit']()}
                    </Button>
                  </div>
                </Alert>
              ) : (
                <PageComments page={page} />
              )}
            </>
          )}
        </article>
        {/* Right column. With a TOC it shows from the 1280px rail
            breakpoint up; without one it still reserves width at ≥1440
            so the article stays symmetric against the left nav spacer. */}
        <div className={cn('w-56 shrink-0', hasToc ? 'hidden min-[1280px]:block' : 'hidden min-[1440px]:block')}>
          {hasToc && <PageToc toc={toc} activeId={activeTocId} />}
        </div>
      </div>
    );
  }

  return null;
}
