'use client';

import type { PageWithRevision, PresencePageUpdatedMessage, TocEntryResponse } from '@crowi/api-contract';
import { PageStatusEnum } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { useQueryClient } from '@tanstack/react-query';
import { Edit2, FilePlus2, Info, Loader2, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useReducer, useRef, useState } from 'react';
import { PageComments } from '@/components/page-comments';
import { AccessDeniedCard } from '@/components/ui/access-denied-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorAlert } from '@/components/ui/error-alert';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { NotFoundCard } from '@/components/ui/not-found-card';
import { apiClientV2 } from '@/lib/api-client';
import { isUserHomePath, pagePathToHref } from '@/lib/page-path';
import { isStalePageRevision } from '@/lib/page-revision';
import { useAuth } from '@/lib/use-auth';
import { usePage } from '@/lib/use-page';
import { usePageChildren } from '@/lib/use-page-children';
import { usePageGrantAccent } from '@/lib/use-page-grant-accent';
import { useRevertDeletedPage } from '@/lib/use-page-mutations';
import { usePresence } from '@/lib/use-presence';
import { useMarkSeenOnView } from '@/lib/use-seen';
import { AttachmentList } from './attachment-list';
import { BacklinkList } from './backlink-list';
import { LiveSyncBanner } from './live-sync-banner';
import { initialLiveSyncBannerState, isDisplayingOld, reduceLiveSyncBanner } from './live-sync-banner-state';
import { PageContent } from './page-content';
import { PageHeader } from './page-header';
import { useTocScrollSpy } from './page-toc';
import { PageTocColumns } from './page-toc-columns';
import { PortalizeBanner } from './portalize-dialog';
import { StaleRevisionBanner } from './stale-revision-banner';

// Debounce window (ms) coalescing a burst of `page-updated` frames into a
// single body swap. Inside 200–500ms per the spec; mirrors the
// notifications-socket invalidate debounce.
const LIVE_SYNC_DEBOUNCE_MS = 300;

