'use client';

import type { PageWithRevision, PresenceCommentChangedMessage, PresencePageUpdatedMessage, TocEntryResponse } from '@crowi/api-contract';
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
import { apiClient } from '@/lib/api-client';
import { isUserHomePath, pagePathToHref } from '@/lib/page-path';
import { isStalePageRevision } from '@/lib/page-revision';
import { useAuth } from '@/lib/use-auth';
import { usePage } from '@/lib/use-page';
import { usePageChildren } from '@/lib/use-page-children';
import { commentKeys } from '@/lib/use-page-comments';
import { usePageGrantAccent } from '@/lib/use-page-grant-accent';
import { useRevertDeletedPage } from '@/lib/use-page-mutations';
import { usePresence } from '@/lib/use-presence';
import { useMarkSeenOnView } from '@/lib/use-seen';
import { AttachmentList } from './attachment-list';
import { BacklinkList } from './backlink-list';
import { LiveSyncBanner } from './live-sync-banner';
import { initialLiveSyncBannerState, isDisplayingOld, type LiveSyncBannerEvent, reduceLiveSyncBanner } from './live-sync-banner-state';
import { isHeadNewer, isLifecycleChanged, mergePageLevelFields, pageLevelFieldsChanged, pageUserDisplayName } from './live-sync-reconcile';
import { PageContent } from './page-content';
import { PageHeader } from './page-header';
import { useTocScrollSpy } from './page-toc';
import { PageTocColumns } from './page-toc-columns';
import { PortalizeBanner } from './portalize-dialog';
import { RestrictedShareBanner, shouldShowRestrictedShareBanner } from './restricted-share-banner';
import { StaleRevisionBanner } from './stale-revision-banner';

// Debounce window (ms) coalescing a burst of `page-updated` frames into a
// single body swap. Inside 200–500ms per the spec; mirrors the
// notifications-socket invalidate debounce.
const LIVE_SYNC_DEBOUNCE_MS = 300;

// feature-live-page-sync-reconcile — the periodic revalidation backstop
// interval (spec §14, fixed by design — NOT implementer discretion). Bounds
// the staleness of any residual miss (cross-instance pub/sub outage,
// delete/rename's no-frame lifecycle change, ...) that the event-driven
// triggers below cannot otherwise observe.
const RECONCILE_BACKSTOP_MS = 3 * 60 * 1000;

/** The wrapper shape `usePage`'s queryFn stores under `['page', params]`. */
type PageQueryData = { page: PageWithRevision | null; notFound: boolean; notGranted: boolean };

/**
 * Wraps a resolved page into `usePage`'s query-cache shape. `notFound` /
 * `notGranted` are always false here — every call site that uses this
 * already has a genuine page in hand; the 403/404/redirect branches go
 * through `triggerUsePageRevalidate` instead of writing the cache directly.
 */
function toPageQueryData(page: PageWithRevision): PageQueryData {
  return { page, notFound: false, notGranted: false };
}

/**
 * Result of one head-GET reconcile flight (`runReconcileFlight`). Every
 * branch of the spec's decision tree (§2/§3/§4/§5/§8/§9) maps to exactly
 * one of these — `handleShowLatest` inspects it to decide whether the
 * cache actually reached the fetched head before flipping the banner.
 */
type ReconcileOutcome = 'swap' | 'swap-self' | 'page-level-merge' | 'no-op' | 'deferred-old' | 'unauthorized' | 'redirect' | 'failure' | 'discarded';

