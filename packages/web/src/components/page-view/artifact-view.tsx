'use client';

import { ARTIFACT_ESCAPE_MESSAGE_TYPE, ARTIFACT_HEIGHT_MESSAGE_TYPE, type PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { Fullscreen, Maximize2, Minimize2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { env } from '@/lib/runtime-env';
import { useAppInfo } from '@/lib/use-app-info';
import { pageDisplayName } from '@/lib/page-path';
import { ArtifactUrlUnavailableFailure, useMintArtifactUrl } from '@/lib/use-artifact-url';
import { cn } from '@/lib/utils';

interface ArtifactViewProps {
  page: PageWithRevision;
}

/**
 * `unknown` covers both "app info hasn't resolved yet" and "app info failed
 * to load" — both must prevent auto-run (fail-closed: running before
 * `enabled === true` is confirmed would let a brief loading flash mint on a
 * server where delivery is actually disabled). `idle` is only ever the
 * render just before auto-run; a server without delivery reads `disabled`.
 */
type ArtifactRunState = 'unknown' | 'disabled' | 'idle' | 'minting' | 'running' | 'failed';

type ArtifactPhase = Exclude<ArtifactRunState, 'unknown' | 'disabled'>;

type FailureReason = 'delivery-disabled' | 'origin-mismatch' | 'generic';

function normalizeOrigin(origin: string): string | null {
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

/**
 * The placeholder's fixed failure copy for a given reason. `canRetry` is
 * false only for the STATIC origin-mismatch case (a config self-
 * consistency check that fails before any run was ever attempted — see the
 * `configMismatch` call site — there is no "attempt" to retry). Every other
 * case, including a DYNAMIC origin-mismatch discovered after an actual mint
 * response, gets the ordinary "reason + retry" treatment.
 */
function FailureAlert({ reason, canRetry, onRetry }: { reason: FailureReason; canRetry: boolean; onRetry: () => void }) {
  const [title, body] =
    reason === 'delivery-disabled'
      ? [m['page.artifact.delivery_unavailable_title'](), m['page.artifact.delivery_unavailable_body']()]
      : reason === 'origin-mismatch'
        ? [m['page.artifact.origin_mismatch_title'](), m['page.artifact.origin_mismatch_body']()]
        : [m['page.artifact.mint_failed_title'](), m['page.artifact.mint_failed_body']()];
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{body}</p>
        {canRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            {m['page.artifact.retry_button']()}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Past this the frame stops growing and scrolls inside instead. The height
 * comes from code the artifact's author controls, so it needs some bound.
 */
const MAX_ARTIFACT_FRAME_HEIGHT = 100_000;

function isForwardedEscape(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === ARTIFACT_ESCAPE_MESSAGE_TYPE;
}

function readReportedHeight(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null;
  const { type, height } = data as { type?: unknown; height?: unknown };
  if (type !== ARTIFACT_HEIGHT_MESSAGE_TYPE || typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return null;
  return Math.min(Math.ceil(height), MAX_ARTIFACT_FRAME_HEIGHT);
}

/**
 * A running artifact: the outer iframe, the sandbox notice under it, and the
 * maximise control. Inline, the frame is sized to the artifact's content
 * height once the artifact reports it (delivery appends a frame bridge to
 * every served artifact); until then — or if it never does — it keeps a
 * fixed viewport-relative height and the artifact scrolls inside it.
 *
 * Maximising restyles this same block into a viewport-filling overlay
 * instead of moving the iframe into a dialog: moving an iframe reloads it,
 * which would drop whatever the reader did inside the artifact and, once the
 * one-minute signed URL has expired, fail to load at all.
 */
function RunningArtifact({ src, title }: { src: string; title: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // Focus goes back to the control that opened the overlay: on an Escape
  // pressed inside the artifact it would otherwise stay in the frame, and on
  // one pressed on the full screen control it would be dropped when that
  // control unmounts.
  const restoreFromEscape = useCallback(() => {
    setMaximized(false);
    toggleRef.current?.focus();
  }, []);
  // iPhone Safari cannot put an arbitrary element into full screen; there the
  // overlay is as far as it goes.
  const fullscreenAvailable = typeof document !== 'undefined' && document.fullscreenEnabled === true;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // The artifact runs on an opaque origin (its `event.origin` is
      // "null"), so the sender is recognised by window identity instead:
      // the one frame inside `/_artifact-frame`, which this iframe loads.
      const artifactWindow = frameRef.current?.contentWindow?.frames[0];
      if (!artifactWindow || event.source !== artifactWindow) return;
      if (isForwardedEscape(event.data)) {
        if (document.fullscreenElement == null) restoreFromEscape();
        return;
      }
      const reported = readReportedHeight(event.data);
      if (reported !== null) setHeight(reported);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [restoreFromEscape]);

  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement != null && document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!maximized) return;
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = 'hidden';
    // Escape in full screen belongs to the browser, which leaves full screen
    // first; the overlay closes on the next one.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && document.fullscreenElement == null) restoreFromEscape();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      root.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [maximized, restoreFromEscape]);

  const toggleMaximized = () => {
    if (maximized && document.fullscreenElement != null && document.fullscreenElement === containerRef.current) void document.exitFullscreen();
    setMaximized(!maximized);
  };

  const toggleFullscreen = () => {
    if (fullscreen) void document.exitFullscreen();
    // A refused request (the browser's own policy) leaves the overlay as it is.
    else void containerRef.current?.requestFullscreen().catch(() => undefined);
  };

  return (
    <div
      ref={containerRef}
      role={maximized ? 'dialog' : undefined}
      aria-modal={maximized || undefined}
      aria-label={maximized ? title : undefined}
      // `m-0`: the page body spaces its children with margins, and an
      // inherited margin would leave a strip of the page showing.
      className={cn(maximized ? 'fixed inset-0 z-50 m-0 flex flex-col bg-background' : 'space-y-2')}
      data-testid="artifact-running"
    >
      {/* Tab past the last control wraps to the first and back, so focus
          cannot reach the page hidden behind the overlay. The frame's own
          content is cross-origin, so its keystrokes never reach a handler
          here; these stops catch focus as it leaves the frame instead. */}
      {maximized && <span tabIndex={0} data-testid="artifact-focus-start" onFocus={() => frameRef.current?.focus()} />}
      <div className={cn('flex items-center justify-end gap-1', maximized && 'shrink-0 border-b px-4 py-2')}>
        {maximized && <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{title}</h2>}
        {maximized && fullscreenAvailable && (
          <Button variant="ghost" size="sm" onClick={toggleFullscreen} className="text-muted-foreground hover:text-foreground">
            <Fullscreen className="mr-1 h-4 w-4" />
            {fullscreen ? m['page.artifact.exit_fullscreen']() : m['page.artifact.enter_fullscreen']()}
          </Button>
        )}
        <Button ref={toggleRef} variant="ghost" size="sm" onClick={toggleMaximized} className="text-muted-foreground hover:text-foreground">
          {maximized ? <Minimize2 className="mr-1 h-4 w-4" /> : <Maximize2 className="mr-1 h-4 w-4" />}
          {maximized ? m['page.artifact.restore']() : m['page.artifact.maximize']()}
        </Button>
      </div>
      <iframe
        ref={frameRef}
        src={src}
        title={m['page.artifact.iframe_title']()}
        className={cn('w-full', maximized ? 'min-h-0 flex-1' : height === null && 'h-[70vh] min-h-[480px]')}
        style={maximized || height === null ? undefined : { height }}
      />
      <div className={cn('text-sm text-muted-foreground', maximized && 'shrink-0 border-t px-4 py-2')}>
        <p>{m['page.artifact.sandbox_notice_generated']()}</p>
        <p>{m['page.artifact.sandbox_notice_input_note']()}</p>
      </div>
      {maximized && <span tabIndex={0} data-testid="artifact-focus-end" onFocus={() => toggleRef.current?.focus()} />}
    </div>
  );
}

/**
 * The page-body renderer for an HTML artifact Revision. Mints and runs
 * automatically once artifact delivery is confirmed enabled for the
 * displayed revision (see the auto-run effect below) — `PageView` is the
 * only caller, and it chooses this component over `PageContent` purely from
 * the displayed Revision's `contentType`.
 *
 * Renders an OUTER iframe pointed at `/_artifact-frame`, an unsandboxed
 * same-origin document whose own (sandboxed) inner iframe carries the
 * signed artifact URL — see that route's module doc for why the split
 * exists. This component's own iframe carries neither `sandbox` nor
 * `referrerPolicy`: sandboxing it would make it opaque-origin and break the
 * `frame-ancestors` match the inner artifact response requires.
 */
export function ArtifactView({ page }: ArtifactViewProps) {
  const revisionId = page.revision._id;
  const appInfoQuery = useAppInfo();
  const mintMutation = useMintArtifactUrl();

  // Bumped on every mint attempt and revision change — a mint
  // response is only ever applied if the epoch it was issued under is still
  // current. This is strictly stronger than comparing `revisionId`: an A →
  // B → A revision round-trip leaves the revision id unchanged but must
  // still discard a stale in-flight response.
  // Only ever read/written from an effect or an event handler, never during
  // render itself (refs are not safe to touch mid-render). The
  // revision-change bump lives in its own effect (below, ref-only, no
  // `setState`) precisely so it stays out of the render-time state
  // adjustment underneath, which must stay ref-free for the same reason.
  //
  // Known residual ordering gap: the epoch bump below lands in a layout
  // effect, which runs synchronously in the SAME commit as the render-time
  // `phase`/`runningUrl` reset underneath — but only once React actually
  // re-renders this component for the new `revisionId` prop. If a stale
  // mint's microtask resolved in a window BEFORE that re-render is
  // scheduled (rather than after, as it always is for this component's
  // real caller, whose revision swaps commit synchronously with no yield),
  // it would read the not-yet-bumped epoch and escape the fence. A future
  // caller that updates `page` from an async callback with an `await`
  // before the prop change should re-examine this.
  const epochRef = useRef(0);
  // Both are bound once in `MutationObserver`'s constructor, so they stay
  // referentially stable while the object `useMutation` returns does not.
  const resetMint = mintMutation.reset;
  const mintArtifactUrl = mintMutation.mutateAsync;
  useLayoutEffect(() => {
    epochRef.current += 1;
    // Returning to idle must not leave a minted URL/token reachable from
    // TanStack Query's MutationCache. `reset()` detaches this component's
    // observer from the mutation, and paired with `useMintArtifactUrl`'s
    // `gcTime: 0` that makes it eligible for removal from the cache
    // immediately rather than lingering for the default 5-minute gcTime.
    // `resetMint` is `MutationObserver#reset`, bound once in its
    // constructor, so it is referentially stable across renders and this
    // effect only actually fires on a revision change (or mount, where it
    // is a harmless no-op).
    resetMint();
  }, [revisionId, resetMint]);

  const [phase, setPhase] = useState<ArtifactPhase>('idle');
  const [runningUrl, setRunningUrl] = useState<string | null>(null);
  const [failureReason, setFailureReason] = useState<FailureReason>('generic');

  // React's documented "adjust state during render when a prop changes"
  // pattern: comparing the prop against a STATE mirror (never a ref) is the
  // one construct the render phase is allowed to both read AND write,
  // which is what lets this reset land in the SAME commit as the revision
  // change — no separate effect, no stale iframe visible even for one frame.
  const [resetForRevisionId, setResetForRevisionId] = useState(revisionId);
  if (resetForRevisionId !== revisionId) {
    setResetForRevisionId(revisionId);
    setPhase('idle');
    setRunningUrl(null);
  }

  const appInfoData = appInfoQuery.data;
  const enabledKnown = !appInfoQuery.isLoading && !appInfoQuery.isError && appInfoData != null;
  const deliveryEnabled = appInfoData?.artifactDelivery.enabled ?? false;
  const deliveryOrigin = appInfoData?.artifactDelivery.origin ?? null;

  // A purely static self-consistency check between what THIS replica's api
  // reported and what THIS replica's own web env is configured with —
  // independent of any mint call, so a deployment with a mismatched pair
  // never even auto-attempts a run that could only fail. (A different web
  // replica being configured differently is not detectable here — the
  // `/_artifact-frame` route's own `src` check is what closes that gap.)
  const configuredWebOrigin = env('NEXT_PUBLIC_ARTIFACT_ORIGIN') ?? (typeof window !== 'undefined' ? window.location.origin : null);
  const configMismatch =
    enabledKnown &&
    deliveryEnabled &&
    deliveryOrigin !== null &&
    configuredWebOrigin !== null &&
    normalizeOrigin(deliveryOrigin) !== normalizeOrigin(configuredWebOrigin);

  let effectiveState: ArtifactRunState = phase;
  if (!enabledKnown) effectiveState = 'unknown';
  else if (phase === 'idle' && configMismatch) effectiveState = 'failed';
  else if (phase === 'idle' && !deliveryEnabled) effectiveState = 'disabled';
  const effectiveReason: FailureReason = phase === 'failed' ? failureReason : 'origin-mismatch';

  // No `isPending` guard: the synchronous move to `minting` is what stops a
  // second call (the button that could fire it unmounts), and a pending
  // mint from the previous revision must not block this one's.
  const handleRun = useCallback(async () => {
    epochRef.current += 1;
    const epoch = epochRef.current;
    setPhase('minting');
    try {
      const data = await mintArtifactUrl({ pageId: page._id, revisionId });
      if (epochRef.current !== epoch) return;
      const mintedOrigin = normalizeOrigin(data.url);
      if (mintedOrigin === null || mintedOrigin !== deliveryOrigin) {
        // The mutation still holds this URL/token in TanStack's
        // MutationCache even though it's never rendered — discard it the
        // same way the revision-change effect does, rather than leaving it
        // reachable until some later state change happens to reset the
        // mutation.
        resetMint();
        setFailureReason('origin-mismatch');
        setPhase('failed');
        return;
      }
      setRunningUrl(data.url);
      setPhase('running');
    } catch (error) {
      if (epochRef.current !== epoch) return;
      setFailureReason(error instanceof ArtifactUrlUnavailableFailure && error.reason === 'ARTIFACT_DELIVERY_NOT_CONFIGURED' ? 'delivery-disabled' : 'generic');
      setPhase('failed');
    }
  }, [mintArtifactUrl, resetMint, page._id, revisionId, deliveryOrigin]);

  // `idle` is left the moment `handleRun` starts, and only a revision switch
  // returns to it, so this fires once per revision.
  const shouldAutoRun = effectiveState === 'idle';
  useEffect(() => {
    if (shouldAutoRun) {
      // Starting an async mint is the external work this effect exists for;
      // the synchronous `setPhase('minting')` inside is its first step, not
      // state derived from props.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void handleRun();
    }
  }, [shouldAutoRun, handleRun]);

  if (effectiveState === 'running' && runningUrl) {
    return <RunningArtifact key={runningUrl} src={`/_artifact-frame?src=${encodeURIComponent(runningUrl)}`} title={pageDisplayName(page.path) || page.path} />;
  }

  // Loading app info and minting both normally resolve within a few hundred
  // ms, so they get the same bare spinner the page itself uses while
  // loading — an explanatory box here would only flash before the frame
  // replaces it.
  if ((effectiveState === 'unknown' && !appInfoQuery.isError) || effectiveState === 'idle' || effectiveState === 'minting') {
    return <LoadingSpinner message={m['page.artifact.preparing']()} />;
  }

  return (
    <div className="space-y-4 rounded-lg border p-6 text-center">
      <h3 className="font-medium">{m['page.artifact.placeholder_title']()}</h3>
      <p className="text-sm text-muted-foreground">{m['page.artifact.placeholder_body']()}</p>
      {/* Fail-closed: a failed app-info fetch stays in `unknown` and offers
          only a way to check again, never a way to run. */}
      {effectiveState === 'unknown' && (
        <Button variant="outline" size="sm" onClick={() => appInfoQuery.refetch()}>
          {m['page.artifact.retry_button']()}
        </Button>
      )}
      {effectiveState === 'disabled' && (
        <Alert>
          <AlertTitle>{m['page.artifact.delivery_unavailable_title']()}</AlertTitle>
          <AlertDescription>{m['page.artifact.delivery_unavailable_body']()}</AlertDescription>
        </Alert>
      )}
      {effectiveState === 'failed' && <FailureAlert reason={effectiveReason} canRetry={phase === 'failed'} onRetry={handleRun} />}
    </div>
  );
}