/** The wrapper shape `usePage`'s queryFn stores under `['page', params]`. */
type PageQueryData = { page: PageWithRevision | null; notFound: boolean; notGranted: boolean };

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

  // Does this content page have descendants (`/path/...`)? If so it can be
  // turned into a portal that indexes them. Querying the portal-path children
  // shares the sidebar's cache key (deduped — no extra request), so this is
  // effectively free. Disabled until the page resolves and isn't deleted.
  const childrenPath = path.endsWith('/') ? path : `${path}/`;
  const { data: childrenData } = usePageChildren(childrenPath, { enabled: !!page && !isDeleted });
  const hasDescendants = (childrenData?.children?.length ?? 0) > 0;

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

  // ── feature-live-page-content-sync — read-side soft-refresh ──────────
  // All swap state is owned here (PageView owns `page` + the query cache).
  // `usePresence` is called exactly once, at PageView level, so a single
  // `/presence` WebSocket is shared with PageHeader / LivePresenceRow via
  // the `presence` prop — opening a second socket here would regress the
  // 2-3s viewer-list lag the header lift originally fixed.
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [bannerState, dispatchBanner] = useReducer(reduceLiveSyncBanner, initialLiveSyncBannerState);
  // The pre-swap wrapper, rendered locally while "reading the previous
  // version". Kept in state (not a ref) so it is render-visible; the
  // `['page']` cache is never rewound to it (see spec §view-state).
  const [snapshot, setSnapshot] = useState<PageQueryData | null>(null);
  // Newest revision id / editor seen; also serves as the "latest
  // available" target while displaying an old version.
  const latestSeenRevisionIdRef = useRef<string | null>(null);
  const latestEditorRef = useRef<string | null>(null);
  const debounceTimerRef = useRef<number | null>(null);

  // The live query key is path-based (live view ⇒ `revision_id` undefined),
  // identical to the one `usePage` registers. Shared so `getQueryData` /
  // `setQueryData` can never drift apart (a mismatch no-ops the swap).
  const pageQueryKey = ['page', { path, revision_id: revisionId }];
  const readWrapper = (): PageQueryData | undefined => queryClient.getQueryData<PageQueryData>(pageQueryKey);

  /**
   * Fetch the target revision's body and swap it into the cache with a
   * shallow-merge that preserves page-level fields (grant / liker /
   * commentCount / …). Guarded by a `revision.createdAt` monotonicity
   * check so an out-of-order / stale fetch never rewinds the cache.
   * Returns whether the cache was actually advanced.
   */
  const swapToRevision = async (targetRevisionId: string): Promise<boolean> => {
    const cachedPage = readWrapper()?.page;
    if (!cachedPage) return false;

    let fetchedRevision: PageWithRevision['revision'];
    try {
      const response = await apiClientV2.pages.revisions[':id'].$get({ param: { id: targetRevisionId } });
      if (!response.ok) return false;
      fetchedRevision = (await response.json()).revision;
    } catch {
      // A 404 (revision gone / grant lost — body stays protected) or a
      // transient error: skip the swap, current view is preserved.
      return false;
    }

    // Monotonicity guard (ms resolution) — only advance to a strictly
    // newer revision. Uses `createdAt`, not ObjectId order, so a
    // cross-instance same-second save cannot rewind the cache.
    const cachedTime = Date.parse(cachedPage.revision.createdAt);
    const fetchedTime = Date.parse(fetchedRevision.createdAt);
    if (!(fetchedTime > cachedTime)) return false;

    // Capture the version currently shown BEFORE writing, so "read the
    // previous version" renders the true pre-swap body.
    setSnapshot({ page: cachedPage, notFound: false, notGranted: false });

    const scrollY = typeof window !== 'undefined' ? window.scrollY : 0;
    const newPage: PageWithRevision = { ...cachedPage, revision: fetchedRevision, latestRevision: fetchedRevision._id };
    queryClient.setQueryData<PageQueryData>(pageQueryKey, { page: newPage, notFound: false, notGranted: false });

    // Restore scroll after React commits + the browser paints the new
    // body, so the reader's position is preserved across the swap.
    if (typeof window !== 'undefined') {
      requestAnimationFrame(() => window.scrollTo(0, scrollY));
    }
    return true;
  };

  const performForwardSwap = async (): Promise<void> => {
    const target = latestSeenRevisionIdRef.current;
    if (!target) return;
    const editorDisplayName = latestEditorRef.current ?? '';
    if (await swapToRevision(target)) {
      dispatchBanner({ type: 'swapped', editorDisplayName });
    }
  };

  const scheduleForwardSwap = (): void => {
    // In-flight guard (mirrors use-notifications-socket): the first frame
    // of a burst schedules the single swap; later frames only update the
    // `latestSeen*` refs the timer reads when it fires.
    if (debounceTimerRef.current !== null) return;
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      void performForwardSwap();
    }, LIVE_SYNC_DEBOUNCE_MS);
  };

  // Handed to `usePresence`; already self-suppressed (editor !== self).
  const handlePageUpdated = (payload: PresencePageUpdatedMessage): void => {
    latestSeenRevisionIdRef.current = payload.revisionId;
    latestEditorRef.current = payload.editorDisplayName;
    if (isDisplayingOld(bannerState)) {
      // The reader chose the old version — never auto-advance the cache;
      // just escalate the banner to "an even newer version was saved".
      dispatchBanner({ type: 'newer-while-old', editorDisplayName: payload.editorDisplayName });
      return;
    }
    scheduleForwardSwap();
  };

  const presenceEnabled = Boolean(page) && !isStalePageRevision(page) && page?.status !== PageStatusEnum.DRAFT && isAuthenticated;
  const presence = usePresence(presenceEnabled && page ? page._id : null, { onPageUpdated: handlePageUpdated });

  const handleReadOld = (): void => dispatchBanner({ type: 'read-old' });
  const handleShowLatest = (): void => {
    void (async () => {
      // Only `showing-latest-again` is behind the cache (newer saves
      // arrived while showing old); `showing-old`'s cache is already the
      // latest, so switching the view is enough. Advance the cache first
      // and flip the view ONLY if it succeeds — otherwise the banner would
      // claim "latest" while the cache is still behind. A failed fetch
      // keeps `showing-latest-again` so the reader can retry.
      if (bannerState.kind === 'showing-latest-again') {
        const target = latestSeenRevisionIdRef.current;
        if (!target || !(await swapToRevision(target))) return;
      }
      dispatchBanner({ type: 'show-latest' });
    })();
  };
  const handleDismiss = (): void => dispatchBanner({ type: 'dismiss' });

  // SPA navigation swaps the `path` prop WITHOUT remounting PageView, so
  // reset every live-sync view-state or page X's banner / snapshot would
  // bleed into page Y. (`usePresence` self-resets on `pageId` change.)
  useEffect(() => {
    dispatchBanner({ type: 'dismiss' });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSnapshot(null);
    latestSeenRevisionIdRef.current = null;
    latestEditorRef.current = null;
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, [path]);

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
    const isStaleRevision = isStalePageRevision(page);
    // Drafts are creator-only and unpublished — strip the "social" affordances
    // (presence, comments) and swap the comments slot for an info notice that
    // tells the author the page isn't published yet. PageHeader / PageActionsMenu
    // independently hide like / watch / bookmark / link-share for the same reason.
    const isDraft = page.status === PageStatusEnum.DRAFT;
    // Offer "make this a portal" when descendants already live under
    // `/path/...` — the page is implicitly a folder, so portalizing lets it
    // index them. Suppressed for drafts, the historical (stale) view, and the
    // user-home page (which can't be renamed).
    const showPortalizeBanner = !isStaleRevision && !isDraft && hasDescendants && !isUserHomePath(page.path);
    const handleEdit = () => {
      router.push(`/_edit?page_id=${encodeURIComponent(page._id)}`);
    };
    // While "reading the previous version" render the local snapshot; the
    // `['page']` cache always holds the latest (never rewound), so the old
    // view is immune to background refetch / mutation invalidation. Gating
    // (stale / draft / presence) stays keyed on the latest `page`, so the
    // WebSocket keeps running the whole time.
    //
    // The `path` match guards SPA navigation: the reset effect runs
    // post-commit, so on X→Y the `path` prop (and cached `page`) flip to Y
    // one render before the effect clears the snapshot. Without this guard
    // page X's old body would flash under page Y for that frame; the guard
    // falls back to Y's `page` until the effect resets the snapshot.
    const displayedPage = isDisplayingOld(bannerState) && snapshot?.page && snapshot.page.path === page.path ? snapshot.page : page;
    return (
      <PageTocColumns toc={toc} activeTocId={activeTocId}>
        <LiveSyncBanner state={bannerState} onReadOld={handleReadOld} onShowLatest={handleShowLatest} onDismiss={handleDismiss} />
        <article className="space-y-12">
          {isStaleRevision && page.revision?._id && <StaleRevisionBanner pagePath={page.path} pageId={page._id} revisionId={page.revision._id} />}
          <PageHeader
            page={displayedPage}
            onEdit={handleEdit}
            showActions={!isStaleRevision}
            showPresence={!isStaleRevision && !isDraft}
            sticky={!isStaleRevision}
            toc={toc}
            activeTocId={activeTocId}
            presence={presence}
          />
          {showPortalizeBanner && (
            <PortalizeBanner page={page} title={m['page.portalize_descendants_title']()} description={m['page.portalize_descendants_body']()} />
          )}
          <PageContent page={displayedPage} />
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
      </PageTocColumns>
    );
  }

  return null;
}