const RECONCILE_SUCCESS_OUTCOMES: ReadonlySet<ReconcileOutcome> = new Set(['swap', 'swap-self', 'no-op', 'page-level-merge']);

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

  useEffect(() => {
    if (redirectTo) {
      const redirectUrl = `${redirectTo}?redirectFrom=${encodeURIComponent(path)}`;
      router.replace(redirectUrl);
    }
  }, [redirectTo, path, router]);

  // Mirror the page's `grant` onto `<html data-page-grant=...>` so CSS
  // (`--page-grant-accent`) tints the header strip / chip / icons.
  usePageGrantAccent(page?.grant);

  // ── feature-live-page-content-sync / feature-live-page-sync-reconcile —
  // read-side soft-refresh ──────────────────────────────────────────────
  // All swap state is owned here (PageView owns `page` + the query cache).
  // `usePresence` is called exactly once, at PageView level, so a single
  // `/presence` WebSocket is shared with PageHeader / LivePresenceRow via
  // the `presence` prop — opening a second socket here would regress the
  // 2-3s viewer-list lag the header lift originally fixed.
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [bannerState, dispatchBanner] = useReducer(reduceLiveSyncBanner, initialLiveSyncBannerState);
  // Mirrors `bannerState` synchronously (dispatch alone is not enough — a
  // reconcile flight awaits the head-GET and must re-check the CURRENT
  // banner state after that await, not the value closed over when the
  // flight started; see spec §8). Every write to the banner goes through
  // `setBanner` below so this ref and the reducer state never drift apart.
  const bannerStateRef = useRef(initialLiveSyncBannerState);
  const setBanner = (event: LiveSyncBannerEvent): void => {
    bannerStateRef.current = reduceLiveSyncBanner(bannerStateRef.current, event);
    dispatchBanner(event);
  };
  // The pre-swap wrapper, rendered locally while "reading the previous
  // version". Kept in state (not a ref) so it is render-visible; the
  // `['page']` cache is never rewound to it (see spec §view-state).
  const [snapshot, setSnapshot] = useState<PageQueryData | null>(null);
  // Newest revision id / editor seen; also serves as the "latest
  // available" target while displaying an old version.
  const latestSeenRevisionIdRef = useRef<string | null>(null);
  const latestEditorRef = useRef<string | null>(null);
  // Whether the most recently observed update (push frame or reconcile
  // head-GET) was the viewer's own save (another tab/device) — silences
  // the banner (not the swap) for that one update (spec §7).
  const latestIsSelfRef = useRef(false);
  const debounceTimerRef = useRef<number | null>(null);

  // ── reconcile fences / single-flight state (spec §3/§4/§12) ──────────
  // Fence #1 — bumped when this PageView stops displaying the current
  // page (path change or unmount). Any in-flight flight started before the
  // bump is discarded on resolve and NEVER rerun (see the path-change
  // effect below).
  const generationRef = useRef(0);
  // Fence #2 — bumped the instant authority is known to have changed
  // (4403 close, or this flight itself discovering 403/404/redirect).
  // Discards any OTHER in-flight flight's result without rerunning it —
  // some other path has already reached the correct conclusion.
  const authorityEpochRef = useRef(0);
  // Single-flight bookkeeping: at most one head-GET in flight at a time.
  // New triggers arriving while one is in flight set `dirtyRef` instead of
  // starting a second fetch; the in-flight flight discards its own result
  // and reruns once it observes the flag (or a live frame — see
  // `pageUpdatedSeq`) rather than letting the trigger "coalesce" into a
  // fetch that started before the update it was meant to observe.
  const inFlightPromiseRef = useRef<Promise<ReconcileOutcome> | null>(null);
  const dirtyRef = useRef(false);
  // Set for the duration of a `handleShowLatest`-initiated flight (and any
  // flight it coalesces with) so the flight does NOT defer to the
  // read-old guard — the reader explicitly asked to jump to the latest
  // FROM that guarded state (spec §6 bypasses §8 for this one caller).
  const bypassReadOldGuardRef = useRef(false);
  // Fresh-every-render indirection so long-lived subscriptions (the
  // visibilitychange listener / periodic timer below, and `usePresence`'s
  // one-shot `onReconnected` ref-callback) always invoke the CURRENT
  // render's reconcile closure — not a stale one pinned to `selfUserId:
  // null` from the very first render.
  const reconcilePageHeadRef = useRef<(opts?: { bypassReadOldGuard?: boolean }) => Promise<ReconcileOutcome>>(async () => 'no-op');
  const periodicTimerRef = useRef<number | null>(null);

  // The live query key is path-based (live view ⇒ `revision_id` undefined),
  // identical to the one `usePage` registers. Shared so `getQueryData` /
  // `setQueryData` can never drift apart (a mismatch no-ops the swap).
  const pageQueryKey = ['page', { path, revision_id: revisionId }];
  const readWrapper = (): PageQueryData | undefined => queryClient.getQueryData<PageQueryData>(pageQueryKey);

  /**
   * Snapshot the currently-displayed page + write `nextPage` into the live
   * cache, preserving scroll position across the swap (spec §view-state).
   * Shared by both swap paths — `swapToRevision`'s by-id push swap below
   * and `runReconcileFlight`'s head-GET swap — since the snapshot / write /
   * restore-scroll sequence is identical for both; only how the
   * replacement page object is built differs per caller.
   */
  const applySwap = (currentPage: PageWithRevision, nextPage: PageWithRevision): void => {
    // Capture the version currently shown BEFORE writing, so "read the
    // previous version" renders the true pre-swap body.
    setSnapshot(toPageQueryData(currentPage));
    const scrollY = typeof window !== 'undefined' ? window.scrollY : 0;
    queryClient.setQueryData<PageQueryData>(pageQueryKey, toPageQueryData(nextPage));
    // Restore scroll after React commits + the browser paints the new
    // body, so the reader's position is preserved across the swap.
    if (typeof window !== 'undefined') {
      requestAnimationFrame(() => window.scrollTo(0, scrollY));
    }
  };

  /**
   * Fetch the target revision's body and swap it into the cache with a
   * shallow-merge that preserves page-level fields (grant / liker /
   * commentCount / …). Guarded by a `revision.createdAt` monotonicity
   * check so an out-of-order / stale fetch never rewinds the cache.
   * Returns whether the cache was actually advanced.
   *
   * by-id, push-path ONLY — strict `>` compare and the narrow field-set
   * below are deliberate (see `live-sync-reconcile.ts`'s header comment):
   * a push frame's revision id is not guaranteed to be the server's
   * absolute head, unlike a head-GET result.
   */
  const swapToRevision = async (targetRevisionId: string): Promise<boolean> => {
    // Existence check before spending a fetch; the authoritative
    // monotonicity compare happens post-fetch against the *current* cache.
    if (!readWrapper()?.page) return false;

    let fetchedRevision: PageWithRevision['revision'];
    try {
      const response = await apiClient.pages.revisions[':id'].$get({ param: { id: targetRevisionId } });
      if (!response.ok) return false;
      fetchedRevision = (await response.json()).revision;
    } catch {
      // A 404 (revision gone / grant lost — body stays protected) or a
      // transient error: skip the swap, current view is preserved.
      return false;
    }

    // Re-read the cache AFTER the fetch: overlapping page-updated frames can
    // spawn concurrent fetches, and comparing against a pre-fetch snapshot
    // would let a late-resolving older fetch rewind a newer revision a
    // faster one already wrote. Compare against the *current* cache — no
    // await between this read and the setQueryData below, so it is atomic in
    // JS's single thread — and drop the stale result instead. Monotonicity
    // uses `createdAt` (ms), not ObjectId order, so a cross-instance
    // same-second save cannot rewind the cache either.
    const currentPage = readWrapper()?.page;
    if (!currentPage) return false;
    const currentTime = Date.parse(currentPage.revision.createdAt);
    const fetchedTime = Date.parse(fetchedRevision.createdAt);
    if (!(fetchedTime > currentTime)) return false;

    const newPage: PageWithRevision = {
      ...currentPage,
      revision: fetchedRevision,
      latestRevision: fetchedRevision._id,
      // Advance the page metadata too, or the meta chip / header would keep
      // showing the previous revision's editor and timestamp while the body
      // changed under them. `author` is populated by GET /pages/revisions/:id
      // (findRevision `.populate('author')`); fall back to the cached value
      // if it is ever absent.
      lastUpdateUser: fetchedRevision.author ?? currentPage.lastUpdateUser,
      updatedAt: fetchedRevision.createdAt,
    };
    applySwap(currentPage, newPage);
    return true;
  };

  const performForwardSwap = async (): Promise<void> => {
    const target = latestSeenRevisionIdRef.current;
    if (!target) return;
    const editorDisplayName = latestEditorRef.current ?? '';
    const isSelf = latestIsSelfRef.current;
    if (await swapToRevision(target)) {
      // silent swap (spec §7): the reader's own save (another tab/device)
      // still advances the cache, but never announces itself.
      if (!isSelf) {
        setBanner({ type: 'swapped', editorDisplayName });
      }
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

  // Handed to `usePresence`. feature-live-page-sync-reconcile: `usePresence`
  // no longer suppresses the caller's own save — self/other is decided HERE
  // (the only place that knows both `selfUserId` and the read-old banner
  // state at once).
  const handlePageUpdated = (payload: PresencePageUpdatedMessage): void => {
    latestSeenRevisionIdRef.current = payload.revisionId;
    latestEditorRef.current = payload.editorDisplayName;
    latestIsSelfRef.current = payload.editorUserId === presence.selfUserId;
    if (isDisplayingOld(bannerStateRef.current)) {
      // The reader chose the old version — never auto-advance the cache;
      // just escalate the banner to "an even newer version was saved".
      setBanner({ type: 'newer-while-old', editorDisplayName: payload.editorDisplayName });
      return;
    }
    scheduleForwardSwap();
  };

  // feature-live-page-comment-sync — a comment was added / removed on
  // the page by another user. Re-fetch the comment list so it reflects
  // the change in place; the new-comment highlight is derived by
  // PageComments from the resulting query-data diff (spec §highlight), so
  // no id is threaded through here. Deliberately does NOT invalidate
  // ['page'] (unlike `useInvalidateComments`): the header commentCount
  // chip live-update is out of scope, and a comment creates no revision
  // so the page cache is unaffected here regardless.
  const handleCommentChanged = (payload: PresenceCommentChangedMessage): void => {
    void queryClient.invalidateQueries({ queryKey: commentKeys.detail(payload.pageId) });
  };

  // feature-live-page-sync-reconcile — the ONLY action taken directly from
  // the head-GET / grant-revocation authority signals: invalidate `usePage`'s
  // query so its own queryFn (403 → notGranted / 404 → notFound) re-derives
  // the display. No swap logic lives here; the redirect / AccessDenied /
  // NotFound transitions are all driven by `usePage`'s existing branches.
  const triggerUsePageRevalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: pageQueryKey });
  };

  // Bumps fence #2 (spec §12) and triggers the same `usePage` revalidate —
  // shared by every call site that concludes authority has changed (a
  // genuine 403/404/redirect from a reconcile flight, or the 4403
  // access-revoked signal below). Bumping alone never flips the display;
  // only the revalidate's own resolution (via `usePage`'s existing
  // notGranted/notFound branches) does.
  const bumpAuthorityAndRevalidate = (): void => {
    authorityEpochRef.current += 1;
    triggerUsePageRevalidate();
  };

  // feature-live-page-sync-reconcile (spec §10) — fires the instant this
  // socket is closed with 4403, WITHOUT waiting for any in-flight head-GET.
  // Verify-first: bumping `authorityEpochRef` here does not itself flip the
  // display — only a genuine 403 from the triggered revalidation does
  // (handled by `usePage`'s existing notGranted branch once it resolves).
  const handleAccessRevoked = (): void => {
    bumpAuthorityAndRevalidate();
  };

  // feature-live-page-sync-reconcile (spec §11) — the reconnect barrier.
  // Indirected through the ref because `usePresence`'s callback is stored
  // via ref-forwarding too and may be invoked well after this specific
  // render's closures would otherwise go stale.
  const handleReconnected = (): void => {
    void reconcilePageHeadRef.current();
  };

  const presenceEnabled = Boolean(page) && !isStalePageRevision(page) && page?.status !== PageStatusEnum.DRAFT && isAuthenticated;
  const presence = usePresence(presenceEnabled && page ? page._id : null, {
    onPageUpdated: handlePageUpdated,
    onCommentChanged: handleCommentChanged,
    onReconnected: handleReconnected,
    onAccessRevoked: handleAccessRevoked,
  });

  /**
   * One head-GET attempt. NOT single-flight-aware by itself (that's
   * `reconcilePageHead` below) — this is the recursive "discard stale
   * result, refetch" loop (spec §4), so it may issue more than one GET
   * per outer call.
   */
  const runReconcileFlight = async (): Promise<ReconcileOutcome> => {
    const genAtStart = generationRef.current;
    const epochAtStart = authorityEpochRef.current;
    const seqAtStart = presence.pageUpdatedSeq.current;

    let status: number | null = null;
    let fetchedPage: PageWithRevision | null = null;
    try {
      const response = await apiClient.pages.$get({ query: { path, page_id: undefined, revision_id: revisionId } });
      status = response.status;
      // Narrow directly on `response.status` (not the copied `status`
      // local) so `response.json()` resolves to the 200 variant's body —
      // the other status variants don't carry a `page` field.
      if (response.status === 200) {
        const body = await response.json();
        fetchedPage = body.page as PageWithRevision;
      }
    } catch {
      status = null;
    }

    // Fence #1 (generation) / fence #2 (authorityEpoch) — evaluated before
    // ANY write action, and before even inspecting the response further.
    // Both take priority over the frame fence / dirty-rerun logic below:
    // if either changed, this flight's conclusion (whatever it is) is
    // moot — discard-ONLY, never rerun (spec §12).
    if (generationRef.current !== genAtStart) return 'discarded';
    if (authorityEpochRef.current !== epochAtStart) return 'discarded';

    // The frame fence (spec §3/§4): true when a live frame arrived (or
    // another trigger marked dirty) while this GET was in flight, meaning
    // this response's HEAD cannot be trusted — the caller discards it
    // whole and issues a fresh GET immediately. Clears the dirty flag as
    // a side effect (consumed exactly once per rerun).
    const isDirtyOrFrameMoved = (): boolean => {
      if (!dirtyRef.current && presence.pageUpdatedSeq.current === seqAtStart) return false;
      dirtyRef.current = false;
      return true;
    };

    if (status !== 200 && status !== 403 && status !== 404) {
      // Network failure or an unrelated 5xx — silent no-op (spec §9).
      if (isDirtyOrFrameMoved()) return runReconcileFlight();
      return 'failure';
    }

    if (status === 403 || status === 404) {
      // Exempt from the frame fence (spec §2/§9): an access/lifecycle
      // fact, not something a `page-updated` frame could represent.
      bumpAuthorityAndRevalidate();
      return 'unauthorized';
    }

    // status === 200
    const fetched = fetchedPage as PageWithRevision;
    const currentPage = readWrapper()?.page;
    if (!currentPage) return 'discarded';

    if (isLifecycleChanged(currentPage, fetched)) {
      // Exempt from the frame fence (spec §2), checked BEFORE it: a
      // redirect stub / page replacement is a fact independent of any
      // `page-updated` frame, so it must be honored even if a frame
      // happened to arrive mid-flight — unlike the revision-compare/swap
      // decision below, which the frame fence DOES gate.
      bumpAuthorityAndRevalidate();
      return 'redirect';
    }

    // From here on, the frame fence gates ONLY the revision-compare/swap
    // decision (spec §3/§4) — the lifecycle check above is deliberately
    // exempt from it, which is why this check isn't hoisted any earlier.
    if (isDirtyOrFrameMoved()) return runReconcileFlight();

    if (isHeadNewer(currentPage.revision, fetched.revision)) {
      if (!bypassReadOldGuardRef.current && isDisplayingOld(bannerStateRef.current)) {
        // Read-old guard (spec §8), re-checked HERE (post-await), not from
        // a snapshot taken before the fetch — the reader may have clicked
        // "read the previous version" while this GET was in flight.
        latestSeenRevisionIdRef.current = fetched.revision._id;
        latestEditorRef.current = pageUserDisplayName(fetched.lastUpdateUser);
        setBanner({ type: 'newer-while-old', editorDisplayName: latestEditorRef.current });
        return 'deferred-old';
      }

      applySwap(currentPage, fetched);
      const isSelf = fetched.lastUpdateUser?._id != null && fetched.lastUpdateUser._id === presence.selfUserId;
      latestIsSelfRef.current = isSelf;
      if (!isSelf) {
        setBanner({ type: 'swapped', editorDisplayName: pageUserDisplayName(fetched.lastUpdateUser) });
      }
      return isSelf ? 'swap-self' : 'swap';
    }

    if (pageLevelFieldsChanged(currentPage, fetched)) {
      // Grant-only change (spec §5): merge page-level fields only — no
      // snapshot / banner / scroll, the displayed body hasn't moved.
      queryClient.setQueryData<PageQueryData>(pageQueryKey, toPageQueryData(mergePageLevelFields(currentPage, fetched)));
      return 'page-level-merge';
    }

    return 'no-op';
  };

  /**
   * Public, single-flight-aware entry point for every reconcile trigger
   * (tab-revisit / reconnect-barrier / periodic backstop / show-latest).
   * At most one head-GET is ever in flight; a trigger arriving mid-flight
   * marks `dirtyRef` and shares the SAME promise, which only resolves once
   * a flight completes cleanly (or is fenced off) — see `runReconcileFlight`.
   */
  const reconcilePageHead = (opts?: { bypassReadOldGuard?: boolean }): Promise<ReconcileOutcome> => {
    // Unconditional comment invalidate (spec §13) — fires on every trigger,
    // independent of whether this call starts a new GET or just marks the
    // in-flight one dirty, and independent of the eventual head result.
    if (page?._id) {
      void queryClient.invalidateQueries({ queryKey: commentKeys.detail(page._id) });
    }
    if (opts?.bypassReadOldGuard) {
      bypassReadOldGuardRef.current = true;
    }
    if (inFlightPromiseRef.current) {
      dirtyRef.current = true;
      return inFlightPromiseRef.current;
    }
    const flight = runReconcileFlight().finally(() => {
      inFlightPromiseRef.current = null;
      bypassReadOldGuardRef.current = false;
    });
    inFlightPromiseRef.current = flight;
    return flight;
  };

  // Keep the ref-forwarded entry point current every render (see
  // `reconcilePageHeadRef`'s declaration above for why this indirection
  // exists).
  useEffect(() => {
    reconcilePageHeadRef.current = reconcilePageHead;
  });

  const handleReadOld = (): void => setBanner({ type: 'read-old' });
  const handleShowLatest = (): void => {
    void (async () => {
      if (bannerState.kind !== 'showing-latest-again') {
        // `showing-old`'s cache is already the latest (no fetch behind
        // it) — just flip the view.
        setBanner({ type: 'show-latest' });
        return;
      }
      // feature-live-page-sync-reconcile (spec §6): trigger the SAME
      // authoritative reconcile mechanism (head-GET → `applySwap`) instead
      // of an independent by-id fetch off `latestSeenRevisionIdRef`
      // — that ref has no total order across frames and a stale one could
      // point short of the true head. Bypasses the read-old guard: the
      // reader is explicitly asking to leave it.
      const outcome = await reconcilePageHead({ bypassReadOldGuard: true });
      if (RECONCILE_SUCCESS_OUTCOMES.has(outcome)) {
        setBanner({ type: 'show-latest' });
      }
      // Otherwise (redirect / unauthorized / failure / discarded /
      // deferred-old) stay on `showing-latest-again` so the reader can retry.
    })();
  };
  const handleDismiss = (): void => setBanner({ type: 'dismiss' });

  // feature-live-page-sync-reconcile (spec §11/§14) — tab-revisit trigger
  // + the periodic backstop timer, which only runs while the tab is
  // visible. Combined into one `visibilitychange` listener since both care
  // about the same transition.
  useEffect(() => {
    if (!presenceEnabled || typeof document === 'undefined') return;

    const startBackstop = () => {
      if (periodicTimerRef.current !== null) return;
      periodicTimerRef.current = window.setInterval(() => {
        void reconcilePageHeadRef.current();
      }, RECONCILE_BACKSTOP_MS);
    };
    const stopBackstop = () => {
      if (periodicTimerRef.current !== null) {
        window.clearInterval(periodicTimerRef.current);
        periodicTimerRef.current = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void reconcilePageHeadRef.current();
        startBackstop();
      } else {
        stopBackstop();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (document.visibilityState === 'visible') startBackstop();

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stopBackstop();
    };
  }, [presenceEnabled]);

  // SPA navigation swaps the `path` prop WITHOUT remounting PageView, so
  // reset every live-sync view-state or page X's banner / snapshot would
  // bleed into page Y. (`usePresence` self-resets on `pageId` change.) The
  // cleanup also bumps `generationRef` (fence #1) — it runs on BOTH a
  // `path` change and an unmount, which is exactly the "no longer
  // displaying this page" condition a reconcile flight must be discarded
  // against (spec §12).
  useEffect(() => {
    setBanner({ type: 'dismiss' });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSnapshot(null);
    latestSeenRevisionIdRef.current = null;
    latestEditorRef.current = null;
    latestIsSelfRef.current = false;
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    return () => {
      generationRef.current += 1;
    };
  }, [path]);

  // Which revision is actually on screen: normally the latest `page`, but
  // the local snapshot while the reader chose "read the previous version"
  // (the `['page']` cache always holds the latest — never rewound — so the
  // old view is immune to background refetch / mutation invalidation). The
  // `path` match guards SPA navigation: the reset effect runs post-commit,
  // so `path` / cached `page` flip to the new page one render before the
  // snapshot clears; falling back to `page` keeps page X's old body from
  // flashing under page Y. Derived here (before the early returns, so hook
  // order stays stable) so the TOC + its scroll-spy track the *displayed*
  // body — otherwise the right-rail / compact TOC would point at the latest
  // revision's anchors over an older body. Shared with the render block.
  const displayedPage = isDisplayingOld(bannerState) && snapshot?.page && snapshot.page.path === page?.path ? snapshot.page : (page ?? null);
  const toc = displayedPage?.revision?.meta?.toc ?? EMPTY_TOC;
  const activeTocId = useTocScrollSpy(toc);

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
        // One key per click — a repeat is a fresh attempt, not a replay.
        { page_id: page._id, idempotencyKey: crypto.randomUUID().replaceAll('-', '') },
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
    const showRestrictedShareBanner = shouldShowRestrictedShareBanner(page, { isStaleRevision, isDraft });
    const handleEdit = () => {
      router.push(`/_edit?page_id=${encodeURIComponent(page._id)}`);
    };
    // `displayedPage` (computed above the early returns) is the snapshot
    // while reading the previous version, else the latest `page`. The
    // `?? page` only narrows the nullable top-level value to non-null inside
    // this `if (page)` block — it can never actually fall back here.
    const renderedPage = displayedPage ?? page;
    return (
      <PageTocColumns toc={toc} activeTocId={activeTocId}>
        <LiveSyncBanner state={bannerState} onReadOld={handleReadOld} onShowLatest={handleShowLatest} onDismiss={handleDismiss} />
        <article className="space-y-12">
          {isStaleRevision && page.revision?._id && <StaleRevisionBanner pagePath={page.path} pageId={page._id} revisionId={page.revision._id} />}
          <PageHeader
            page={renderedPage}
            onEdit={handleEdit}
            showActions={!isStaleRevision}
            showPresence={!isStaleRevision && !isDraft}
            sticky={!isStaleRevision}
            toc={toc}
            activeTocId={activeTocId}
            presence={presence}
          />
          {showRestrictedShareBanner && <RestrictedShareBanner pageId={page._id} />}
          {showPortalizeBanner && (
            <PortalizeBanner page={page} title={m['page.portalize_descendants_title']()} description={m['page.portalize_descendants_body']()} />
          )}
          <PageContent page={renderedPage} />
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
